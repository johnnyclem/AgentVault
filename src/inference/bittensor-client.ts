/**
 * Bittensor Client
 *
 * Handles interaction with Bittensor network for AI inference queries.
 * Supports subnet discovery, module queries, and response handling.
 */



export interface BittensorConfig {
  apiEndpoint?: string;
  timeout?: number;
  apiKey?: string;
}

export interface SubnetInfo {
  netuid: number;
  name: string;
  founder: string;
  tempo: number;
  modality: string;
  registered: number;
  last_emit_block: number;
}

export interface ModuleInfo {
  uid: number;
  name: string;
  address: string;
  stake: number;
  dividend: number;
  emission: number;
  incentive: number;
  consensus: number;
  trust: number;
  rank: number;
  validator_permit: boolean;
}

export interface InferenceRequest {
  netuid: number;
  uid?: number;
  inputs: Record<string, any>;
  timeout?: number;
}

export interface InferenceResponse {
  success: boolean;
  data?: Record<string, any>;
  metadata?: {
    uid: number;
    name: string;
    netuid: number;
    responseTime: number;
  };
  error?: string;
}

export class BittensorClient {
  private config: Required<BittensorConfig>;
  private axiosInstance: any = null;

  constructor(config: BittensorConfig = {}) {
    this.config = {
      apiEndpoint: config.apiEndpoint || 'https://api.bittensor.com',
      timeout: config.timeout || 30000,
      apiKey: config.apiKey || '',
    };
  }

  /**
   * Initialize HTTP client (lazy loading)
   */
  private async getClient(): Promise<any> {
    if (!this.axiosInstance) {
      const axios = await this.importAxios();
      this.axiosInstance = axios.create({
        baseURL: this.config.apiEndpoint,
        timeout: this.config.timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'X-API-Key': this.config.apiKey }),
        },
      });
    }
    return this.axiosInstance;
  }

  /**
   * Dynamically import axios (optional dependency)
   */
  private async importAxios(): Promise<any> {
    try {
      const dynamicImport = new Function('modulePath', 'return import(modulePath)') as (
        modulePath: string
      ) => Promise<{ default: any }>;
      const axiosModule = await dynamicImport('axios');
      return axiosModule.default;
    } catch (error) {
      throw new Error(
        'axios is required for BittensorClient. Install with: npm install axios',
      );
    }
  }

  /**
   * Get all subnets
   */
  async getSubnets(): Promise<SubnetInfo[]> {
    try {
      const client = await this.getClient();
      const response = await client.get('/subnets');

      return response.data.subnets || [];
    } catch (error) {
      console.error('Failed to fetch subnets:', error);
      return [];
    }
  }

  /**
   * Get subnet by ID
   */
  async getSubnet(netuid: number): Promise<SubnetInfo | null> {
    try {
      const subnets = await this.getSubnets();
      return subnets.find((s) => s.netuid === netuid) || null;
    } catch (error) {
      console.error(`Failed to fetch subnet ${netuid}:`, error);
      return null;
    }
  }

  /**
   * Get modules for a subnet
   */
  async getModules(netuid: number): Promise<ModuleInfo[]> {
    try {
      const client = await this.getClient();
      const response = await client.get(`/subnets/${netuid}/modules`);

      return response.data.modules || [];
    } catch (error) {
      console.error(`Failed to fetch modules for subnet ${netuid}:`, error);
      return [];
    }
  }

  /**
   * Get module by UID
   */
  async getModule(netuid: number, uid: number): Promise<ModuleInfo | null> {
    try {
      const modules = await this.getModules(netuid);
      return modules.find((m) => m.uid === uid) || null;
    } catch (error) {
      console.error(`Failed to fetch module ${netuid}/${uid}:`, error);
      return null;
    }
  }

  /**
   * Send inference request
   */
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      const response = await client.post(`/subnets/${request.netuid}/infer`, {
        uid: request.uid,
        inputs: request.inputs,
        timeout: request.timeout || this.config.timeout,
      });

      const responseTime = Date.now() - startTime;

      if (response.data.success) {
        return {
          success: true,
          data: response.data.output,
          metadata: {
            uid: response.data.uid,
            name: response.data.name,
            netuid: request.netuid,
            responseTime,
          },
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'Inference failed',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Find best module for a subnet
   */
  async findBestModule(
    netuid: number,
    criteria: 'stake' | 'trust' | 'rank' | 'consensus' = 'rank',
  ): Promise<ModuleInfo | null> {
    try {
      const modules = await this.getModules(netuid);
      if (modules.length === 0) {
        return null;
      }

      return modules
        .sort((a, b) => b[criteria] - a[criteria])
        .slice(0, 1)[0] || null;
    } catch (error) {
      console.error('Failed to find best module:', error);
      return null;
    }
  }

  /**
   * Batch inference to multiple modules
   */
  async batchInfer(
    request: InferenceRequest,
    limit: number = 5,
  ): Promise<InferenceResponse[]> {
    try {
      const modules = await this.getModules(request.netuid);
      const topModules = modules
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit);

      const promises = topModules.map((module) =>
        this.infer({ ...request, uid: module.uid }),
      );

      return Promise.all(promises);
    } catch (error) {
      console.error('Failed to batch infer:', error);
      return [];
    }
  }

  /**
   * Health check for subnet
   */
  async checkSubnetHealth(netuid: number): Promise<{
    healthy: boolean;
    moduleCount: number;
    avgResponseTime: number;
  }> {
    const startTime = Date.now();

    try {
      const modules = await this.getModules(netuid);
      if (modules.length === 0) {
        return {
          healthy: false,
          moduleCount: 0,
          avgResponseTime: 0,
        };
      }

      const responseTime = Date.now() - startTime;

      return {
        healthy: true,
        moduleCount: modules.length,
        avgResponseTime: responseTime,
      };
    } catch (error) {
      return {
        healthy: false,
        moduleCount: 0,
        avgResponseTime: 0,
      };
    }
  }

  /**
   * Get API status
   */
  async getApiStatus(): Promise<{ online: boolean; version?: string; error?: string }> {
    try {
      const client = await this.getClient();
      const response = await client.get('/status');

      return {
        online: response.data.online || false,
        version: response.data.version,
      };
    } catch (error) {
      return {
        online: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
