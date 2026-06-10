/**
 * Secret Injector – Safe secret delivery to agent execution contexts
 *
 * Provides multiple injection methods that avoid common leakage vectors:
 *
 * 1. **memory-fd**: Writes secret to a pipe/fd that the child reads once.
 *    The fd is closed immediately after reading.  Not visible in `ps`.
 *
 * 2. **tmpfs-file**: Writes secret to a file on tmpfs (RAM-backed filesystem).
 *    The file is mode 0600, unlinked after the agent reads it.
 *
 * 3. **env-scoped**: Sets an environment variable only in the child's env map
 *    (NOT in the parent process.env).  This is safer than global env but still
 *    visible via /proc/<pid>/environ on Linux.
 *
 * 4. **callback**: Returns the secret via a callback function reference.  The
 *    agent code calls the function to retrieve the value.  No filesystem or env
 *    involvement.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { SecretInjectionConfig, InjectedSecret, InjectionMethod } from './safehouse-types.js';

export class SecretInjector {
  private readonly config: SecretInjectionConfig;
  private readonly injections = new Map<string, InjectedSecret>();

  /** For callback method: stores secret values keyed by a random token */
  private readonly callbackStore = new Map<string, string>();

  /** Track cleanup timers */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(config?: Partial<SecretInjectionConfig>) {
    this.config = {
      method: config?.method ?? 'env-scoped',
      tmpfsPath: config?.tmpfsPath,
      envPrefix: config?.envPrefix ?? 'AV_SECRET_',
      autoCleanup: config?.autoCleanup ?? true,
      maxLifetimeMs: config?.maxLifetimeMs ?? 300_000, // 5 minutes
    };
  }

  // -----------------------------------------------------------------------
  // Injection
  // -----------------------------------------------------------------------

  /**
   * Inject a secret and return a reference the agent can use to retrieve it.
   */
  async inject(key: string, value: string, method?: InjectionMethod): Promise<InjectedSecret> {
    const m = method ?? this.config.method;

    switch (m) {
      case 'tmpfs-file':
        return this.injectViaTmpfs(key, value);
      case 'env-scoped':
        return this.injectViaEnvScoped(key, value);
      case 'callback':
        return this.injectViaCallback(key, value);
      case 'memory-fd':
      default:
        return this.injectViaMemoryFd(key, value);
    }
  }

  /**
   * Build an environment map for a child process containing all injected secrets.
   * Only includes secrets injected via the `env-scoped` method.
   */
  buildChildEnv(baseEnv?: NodeJS.ProcessEnv): Record<string, string> {
    const env: Record<string, string> = {};

    // Copy base env (without inheriting parent's secrets)
    if (baseEnv) {
      for (const [k, v] of Object.entries(baseEnv)) {
        if (v !== undefined) env[k] = v;
      }
    }

    // Add injected env-scoped secrets
    for (const [, injection] of this.injections) {
      if (injection.method === 'env-scoped') {
        const value = this.callbackStore.get(injection.reference);
        if (value) {
          env[injection.reference] = value;
        }
      }
    }

    return env;
  }

  /**
   * Retrieve a callback-injected secret by its token.
   * This is the function the agent calls to get the value.
   */
  retrieveCallback(token: string): string | null {
    const value = this.callbackStore.get(token);
    if (!value) return null;

    // One-time read: remove after retrieval
    this.callbackStore.delete(token);
    return value;
  }

  /**
   * Get all active injections.
   */
  listInjections(): InjectedSecret[] {
    return [...this.injections.values()].map(i => ({
      ...i,
      cleanup: i.cleanup, // preserve the cleanup function
    }));
  }

  /**
   * Clean up a specific injection.
   */
  async cleanup(key: string): Promise<void> {
    const injection = this.injections.get(key);
    if (injection) {
      await injection.cleanup();
      this.injections.delete(key);
    }

    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  /**
   * Clean up all injections.
   */
  async dispose(): Promise<void> {
    for (const [key, injection] of this.injections) {
      try {
        await injection.cleanup();
      } catch {
        // Best-effort cleanup
      }
      this.injections.delete(key);
    }

    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    this.callbackStore.clear();
  }

  // -----------------------------------------------------------------------
  // Injection methods
  // -----------------------------------------------------------------------

  private async injectViaMemoryFd(key: string, value: string): Promise<InjectedSecret> {
    // Use a temporary file on tmpfs that's immediately unlinked
    const tmpDir = this.resolveTmpfs();
    const filePath = path.join(tmpDir, `av_secret_${crypto.randomBytes(8).toString('hex')}`);

    fs.writeFileSync(filePath, value, { mode: 0o600 });
    const fd = fs.openSync(filePath, 'r');

    // Unlink immediately – the fd remains valid until closed
    try {
      fs.unlinkSync(filePath);
    } catch {
      // On some systems, unlink while open is not supported
    }

    const injection = this.createInjection(key, 'memory-fd', `fd:${fd}`, async () => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    });

    return injection;
  }

  private async injectViaTmpfs(key: string, value: string): Promise<InjectedSecret> {
    const tmpDir = this.resolveTmpfs();
    const fileName = `av_secret_${crypto.randomBytes(8).toString('hex')}`;
    const filePath = path.join(tmpDir, fileName);

    fs.writeFileSync(filePath, value, { mode: 0o600 });

    const injection = this.createInjection(key, 'tmpfs-file', filePath, async () => {
      try {
        // Overwrite with zeros before unlinking
        const size = fs.statSync(filePath).size;
        fs.writeFileSync(filePath, Buffer.alloc(size, 0));
        fs.unlinkSync(filePath);
      } catch {
        // File may already be cleaned up
      }
    });

    return injection;
  }

  private async injectViaEnvScoped(key: string, value: string): Promise<InjectedSecret> {
    const envName = `${this.config.envPrefix}${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

    // Store in callback store (NOT in process.env)
    this.callbackStore.set(envName, value);

    const injection = this.createInjection(key, 'env-scoped', envName, async () => {
      this.callbackStore.delete(envName);
    });

    return injection;
  }

  private async injectViaCallback(key: string, value: string): Promise<InjectedSecret> {
    const token = `cb_${crypto.randomBytes(16).toString('hex')}`;
    this.callbackStore.set(token, value);

    const injection = this.createInjection(key, 'callback', token, async () => {
      this.callbackStore.delete(token);
    });

    return injection;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private createInjection(
    key: string,
    method: InjectionMethod,
    reference: string,
    cleanupFn: () => Promise<void>,
  ): InjectedSecret {
    const now = new Date();
    const expiresAt = this.config.maxLifetimeMs
      ? new Date(now.getTime() + this.config.maxLifetimeMs).toISOString()
      : null;

    const injection: InjectedSecret = {
      key,
      method,
      reference,
      injectedAt: now.toISOString(),
      expiresAt,
      cleanup: cleanupFn,
    };

    this.injections.set(key, injection);

    // Schedule auto-cleanup
    if (this.config.autoCleanup && this.config.maxLifetimeMs) {
      const timer = setTimeout(async () => {
        await this.cleanup(key);
      }, this.config.maxLifetimeMs);
      if (timer.unref) timer.unref();
      this.timers.set(key, timer);
    }

    return injection;
  }

  private resolveTmpfs(): string {
    if (this.config.tmpfsPath) return this.config.tmpfsPath;

    // Prefer /dev/shm (Linux tmpfs) if available
    if (process.platform === 'linux' && fs.existsSync('/dev/shm')) {
      return '/dev/shm';
    }

    // Fall back to OS temp directory
    return os.tmpdir();
  }
}
