/**
 * Local Model Client
 *
 * Provides a last-resort inference fallback using a locally running model
 * server (Ollama API-compatible at http://localhost:11434 by default).
 *
 * No API keys are required — this runs fully offline.  Cost is reported as
 * zero USD since there is no external billing.
 */

import { fetchWithTimeout, sanitizeForLog } from './venice-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LocalModelConfig {
  /** Base URL of the local model server (default: http://localhost:11434). */
  baseUrl?: string;
  /** Default model tag to use (default: 'llama3'). */
  defaultModel?: string;
  /** Request timeout in milliseconds (default: 60 000). */
  timeout?: number;
}

export interface LocalModelRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface LocalModelResponse {
  success: boolean;
  text?: string;
  model?: string;
  provider: 'local';
  /** Always 0 — no external billing for local inference. */
  cost: number;
  responseTime: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// LocalModelClient
// ---------------------------------------------------------------------------

/**
 * Ollama-compatible local inference client.
 *
 * Uses the `/api/chat` endpoint (Ollama ≥ 0.1.x) with a streaming=false body
 * so the response arrives as a single JSON object.
 */
export class LocalModelClient {
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeout: number;

  constructor(config: LocalModelConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
    this.defaultModel = config.defaultModel ?? 'llama3';
    this.timeout = config.timeout ?? 60_000;
  }

  /** Attempt to generate a response from the local model server. */
  async generate(request: LocalModelRequest): Promise<LocalModelResponse> {
    const startTime = Date.now();
    const model = request.model ?? this.defaultModel;

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body = {
        model,
        messages,
        stream: false,
        options: {
          num_predict: request.maxTokens ?? 1024,
          temperature: request.temperature ?? 0.7,
        },
      };

      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        this.timeout,
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          success: false,
          provider: 'local',
          cost: 0,
          responseTime: Date.now() - startTime,
          error: `Local model HTTP ${res.status}: ${sanitizeForLog(errText)}`,
        };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const text: string =
        (data['message'] as Record<string, string> | undefined)?.['content'] ??
        (data['response'] as string | undefined) ??
        '';

      return {
        success: true,
        text,
        model: (data['model'] as string | undefined) ?? model,
        provider: 'local',
        cost: 0,
        responseTime: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'local',
        cost: 0,
        responseTime: Date.now() - startTime,
        error: sanitizeForLog(err instanceof Error ? err.message : 'Unknown error'),
      };
    }
  }

  /**
   * Returns true if the local model server is reachable and has at least one
   * model loaded.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        3_000,
      );
      if (!res.ok) return false;
      const data = (await res.json()) as Record<string, unknown>;
      const models = data['models'] as unknown[] | undefined;
      return Array.isArray(models) && models.length > 0;
    } catch {
      return false;
    }
  }

  /** List models available on the local server. */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/tags`,
        {},
        3_000,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as Record<string, unknown>;
      const models = data['models'] as Array<Record<string, string>> | undefined;
      return (models ?? []).map((m) => m['name'] ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }
}
