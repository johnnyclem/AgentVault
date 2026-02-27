/**
 * Venice AI Client
 *
 * Provides inference via Venice AI – a privacy-focused, OpenAI-compatible
 * inference platform. Used as the first fallback when Bittensor is unreachable.
 *
 * API reference: https://docs.venice.ai
 */

export interface VeniceConfig {
  /** Venice AI API key (VENICE_API_KEY env var as fallback) */
  apiKey?: string;
  /** Base URL – defaults to the Venice AI inference endpoint */
  baseUrl?: string;
  /** Model to use – defaults to 'llama-3.3-70b' */
  model?: string;
  /** Request timeout in ms – defaults to 30 000 */
  timeout?: number;
}

export interface VeniceInferenceRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface VeniceInferenceResponse {
  success: boolean;
  text?: string;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Estimated cost in USD (based on public token pricing) */
  estimatedCostUsd?: number;
  responseTime?: number;
  error?: string;
}

/** Approximate Venice AI pricing per 1 M tokens (USD) as of early 2026 */
const VENICE_PRICE_PER_1M_TOKENS_USD = 0.9;

export class VeniceAIClient {
  private config: Required<VeniceConfig>;

  constructor(config: VeniceConfig = {}) {
    this.config = {
      apiKey: config.apiKey ?? process.env['VENICE_API_KEY'] ?? '',
      baseUrl: config.baseUrl ?? 'https://api.venice.ai/api/v1',
      model: config.model ?? 'llama-3.3-70b',
      timeout: config.timeout ?? 30_000,
    };
  }

  /**
   * Send an inference request to Venice AI.
   * Uses the OpenAI-compatible chat completions endpoint.
   */
  async infer(request: VeniceInferenceRequest): Promise<VeniceInferenceResponse> {
    if (!this.config.apiKey) {
      return {
        success: false,
        error: 'Venice AI API key not configured (set VENICE_API_KEY)',
      };
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
      }
      messages.push({ role: 'user', content: request.prompt });

      const body = JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.7,
      });

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        return { success: false, error: `Venice AI error ${response.status}: ${errText}` };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices?.[0]?.message?.content ?? '';
      const usage = data.usage;
      const totalTokens = usage?.total_tokens ?? 0;
      const estimatedCostUsd = (totalTokens / 1_000_000) * VENICE_PRICE_PER_1M_TOKENS_USD;

      return {
        success: true,
        text,
        model: data.model ?? this.config.model,
        usage: usage
          ? {
              promptTokens: usage.prompt_tokens,
              completionTokens: usage.completion_tokens,
              totalTokens: usage.total_tokens,
            }
          : undefined,
        estimatedCostUsd,
        responseTime,
      };
    } catch (error) {
      clearTimeout(timer);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown Venice AI error',
      };
    }
  }

  /**
   * Quick connectivity check – returns true if Venice AI responds.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config.apiKey) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}
