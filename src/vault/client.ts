/**
 * Secret manager client for agent secret management
 *
 * Supports HashiCorp Vault and Bitwarden CLI backends while preserving
 * a per-agent secret namespace.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  VaultConfig,
  AgentVaultPolicy,
  VaultSecret,
  VaultSecretMetadata,
  VaultOperationResult,
  VaultHealthStatus,
  VaultSecretListEntry,
  AgentVaultInitOptions,
} from './types.js';
import {
  loadVaultConfig,
  getOrCreateAgentPolicy,
  validateVaultConfig,
} from './config.js';

const execFileAsync = promisify(execFile);

interface VaultAPIResponse {
  data?: {
    data?: Record<string, string>;
    metadata?: {
      version: number;
      created_time: string;
      custom_metadata?: Record<string, string> | null;
      destroyed: boolean;
    };
    keys?: string[];
  };
  auth?: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
  };
  errors?: string[];
}

export class VaultClient {
  private config: VaultConfig;
  private policy: AgentVaultPolicy;
  private clientToken: string | null = null;

  constructor(config: VaultConfig, policy: AgentVaultPolicy) {
    this.config = { ...config, backend: config.backend ?? 'hashicorp' };
    this.policy = policy;
  }

  static create(agentId: string, options?: AgentVaultInitOptions): VaultClient {
    const config = loadVaultConfig();
    if (!config) {
      throw new Error(
        'Vault is not configured. Set VAULT_ADDR and VAULT_TOKEN environment variables, ' +
        'or run `agentvault vault init` to configure.'
      );
    }

    const errors = validateVaultConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid Vault configuration: ${errors.join(', ')}`);
    }

    const policy = getOrCreateAgentPolicy(
      agentId,
      options?.engine ?? 'kv-v2',
    );

    if (options?.maxSecrets) {
      policy.maxSecrets = options.maxSecrets;
    }
    if (options?.allowedKeyPatterns) {
      policy.allowedKeyPatterns = options.allowedKeyPatterns;
    }

    return new VaultClient(config, policy);
  }

  static createWithConfig(config: VaultConfig, policy: AgentVaultPolicy): VaultClient {
    return new VaultClient(config, policy);
  }

  private get backend(): 'hashicorp' | 'bitwarden' {
    return this.config.backend ?? 'hashicorp';
  }

  private async runBitwarden(args: string[]): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync('bw', args, {
        env: process.env,
      });

      if (stderr && stderr.trim().length > 0 && !stdout) {
        throw new Error(stderr.trim());
      }

      return stdout.trim();
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Bitwarden CLI failed: ${error.message}`);
      }
      throw new Error('Bitwarden CLI failed with unknown error');
    }
  }

  private async getToken(): Promise<string> {
    if (this.clientToken) {
      return this.clientToken;
    }

    switch (this.config.authMethod) {
      case 'token':
        if (!this.config.token) {
          throw new Error('Vault token not configured');
        }
        this.clientToken = this.config.token;
        return this.clientToken;
      case 'approle':
        return this.authenticateAppRole();
      case 'userpass':
        return this.authenticateUserPass();
      case 'kubernetes':
        return this.authenticateKubernetes();
      default:
        throw new Error(`Unsupported auth method: ${this.config.authMethod}`);
    }
  }

  private async authenticateAppRole(): Promise<string> {
    const response = await this.rawRequest('POST', '/v1/auth/approle/login', {
      role_id: this.config.roleId,
      secret_id: this.config.secretId,
    });

    if (!response.auth?.client_token) {
      throw new Error('AppRole authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  private async authenticateUserPass(): Promise<string> {
    const response = await this.rawRequest(
      'POST',
      `/v1/auth/userpass/login/${this.config.username}`,
      { password: this.config.password },
    );

    if (!response.auth?.client_token) {
      throw new Error('Userpass authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  private async authenticateKubernetes(): Promise<string> {
    const fs = await import('node:fs');
    const jwtPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

    let jwt: string;
    try {
      jwt = fs.readFileSync(jwtPath, 'utf-8').trim();
    } catch {
      throw new Error(`Cannot read Kubernetes service account token from ${jwtPath}`);
    }

    const response = await this.rawRequest('POST', '/v1/auth/kubernetes/login', {
      role: this.config.k8sRole,
      jwt,
    });

    if (!response.auth?.client_token) {
      throw new Error('Kubernetes authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  private async rawRequest(
    method: string,
    apiPath: string,
    body?: Record<string, unknown>,
  ): Promise<VaultAPIResponse> {
    const url = `${this.config.address}${apiPath}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.clientToken || this.config.token) {
      headers['X-Vault-Token'] = this.clientToken || this.config.token!;
    }

    if (this.config.namespace) {
      headers['X-Vault-Namespace'] = this.config.namespace;
    }

    const controller = new AbortController();
    const timeout = this.config.timeoutMs ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);

      if (response.status === 204) {
        return {};
      }

      const data = await response.json() as VaultAPIResponse;

      if (!response.ok) {
        const errors = data.errors?.join(', ') ?? `HTTP ${response.status}`;
        throw new Error(`Vault API error: ${errors}`);
      }

      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request(
    method: string,
    apiPath: string,
    body?: Record<string, unknown>,
  ): Promise<VaultAPIResponse> {
    await this.getToken();
    return this.rawRequest(method, apiPath, body);
  }

  private buildSecretPath(key: string, action: 'data' | 'metadata' = 'data'): string {
    const engine = this.policy.engine === 'kv-v1' ? '' : action;
    const basePath = this.policy.secretPath;

    if (this.policy.engine === 'kv-v1') {
      return `/v1/${basePath}/${key}`;
    }

    const parts = basePath.split('/');
    const mount = parts[0];
    const secretSubPath = parts.slice(1).join('/');

    return `/v1/${mount}/${engine}/${secretSubPath}/${key}`;
  }

  private buildListPath(): string {
    const basePath = this.policy.secretPath;

    if (this.policy.engine === 'kv-v1') {
      return `/v1/${basePath}`;
    }

    const parts = basePath.split('/');
    const mount = parts[0];
    const secretSubPath = parts.slice(1).join('/');

    return `/v1/${mount}/metadata/${secretSubPath}`;
  }

  private validateKey(key: string): string | null {
    if (!key || key.trim().length === 0) {
      return 'Secret key cannot be empty';
    }

    if (key.includes('..') || key.startsWith('/')) {
      return 'Secret key cannot contain path traversal sequences';
    }

    if (this.policy.allowedKeyPatterns && this.policy.allowedKeyPatterns.length > 0) {
      const matches = this.policy.allowedKeyPatterns.some(pattern => {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        return regex.test(key);
      });

      if (!matches) {
        return `Secret key "${key}" does not match allowed patterns: ${this.policy.allowedKeyPatterns.join(', ')}`;
      }
    }

    return null;
  }

  get agentId(): string {
    return this.policy.agentId;
  }

  get secretPath(): string {
    return this.policy.secretPath;
  }

  async health(): Promise<VaultOperationResult<VaultHealthStatus>> {
    if (this.backend === 'bitwarden') {
      try {
        await this.runBitwarden(['--version']);
        return {
          success: true,
          data: {
            initialized: true,
            sealed: false,
            version: 'bitwarden-cli',
            clusterName: 'bitwarden',
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          success: false,
          error: `Failed to check Bitwarden CLI health: ${message}`,
        };
      }
    }

    try {
      const response = await fetch(`${this.config.address}/v1/sys/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });

      const data = await response.json() as {
        initialized: boolean;
        sealed: boolean;
        version: string;
        cluster_name?: string;
      };

      return {
        success: true,
        data: {
          initialized: data.initialized,
          sealed: data.sealed,
          version: data.version,
          clusterName: data.cluster_name,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to check Vault health: ${message}`,
      };
    }
  }

  async getSecret(key: string): Promise<VaultOperationResult<VaultSecret>> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    if (this.backend === 'bitwarden') {
      try {
        const itemName = `agentvault/${this.policy.agentId}/${key}`;
        const output = await this.runBitwarden(['get', 'item', itemName, '--raw']);

        const secret: VaultSecret = {
          key,
          value: output,
          metadata: {
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            destroyed: false,
          },
        };

        return { success: true, data: secret };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: `Failed to get secret "${key}": ${message}` };
      }
    }

    try {
      const apiPath = this.buildSecretPath(key);
      const response = await this.request('GET', apiPath);

      if (!response.data) {
        return { success: false, error: `Secret "${key}" not found` };
      }

      const secretData = response.data.data ?? {};
      const metadata = response.data.metadata;

      const secret: VaultSecret = {
        key,
        value: secretData,
        metadata: {
          version: metadata?.version ?? 1,
          createdAt: metadata?.created_time ?? new Date().toISOString(),
          updatedAt: metadata?.created_time ?? new Date().toISOString(),
          destroyed: metadata?.destroyed ?? false,
          customMetadata: metadata?.custom_metadata ?? undefined,
        },
      };

      return { success: true, data: secret };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to get secret "${key}": ${message}` };
    }
  }

  async putSecret(
    key: string,
    value: string | Record<string, string>,
    metadata?: Record<string, string>,
  ): Promise<VaultOperationResult<VaultSecretMetadata>> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    if (!this.policy.allowCreate && !this.policy.allowUpdate) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to write secrets`,
      };
    }

    if (this.backend === 'bitwarden') {
      try {
        if (typeof value !== 'string') {
          return {
            success: false,
            error: 'Bitwarden backend currently supports string secret values only',
          };
        }

        const itemName = `agentvault/${this.policy.agentId}/${key}`;
        await this.runBitwarden(['create', 'item', itemName, '--notes', value]);

        return {
          success: true,
          data: {
            version: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            destroyed: false,
            customMetadata: metadata,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: `Failed to put secret "${key}": ${message}` };
      }
    }

    try {
      const data = typeof value === 'string'
        ? { value }
        : value;

      const body: Record<string, unknown> = { data };

      if (metadata && this.policy.engine === 'kv-v2') {
        body.options = { cas: 0 };
      }

      const apiPath = this.buildSecretPath(key);
      const response = await this.request('POST', apiPath, body);

      const resultMetadata: VaultSecretMetadata = {
        version: response.data?.metadata?.version ?? 1,
        createdAt: response.data?.metadata?.created_time ?? new Date().toISOString(),
        updatedAt: response.data?.metadata?.created_time ?? new Date().toISOString(),
        destroyed: false,
        customMetadata: metadata,
      };

      if (metadata && this.policy.engine === 'kv-v2') {
        try {
          const metadataPath = this.buildSecretPath(key, 'metadata');
          await this.request('POST', metadataPath, {
            custom_metadata: metadata,
          });
        } catch {
          // ignore metadata failures
        }
      }

      return { success: true, data: resultMetadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to put secret "${key}": ${message}` };
    }
  }

  async deleteSecret(key: string): Promise<VaultOperationResult> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    if (!this.policy.allowDelete) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to delete secrets`,
      };
    }

    if (this.backend === 'bitwarden') {
      try {
        const itemName = `agentvault/${this.policy.agentId}/${key}`;
        await this.runBitwarden(['delete', 'item', itemName]);
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: `Failed to delete secret "${key}": ${message}` };
      }
    }

    try {
      const apiPath = this.buildSecretPath(key);
      await this.request('DELETE', apiPath);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to delete secret "${key}": ${message}` };
    }
  }

  async listSecrets(): Promise<VaultOperationResult<VaultSecretListEntry[]>> {
    if (!this.policy.allowList) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to list secrets`,
      };
    }

    if (this.backend === 'bitwarden') {
      return {
        success: false,
        error: 'Bitwarden backend does not support listing by agent prefix yet',
      };
    }

    try {
      const apiPath = this.buildListPath();
      const response = await this.request('LIST', apiPath);

      const keys = response.data?.keys ?? [];
      const entries: VaultSecretListEntry[] = keys.map(key => ({
        key,
        version: 0,
        createdAt: '',
        updatedAt: '',
      }));

      return { success: true, data: entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      if (message.includes('404') || message.includes('not found')) {
        return { success: true, data: [] };
      }

      return { success: false, error: `Failed to list secrets: ${message}` };
    }
  }

  async secretExists(key: string): Promise<boolean> {
    const result = await this.getSecret(key);
    return result.success && !!result.data;
  }

  getPolicy(): AgentVaultPolicy {
    return { ...this.policy };
  }
}
