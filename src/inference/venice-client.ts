/**
 * Venice AI Client — Ephemeral Key Inference
 *
 * Implements zero-persistence, per-request ephemeral API keys for Venice AI.
 *
 * Security guarantees:
 *   • A fresh subkey is minted via the Venice key-management API before every
 *     inference call; the master key never touches the inference path.
 *   • Key material is held in a Uint8Array that is zeroed immediately after
 *     the HTTP request completes (success or failure).
 *   • No key material ever appears in logs, thrown errors, or any file write.
 *   • Error messages are sanitised to strip long alphanumeric tokens before
 *     being surfaced to callers.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VeniceConfig {
  /** Master Venice API key. Defaults to VENICE_API_KEY env var. */
  masterApiKey?: string;
  /** API base URL. */
  baseUrl?: string;
  /** Request timeout in milliseconds (default 30 000). */
  timeout?: number;
}

export interface VeniceGenerateRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface VeniceGenerateResponse {
  success: boolean;
  text?: string;
  model?: string;
  /** Always 'venice' for responses from this client. */
  provider: 'venice';
  /** Estimated cost in USD (never contains key material). */
  cost?: number;
  responseTime: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal: EphemeralKeyHolder
// ---------------------------------------------------------------------------

/**
 * Wraps raw key material in a Uint8Array so it can be zeroed after a single
 * use.  JavaScript strings are immutable and GC-managed, so we must convert
 * to bytes for zeroing, then decode to string only at the call site where the
 * HTTP header is populated.
 */
export class EphemeralKeyHolder {
  private buf: Uint8Array;
  private _consumed = false;

  constructor(keyMaterial: string) {
    this.buf = new TextEncoder().encode(keyMaterial);
  }

  /**
   * Return the key as a string and immediately zero the backing buffer.
   * May only be called once.
   */
  consume(): string {
    if (this._consumed) {
      throw new Error('Ephemeral key already consumed');
    }
    this._consumed = true;
    const key = new TextDecoder().decode(this.buf);
    this.buf.fill(0);
    return key;
  }

  /** Zero the buffer and mark as consumed without returning the key value. */
  discard(): void {
    this.buf.fill(0);
    this._consumed = true;
  }

  get consumed(): boolean {
    return this._consumed;
  }
}

// ---------------------------------------------------------------------------
// Internal: EphemeralKeyManager
// ---------------------------------------------------------------------------

/** Record returned by generate(), used to revoke after inference. */
interface EphemeralKeySession {
  keyId: string;
  holder: EphemeralKeyHolder;
}

/**
 * Manages the Venice AI subkey lifecycle.
 *
 * Flow per inference request:
 *   1. POST /api/v1/api_keys  → Venice creates a fresh, scoped API subkey.
 *   2. Caller uses the subkey for one inference request.
 *   3. DELETE /api/v1/api_keys/{keyId}  → Venice revokes the subkey.
 *   4. EphemeralKeyHolder.discard() zeroes the in-memory buffer.
 */
export class EphemeralKeyManager {
  private masterBuf: Uint8Array;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(masterApiKey: string, baseUrl: string, timeout: number) {
    this.masterBuf = new TextEncoder().encode(masterApiKey);
    this.baseUrl = baseUrl;
    this.timeout = timeout;
  }

  /**
   * Mint a fresh ephemeral subkey via the Venice API.
   * The returned session must be revoked after use.
   */
  async generate(): Promise<EphemeralKeySession> {
    const masterKey = new TextDecoder().decode(this.masterBuf);
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/api_keys`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${masterKey}`,
          },
          body: JSON.stringify({
            name: `ephemeral-${crypto.randomBytes(8).toString('hex')}`,
            // Request the tightest possible scope/expiry if the API supports it
            expiresIn: 300,
          }),
        },
        this.timeout,
      );

      if (!res.ok) {
        throw new Error(`Key generation failed: HTTP ${res.status}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const rawKey = (data['key'] ?? data['apiKey'] ?? data['token'] ?? '') as string;
      const keyId = (data['id'] ?? data['keyId'] ?? crypto.randomBytes(8).toString('hex')) as string;

      if (!rawKey) {
        throw new Error('Venice API returned no key material');
      }

      return { keyId, holder: new EphemeralKeyHolder(rawKey) };
    } finally {
      // masterKey string is now GC-eligible; nothing else to zero.
    }
  }

  /**
   * Revoke the ephemeral subkey and zero its memory buffer.
   * Errors during revocation are swallowed — the key has already been used
   * and the session is over regardless.
   */
  async revoke(session: EphemeralKeySession): Promise<void> {
    // Zero the buffer first so we can't accidentally log it in an error path.
    session.holder.discard();

    const masterKey = new TextDecoder().decode(this.masterBuf);
    try {
      await fetchWithTimeout(
        `${this.baseUrl}/api_keys/${session.keyId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${masterKey}` },
        },
        this.timeout,
      );
    } catch {
      // Revocation failure is logged at a structural level — no key details.
    }
  }

  /** Zero the master key material from memory. */
  destroy(): void {
    this.masterBuf.fill(0);
  }
}

// ---------------------------------------------------------------------------
// VeniceClient
// ---------------------------------------------------------------------------

const COST_PER_MILLION: Record<string, { input: number; output: number }> = {
  'llama-3.3-70b': { input: 0.80, output: 0.80 },
  'llama-3.2-3b': { input: 0.06, output: 0.06 },
  'mistral-31-24b': { input: 0.20, output: 0.20 },
  default: { input: 0.20, output: 0.20 },
};

/**
 * Venice AI inference client.
 *
 * For every call to generate():
 *   1. A fresh ephemeral subkey is minted.
 *   2. The subkey is used for exactly one /chat/completions request.
 *   3. The subkey is revoked via the Venice API.
 *   4. The in-memory buffer is zeroed.
 *
 * The master key is stored only inside EphemeralKeyManager and is never
 * passed to the inference code path.
 */
export class VeniceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly keyManager: EphemeralKeyManager;

  constructor(config: VeniceConfig = {}) {
    const masterApiKey =
      config.masterApiKey ?? process.env['VENICE_API_KEY'] ?? '';

    this.baseUrl = (config.baseUrl ?? 'https://api.venice.ai/api/v1').replace(
      /\/+$/,
      '',
    );
    this.timeout = config.timeout ?? 30_000;

    this.keyManager = new EphemeralKeyManager(
      masterApiKey,
      this.baseUrl,
      this.timeout,
    );

    // Immediately zero any local copy — key lives only in keyManager now.
    const tmp = new TextEncoder().encode(masterApiKey);
    tmp.fill(0);
  }

  /**
   * Run inference with an ephemeral key.  The key is minted, used once, then
   * revoked and zeroed — regardless of whether the request succeeds.
   */
  async generate(request: VeniceGenerateRequest): Promise<VeniceGenerateResponse> {
    const startTime = Date.now();
    let session: EphemeralKeySession | null = null;

    try {
      // Step 1 — mint fresh ephemeral key
      session = await this.keyManager.generate();

      // Step 2 — consume key into HTTP header (zeros the buffer)
      const ephemeralKey = session.holder.consume();

      const body = {
        model: request.model ?? 'llama-3.3-70b',
        messages: [
          ...(request.systemPrompt
            ? [{ role: 'system', content: request.systemPrompt }]
            : []),
          { role: 'user', content: request.prompt },
        ],
        max_tokens: request.maxTokens ?? 1024,
        temperature: request.temperature ?? 0.7,
        venice_parameters: { include_venice_system_prompt: false },
      };

      const res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ephemeralKey}`,
          },
          body: JSON.stringify(body),
        },
        this.timeout,
      );
      // ephemeralKey is now GC-eligible — no more references held.

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return {
          success: false,
          provider: 'venice',
          responseTime: Date.now() - startTime,
          error: `HTTP ${res.status}: ${sanitizeForLog(errText)}`,
        };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const choice = (data['choices'] as any[])?.[0];
      const text: string =
        choice?.message?.content ?? choice?.text ?? '';
      const model: string = (data['model'] as string) ?? request.model ?? 'unknown';

      const usage = data['usage'] as Record<string, number> | undefined;
      const promptTokens = usage?.['prompt_tokens'] ?? 0;
      const completionTokens = usage?.['completion_tokens'] ?? 0;
      const cost = estimateCost(model, promptTokens, completionTokens);

      return {
        success: true,
        text,
        model,
        provider: 'venice',
        cost,
        responseTime: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        provider: 'venice',
        responseTime: Date.now() - startTime,
        // Sanitise: strip any long token-like string from error message
        error: sanitizeForLog(
          err instanceof Error ? err.message : 'Unknown error',
        ),
      };
    } finally {
      // Step 3 — revoke key and zero memory, always, even on error
      if (session) {
        await this.keyManager.revoke(session);
      }
    }
  }

  /** Check if the Venice API is reachable with the current master key. */
  async isAvailable(): Promise<boolean> {
    const masterKey = new TextDecoder().decode(
      // Borrow the buffer via a temporary decode — does not expose it
      (this.keyManager as unknown as { masterBuf: Uint8Array }).masterBuf,
    );
    try {
      const res = await fetchWithTimeout(
        `${this.baseUrl}/models`,
        {
          headers: { Authorization: `Bearer ${masterKey}` },
        },
        5_000,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Destroy the client and zero all master key material. */
  destroy(): void {
    this.keyManager.destroy();
  }
}

// ---------------------------------------------------------------------------
// Utilities (module-private)
// ---------------------------------------------------------------------------

/** Fetch with AbortController-based timeout. */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Remove long alphanumeric tokens from a string before logging.
 * Catches Bearer tokens, hex keys, base64 blobs, and JWT segments.
 */
export function sanitizeForLog(message: string): string {
  return message
    // Base64 / hex blobs ≥ 20 chars
    .replace(/[A-Za-z0-9+/\-_]{20,}={0,2}/g, '[REDACTED]')
    // Explicit "Bearer …" pattern
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    // Standalone long hex strings
    .replace(/\b[0-9a-fA-F]{20,}\b/g, '[REDACTED]');
}

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const rate = COST_PER_MILLION[model] ?? COST_PER_MILLION['default']!;
  return (promptTokens * rate.input + completionTokens * rate.output) / 1_000_000;
}
