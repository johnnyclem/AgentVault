/**
 * Secret Leak Detector
 *
 * Monitors for accidental secret leakage through common vectors:
 *
 * - Environment variables visible to child processes
 * - Process arguments (visible via `ps`)
 * - stdout/stderr output
 * - Log files
 *
 * When a leak is detected, the detector can:
 * 1. Emit an event for audit logging
 * 2. Attempt automatic remediation (e.g. redact from env)
 * 3. Optionally rotate the leaked secret
 */

import type { LeakDetectionEvent, LeakSeverity } from './safehouse-types.js';

export type LeakEventCallback = (event: LeakDetectionEvent) => void;

export interface LeakDetectorOptions {
  /** Callback invoked on each leak detection event */
  onLeak?: LeakEventCallback;
  /** Whether to auto-remediate detected leaks (default: true) */
  autoRemediate?: boolean;
  /** Whether to scan process.argv (default: true) */
  scanProcessArgs?: boolean;
  /** Whether to scan process.env (default: true) */
  scanEnv?: boolean;
}

/**
 * A tracked secret that the detector will look for in various leak vectors.
 */
interface TrackedSecret {
  key: string;
  /** SHA-256 fingerprint of the value (we never store the plaintext) */
  fingerprint: string;
  /** The first 4 chars of the value for fast prefix scanning */
  prefix: string;
  /** Length of the original value */
  length: number;
}

export class SecretLeakDetector {
  private readonly tracked = new Map<string, TrackedSecret>();
  private readonly events: LeakDetectionEvent[] = [];
  private readonly onLeak: LeakEventCallback | null;
  private readonly autoRemediate: boolean;
  private readonly scanProcessArgs: boolean;
  private readonly scanEnv: boolean;

  /**
   * Captured original stdout.write so we can intercept writes.
   * We only set this up once and restore on dispose.
   */
  private originalStdoutWrite: typeof process.stdout.write | null = null;
  private originalStderrWrite: typeof process.stderr.write | null = null;
  private intercepting = false;

  constructor(options?: LeakDetectorOptions) {
    this.onLeak = options?.onLeak ?? null;
    this.autoRemediate = options?.autoRemediate ?? true;
    this.scanProcessArgs = options?.scanProcessArgs ?? true;
    this.scanEnv = options?.scanEnv ?? true;
  }

  // -----------------------------------------------------------------------
  // Secret tracking
  // -----------------------------------------------------------------------

  /**
   * Register a secret value for leak monitoring.
   * The plaintext is fingerprinted and NOT stored.
   */
  track(key: string, value: string): void {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    this.tracked.set(key, {
      key,
      fingerprint: crypto.createHash('sha256').update(value).digest('hex'),
      prefix: value.slice(0, 4),
      length: value.length,
    });
  }

  /**
   * Stop tracking a secret.
   */
  untrack(key: string): void {
    this.tracked.delete(key);
  }

  // -----------------------------------------------------------------------
  // Scanning
  // -----------------------------------------------------------------------

  /**
   * Scan the current process environment for leaked secrets.
   * Checks if any tracked secret value appears as an env var value.
   */
  scanEnvironment(secretValues: Map<string, string>): LeakDetectionEvent[] {
    if (!this.scanEnv) return [];
    const detected: LeakDetectionEvent[] = [];

    for (const [envKey, envValue] of Object.entries(process.env)) {
      if (!envValue) continue;

      for (const [secretKey, secretValue] of secretValues) {
        if (envValue === secretValue || envValue.includes(secretValue)) {
          const event = this.createEvent(
            'critical',
            secretKey,
            `Secret "${secretKey}" found in environment variable "${envKey}"`,
            'env',
          );

          if (this.autoRemediate) {
            delete process.env[envKey];
            event.remediated = true;
            event.remediationAction = `Removed env var "${envKey}"`;
          }

          detected.push(event);
        }
      }
    }

    return detected;
  }

  /**
   * Scan process.argv for leaked secrets.
   */
  scanProcessArguments(secretValues: Map<string, string>): LeakDetectionEvent[] {
    if (!this.scanProcessArgs) return [];
    const detected: LeakDetectionEvent[] = [];

    for (const arg of process.argv) {
      for (const [secretKey, secretValue] of secretValues) {
        if (arg.includes(secretValue)) {
          const event = this.createEvent(
            'critical',
            secretKey,
            `Secret "${secretKey}" found in process arguments (visible via ps)`,
            'process-args',
          );
          // Cannot remediate process.argv after the fact
          detected.push(event);
        }
      }
    }

    return detected;
  }

  /**
   * Check if a string contains any tracked secret values.
   * Used for scanning log output, stdout, etc.
   */
  scanString(text: string, source: LeakDetectionEvent['source'], secretValues: Map<string, string>): LeakDetectionEvent[] {
    const detected: LeakDetectionEvent[] = [];

    for (const [secretKey, secretValue] of secretValues) {
      if (text.includes(secretValue)) {
        detected.push(
          this.createEvent(
            source === 'stdout' ? 'warning' : 'critical',
            secretKey,
            `Secret "${secretKey}" detected in ${source} output`,
            source,
          ),
        );
      }
    }

    return detected;
  }

  /**
   * Install stdout/stderr interceptors that redact tracked secrets.
   * Call `dispose()` to remove the interceptors.
   */
  installOutputInterceptors(secretValues: Map<string, string>): void {
    if (this.intercepting) return;
    this.intercepting = true;

    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);
    this.originalStderrWrite = process.stderr.write.bind(process.stderr);

    const self = this;

    process.stdout.write = function (chunk: unknown, ...args: unknown[]): boolean {
      const str = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const redacted = self.redactSecrets(str, secretValues);

      if (redacted !== str) {
        // Leak detected in stdout
        for (const [secretKey, secretValue] of secretValues) {
          if (str.includes(secretValue)) {
            self.createEvent('warning', secretKey, `Secret "${secretKey}" redacted from stdout`, 'stdout');
          }
        }
      }

      return self.originalStdoutWrite!.call(process.stdout, redacted, ...(args as []));
    } as typeof process.stdout.write;

    process.stderr.write = function (chunk: unknown, ...args: unknown[]): boolean {
      const str = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
      const redacted = self.redactSecrets(str, secretValues);
      return self.originalStderrWrite!.call(process.stderr, redacted, ...(args as []));
    } as typeof process.stderr.write;
  }

  /**
   * Remove stdout/stderr interceptors.
   */
  removeOutputInterceptors(): void {
    if (!this.intercepting) return;

    if (this.originalStdoutWrite) {
      process.stdout.write = this.originalStdoutWrite;
      this.originalStdoutWrite = null;
    }
    if (this.originalStderrWrite) {
      process.stderr.write = this.originalStderrWrite;
      this.originalStderrWrite = null;
    }

    this.intercepting = false;
  }

  // -----------------------------------------------------------------------
  // Event retrieval
  // -----------------------------------------------------------------------

  /**
   * Get all recorded leak events.
   */
  getEvents(): LeakDetectionEvent[] {
    return [...this.events];
  }

  /**
   * Get events filtered by severity.
   */
  getEventsBySeverity(severity: LeakSeverity): LeakDetectionEvent[] {
    return this.events.filter(e => e.severity === severity);
  }

  /**
   * Clear recorded events.
   */
  clearEvents(): void {
    this.events.length = 0;
  }

  /**
   * Clean up interceptors and tracked secrets.
   */
  dispose(): void {
    this.removeOutputInterceptors();
    this.tracked.clear();
    this.events.length = 0;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private redactSecrets(text: string, secretValues: Map<string, string>): string {
    let result = text;
    for (const [, value] of secretValues) {
      if (result.includes(value)) {
        result = result.replaceAll(value, '[REDACTED]');
      }
    }
    return result;
  }

  private createEvent(
    severity: LeakSeverity,
    secretKey: string,
    description: string,
    source: LeakDetectionEvent['source'],
  ): LeakDetectionEvent {
    const event: LeakDetectionEvent = {
      detectedAt: new Date().toISOString(),
      severity,
      description,
      secretKey,
      source,
      remediated: false,
    };

    this.events.push(event);
    if (this.onLeak) this.onLeak(event);

    return event;
  }
}
