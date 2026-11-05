/**
 * Credential-injecting reverse proxy: the whole program of the sidecar (PRD-04).
 *
 * WHY: an agent must never hold a real API key, because a prompt-injected agent
 * can print or exfiltrate whatever it holds. The agent is pointed at
 * http://agentvault-proxy:8080/<service> (through the SDK's BASE_URL variable)
 * with a placeholder key. This process swaps in the real credential and forwards
 * over TLS to an upstream that comes from a FIXED route table.
 *
 * SECURITY STANCE
 *  - Not an open relay and not a CONNECT/MITM proxy. The upstream origin is part
 *    of the route, never of the request. Only origin-form targets are accepted,
 *    and the final upstream URL is re-checked against the route's origin before
 *    any socket is opened.
 *  - Inbound credentials are stripped and replaced, never appended or passed.
 *  - Fails closed: startup aborts when a referenced secret is missing, and a
 *    secret that goes missing later gives 503 instead of an unauthenticated call.
 *  - Nothing derived from a request or an error (header, body, query, node error
 *    text with hostnames or IPs) is echoed to the client or written to the log.
 *  - Bodies are streamed, never buffered, and capped while streaming.
 *
 * SELF-CONTAINED: this file imports only node: built-ins at runtime (type-only
 * imports are erased). bundle.ts compiles it into one script that runs in a bare
 * node:22-slim container with no node_modules. Importing this module starts
 * nothing; only the bundle produced by bundle.ts starts the server.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { Transform, pipeline } from 'node:stream';
import type { Duplex } from 'node:stream';
import type { CredentialProxyConfig, ProxyInjection, ProxyRoute } from '../types.js';

// ---------------------------------------------------------------------------
// Constants (deliberately duplicated from ../types.js and ../validate.js so this
// file stays free of runtime imports; tests assert they agree).
// ---------------------------------------------------------------------------

const CONFIG_ENV = 'AV_PROXY_CONFIG';
const SECRET_ENV_PREFIX = 'AV_SECRET_';

export const HEALTH_PATH = '/_agentvault/health';

const ALLOWED_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** Request headers never forwarded (exact names). */
const STRIPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'forwarded',
  'x-real-ip',
  // Framing is rebuilt by us; the 100-continue handshake ends at this proxy.
  'expect',
  'transfer-encoding',
]);
const STRIPPED_REQUEST_PREFIXES: readonly string[] = ['proxy-', 'x-forwarded-'];

/** Response headers never passed back to the client. */
const HOP_BY_HOP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers a route may not inject (hop-by-hop or message framing). */
const FORBIDDEN_INJECT_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
]);

const MAX_TARGET_LENGTH = 8192;
const MAX_LOG_PATH_LENGTH = 512;
const MAX_ROUTES = 64;
const MAX_INJECTIONS_PER_ROUTE = 8;
const MAX_SECRET_LENGTH = 8192;
const MAX_DECODE_ROUNDS = 5;
const SHUTDOWN_GRACE_MS = 5_000;

const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const ROUTE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SECRET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** Segments of [A-Za-z0-9_-]; a segment cannot start with `_`, which reserves /_agentvault. */
const PATH_PREFIX_RE = /^(?:\/[A-Za-z0-9][A-Za-z0-9_-]*){1,8}$/;
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9._~+-]{0,31}$/;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One audit line. Metadata only: no headers, no bodies, no query string. */
export interface AuditEntry {
  event: 'request';
  /** ISO time the request was received. */
  ts: string;
  /** Route name, or null when no route matched or the request was rejected early. */
  route: string | null;
  method: string;
  /** Path only (never the query string, which can carry keys). */
  path: string;
  /** Status sent to the client; 499 when the client left before any response. */
  status: number;
  durationMs: number;
  /** Request body bytes received from the client. */
  bytesIn: number;
  /** Response body bytes written to the client. */
  bytesOut: number;
  /**
   * Node's error code when the upstream call itself failed (ENOTFOUND, ECONNREFUSED,
   * SELF_SIGNED_CERT_IN_CHAIN, ...). A fixed identifier, never error text, so it cannot carry a
   * URL or a secret. It is what turns an opaque 502 into something an operator can act on.
   * Absent when the upstream answered.
   */
  upstreamError?: string;
}

/** Node error codes look like `ECONNRESET` / `ERR_TLS_CERT_ALTNAME_INVALID`; anything else is dropped. */
const UPSTREAM_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function upstreamErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && UPSTREAM_ERROR_CODE.test(code) ? code : undefined;
}

export interface ProxyTimeouts {
  /** Time allowed to receive complete request headers. */
  headersMs: number;
  /** Time allowed to receive the whole request, body included. */
  requestMs: number;
  /** Idle time before a keep-alive connection is closed. */
  keepAliveMs: number;
  /**
   * How long an idle keep-alive socket to an UPSTREAM stays pooled. Kept below the 5s that
   * node servers use by default, so a pooled socket is never one the upstream already closed
   * (reusing one fails a POST with a reset, and a POST cannot be retried blindly).
   */
  upstreamIdleMs: number;
}

/** Deliberate values (node's own defaults are 60s / 300s / 5s). */
export const DEFAULT_SERVER_TIMEOUTS: Readonly<ProxyTimeouts> = {
  headersMs: 15_000,
  requestMs: 120_000,
  keepAliveMs: 30_000,
  upstreamIdleMs: 4_000,
};

export interface CreateCredentialProxyOptions {
  config: CredentialProxyConfig;
  /**
   * secret name -> value. Read on every request (not copied), so a secret that
   * disappears is noticed. Presence is enforced at startup by runFromEnv.
   */
  secrets: Readonly<Record<string, string | undefined>>;
  /** Audit sink. Default: one JSON line per entry on stdout. */
  log?: (entry: AuditEntry) => void;
  /** Clock in epoch milliseconds. Called once at request start and once at its end. */
  now?: () => number;
  timeouts?: Partial<ProxyTimeouts>;
}

export interface RunOptions {
  /** Where the single `listening` line goes. Default: process.stdout. */
  stdout?: (text: string) => void;
  /** Install SIGTERM/SIGINT handlers that drain and exit. Default true. */
  handleSignals?: boolean;
  log?: CreateCredentialProxyOptions['log'];
  timeouts?: Partial<ProxyTimeouts>;
}

/** Thrown for any invalid config or unusable startup input. Messages never contain values. */
export class ProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProxyConfigError';
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * "anthropic" -> AV_SECRET_ANTHROPIC, "my-key" -> AV_SECRET_MY_KEY. Must equal
 * secretEnvName() in ../validate.ts (a test pins that).
 */
export function secretEnvName(secretName: string): string {
  return `${SECRET_ENV_PREFIX}${secretName.toUpperCase().replace(/-/g, '_')}`;
}

/** Printable ASCII, no leading or trailing space: safe in a header and in an env file. */
export function isValidSecretValue(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_LENGTH) return false;
  if (value.startsWith(' ') || value.endsWith(' ')) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Config validation (hand written: no zod in the sidecar)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOnlyKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new ProxyConfigError(`${where}: unknown field ${JSON.stringify(key.slice(0, 40))}`);
  }
}

function isPrintableAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return false;
  }
  return true;
}

function validateUpstream(value: unknown, allowInsecure: boolean, where: string): void {
  // Messages never echo the value: an upstream string may carry embedded credentials.
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new ProxyConfigError(`${where}: must be a non-empty URL string`);
  }
  if (!isPrintableAscii(value) || value.includes('\\')) {
    throw new ProxyConfigError(`${where}: contains characters that are not allowed in an upstream URL`);
  }
  if (value.includes('?') || value.includes('#') || value.includes('..')) {
    throw new ProxyConfigError(`${where}: must not contain a query, fragment or ".."`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProxyConfigError(`${where}: not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProxyConfigError(`${where}: scheme must be http or https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProxyConfigError(`${where}: must not embed credentials`);
  }
  if (url.hostname === '') {
    throw new ProxyConfigError(`${where}: missing host`);
  }
  if (url.protocol === 'http:' && !allowInsecure) {
    throw new ProxyConfigError(`${where}: http upstream requires allowInsecureUpstream`);
  }
}

function validateInjection(value: unknown, where: string): ProxyInjection {
  if (!isRecord(value)) throw new ProxyConfigError(`${where}: must be an object`);
  hasOnlyKeys(value, ['header', 'secret', 'scheme'], where);
  const { header, secret, scheme } = value;
  if (typeof header !== 'string' || !TOKEN_RE.test(header) || header.length > 64) {
    throw new ProxyConfigError(`${where}.header: must be a valid HTTP header name`);
  }
  const lower = header.toLowerCase();
  if (FORBIDDEN_INJECT_HEADERS.has(lower) || lower.startsWith('proxy-')) {
    throw new ProxyConfigError(`${where}.header: this header cannot be injected`);
  }
  if (typeof secret !== 'string' || !SECRET_NAME_RE.test(secret)) {
    throw new ProxyConfigError(`${where}.secret: must be a secret name (a-z, 0-9, "-")`);
  }
  const out: ProxyInjection = { header, secret };
  if (scheme !== undefined) {
    if (typeof scheme !== 'string' || !SCHEME_RE.test(scheme)) {
      throw new ProxyConfigError(`${where}.scheme: must be an auth scheme token such as "Bearer"`);
    }
    out.scheme = scheme;
  }
  return out;
}

function validateRoute(value: unknown, index: number): ProxyRoute {
  const where = `routes[${index}]`;
  if (!isRecord(value)) throw new ProxyConfigError(`${where}: must be an object`);
  hasOnlyKeys(value, ['name', 'pathPrefix', 'upstream', 'inject', 'allowInsecureUpstream'], where);
  const { name, pathPrefix, upstream, inject, allowInsecureUpstream } = value;
  if (typeof name !== 'string' || !ROUTE_NAME_RE.test(name)) {
    throw new ProxyConfigError(`${where}.name: must match ${ROUTE_NAME_RE.source}`);
  }
  if (typeof pathPrefix !== 'string' || !PATH_PREFIX_RE.test(pathPrefix)) {
    throw new ProxyConfigError(`${where}.pathPrefix: must be like "/service" (segments of A-Z a-z 0-9 _ -)`);
  }
  if (allowInsecureUpstream !== undefined && typeof allowInsecureUpstream !== 'boolean') {
    throw new ProxyConfigError(`${where}.allowInsecureUpstream: must be a boolean`);
  }
  validateUpstream(upstream, allowInsecureUpstream === true, `${where}.upstream`);
  if (!Array.isArray(inject) || inject.length > MAX_INJECTIONS_PER_ROUTE) {
    throw new ProxyConfigError(`${where}.inject: must be an array of at most ${MAX_INJECTIONS_PER_ROUTE} entries`);
  }
  const seenHeaders = new Set<string>();
  const injections = inject.map((entry, i) => {
    const injection = validateInjection(entry, `${where}.inject[${i}]`);
    const lower = injection.header.toLowerCase();
    if (seenHeaders.has(lower)) throw new ProxyConfigError(`${where}.inject[${i}].header: duplicate header in one route`);
    seenHeaders.add(lower);
    return injection;
  });
  const route: ProxyRoute = { name, pathPrefix, upstream: upstream as string, inject: injections };
  if (allowInsecureUpstream !== undefined) route.allowInsecureUpstream = allowInsecureUpstream;
  return route;
}

function boundedInt(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ProxyConfigError(`${where}: must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Validate and normalise a config. Returns a fresh object holding only known
 * fields. Used by the sidecar at startup AND by the host-side planner, so both
 * apply identical rules. Error messages name fields, never values.
 */
export function validateProxyConfig(input: unknown): CredentialProxyConfig {
  if (!isRecord(input)) throw new ProxyConfigError('config: must be an object');
  hasOnlyKeys(input, ['version', 'listenPort', 'routes', 'maxBodyBytes', 'upstreamTimeoutMs'], 'config');
  if (input['version'] !== 1) throw new ProxyConfigError('config.version: must be 1');
  // 0 is allowed so tests can bind an ephemeral port; the `listening` line reports the real one.
  const listenPort = boundedInt(input['listenPort'], 0, 65535, 'config.listenPort');
  const maxBodyBytes = boundedInt(input['maxBodyBytes'], 1, 2 ** 40, 'config.maxBodyBytes');
  const upstreamTimeoutMs = boundedInt(input['upstreamTimeoutMs'], 1, 86_400_000, 'config.upstreamTimeoutMs');
  const rawRoutes = input['routes'];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > MAX_ROUTES) {
    throw new ProxyConfigError(`config.routes: must be an array of at most ${MAX_ROUTES} routes`);
  }
  const names = new Set<string>();
  const prefixes = new Set<string>();
  const routes = rawRoutes.map((raw, i) => {
    const route = validateRoute(raw, i);
    if (names.has(route.name)) throw new ProxyConfigError(`routes[${i}].name: duplicate route name`);
    if (prefixes.has(route.pathPrefix)) throw new ProxyConfigError(`routes[${i}].pathPrefix: duplicate path prefix`);
    names.add(route.name);
    prefixes.add(route.pathPrefix);
    return route;
  });
  return { version: 1, listenPort, routes, maxBodyBytes, upstreamTimeoutMs };
}

/** Distinct secret names the routes inject, in first-use order. */
export function referencedSecrets(config: CredentialProxyConfig): string[] {
  const seen = new Set<string>();
  for (const route of config.routes) {
    for (const injection of route.inject) seen.add(injection.secret);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Request-target inspection
// ---------------------------------------------------------------------------

export type TargetCheck = { ok: true; path: string; query: string } | { ok: false; reason: string };

function hasForbiddenChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) return true;
  }
  return false;
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function countSlashes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 0x2f) n++;
  return n;
}

/** Decode every well-formed %XX (one byte -> one char) and leave anything else alone. Never throws. */
function lenientPercentDecode(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Checks one representation of the path (raw, then each decoded form). */
function pathShapeProblem(candidate: string): string | null {
  if (candidate.includes('\\')) return 'backslash';
  if (hasControlChar(candidate)) return 'control-character';
  if (candidate.includes('..')) return 'dot-dot';
  if (candidate.includes('//')) return 'double-slash';
  if (candidate.split('/').some((segment) => segment === '.')) return 'dot-segment';
  return null;
}

/**
 * Accept only origin-form targets that cannot be bent into another path or
 * authority. The path is judged in its raw form and after every level of
 * percent-decoding, because an upstream or intermediary may decode again.
 */
export function inspectRequestTarget(raw: string): TargetCheck {
  const bad = (reason: string): TargetCheck => ({ ok: false, reason });
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TARGET_LENGTH) return bad('length');
  // Absolute-form, authority-form and "*" never start with "/".
  if (raw.charCodeAt(0) !== 0x2f) return bad('not-origin-form');
  // "//host/x" would read as a network-path reference.
  if (raw.startsWith('//')) return bad('network-path');
  if (hasForbiddenChar(raw)) return bad('character');
  if (raw.includes('#')) return bad('fragment');

  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q);

  if (/%(?![0-9a-fA-F]{2})/.test(path)) return bad('malformed-percent');
  if (/%(?:25)*(?:2e|2f|5c)/i.test(path)) return bad('encoded-dot-or-slash');
  if (/%(?:[01][0-9a-fA-F]|7f)/i.test(path)) return bad('encoded-control');

  // Strict once, for validity (rejects bytes that are not UTF-8).
  try {
    decodeURIComponent(path);
  } catch {
    return bad('malformed-percent');
  }
  // Then lenient and repeated: a decoder further along may be forgiving about a stray "%",
  // so "%25%32e%25%32e%" has to be seen as "..", not skipped because the last "%" is dangling.
  const slashes = countSlashes(path);
  let current = path;
  for (let round = 0; ; round++) {
    const problem = pathShapeProblem(current);
    if (problem !== null) return bad(problem);
    if (countSlashes(current) !== slashes) return bad('encoded-slash');
    const next = lenientPercentDecode(current);
    if (next === current) break;
    if (round >= MAX_DECODE_ROUNDS) return bad('nested-encoding');
    current = next;
  }
  return { ok: true, path, query };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface CompiledRoute {
  name: string;
  prefix: string;
  origin: string;
  protocol: 'http:' | 'https:';
  /** The upstream's base path without a trailing slash; '' for none. */
  basePath: string;
  /** origin + base path */
  baseHref: string;
  inject: Array<{ header: string; secret: string; scheme: string | undefined }>;
  injectNames: ReadonlySet<string>;
}

/** Exported for tests. */
export function compileRoutes(routes: readonly ProxyRoute[]): CompiledRoute[] {
  const compiled = routes.map((route): CompiledRoute => {
    const url = new URL(route.upstream);
    const basePath = url.pathname.replace(/\/+$/, '');
    return {
      name: route.name,
      prefix: route.pathPrefix,
      origin: url.origin,
      protocol: url.protocol === 'https:' ? 'https:' : 'http:',
      basePath,
      baseHref: url.origin + basePath,
      inject: route.inject.map((i) => ({ header: i.header.toLowerCase(), secret: i.secret, scheme: i.scheme })),
      injectNames: new Set(route.inject.map((i) => i.header.toLowerCase())),
    };
  });
  // Longest prefix first so nested prefixes resolve to the most specific route.
  return compiled.sort((a, b) => b.prefix.length - a.prefix.length);
}

function matchRoute(routes: readonly CompiledRoute[], path: string): CompiledRoute | undefined {
  // Segment boundary: "/anthropic" matches "/anthropic" and "/anthropic/x", never "/anthropicevil".
  return routes.find((r) => path === r.prefix || path.startsWith(`${r.prefix}/`));
}

/**
 * Fixed upstream + remainder + query, re-checked against the route's origin. Normal
 * traffic cannot trip the check (the target is validated first), so it is exported
 * and tested directly: it is the backstop if that validation ever has a hole.
 */
export function buildUpstreamUrl(route: CompiledRoute, remainder: string, query: string): URL | null {
  let url: URL;
  try {
    url = new URL(route.baseHref + remainder + query);
  } catch {
    return null;
  }
  if (url.origin !== route.origin || url.protocol !== route.protocol || url.username !== '' || url.password !== '') {
    return null;
  }
  // The URL parser folds "\" into "/" and resolves "..": the result must still sit under the route's base path.
  if (route.basePath !== '' && url.pathname !== route.basePath && !url.pathname.startsWith(`${route.basePath}/`)) {
    return null;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Header handling
// ---------------------------------------------------------------------------

function connectionTokens(value: string | undefined): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  for (const token of value.split(',')) {
    const t = token.trim().toLowerCase();
    // content-length is framing; a client must not be able to unset it this way.
    if (t !== '' && t !== 'content-length') out.add(t);
  }
  return out;
}

function isStrippedRequestHeader(name: string): boolean {
  if (STRIPPED_REQUEST_HEADERS.has(name)) return true;
  return STRIPPED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function filterResponseHeaders(incoming: http.IncomingHttpHeaders, secretValues: readonly string[]): http.OutgoingHttpHeaders {
  const drop = new Set<string>(HOP_BY_HOP_RESPONSE_HEADERS);
  for (const token of connectionTokens(incoming.connection)) drop.add(token);
  const out: http.OutgoingHttpHeaders = Object.create(null) as http.OutgoingHttpHeaders;
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || drop.has(name)) continue;
    const values = Array.isArray(value) ? value : [value];
    // Never hand an injected credential back to the agent, even if the upstream reflects it.
    if (values.some((v) => secretValues.some((s) => v.includes(s)))) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

class BodyTooLargeError extends Error {}

function defaultLog(entry: AuditEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

function noop(): void {
  // Deliberately empty: swallows late socket errors on streams we have already abandoned.
}

function logPath(rawUrl: string): string {
  const end = rawUrl.search(/[?#]/);
  const path = end === -1 ? rawUrl : rawUrl.slice(0, end);
  return path.length > MAX_LOG_PATH_LENGTH ? `${path.slice(0, MAX_LOG_PATH_LENGTH)}...` : path;
}

export function createCredentialProxy(options: CreateCredentialProxyOptions): http.Server {
  const config = validateProxyConfig(options.config);
  const secrets = options.secrets;
  const log = options.log ?? defaultLog;
  const now = options.now ?? Date.now;
  const timeouts: ProxyTimeouts = { ...DEFAULT_SERVER_TIMEOUTS, ...options.timeouts };
  const routes = compileRoutes(config.routes);
  const referenced = referencedSecrets(config);

  const httpAgent = new http.Agent({ keepAlive: true, timeout: timeouts.upstreamIdleMs });
  // No `ca`: node's bundled root store verifies the upstream, not the container's OS store.
  const httpsAgent = new https.Agent({ keepAlive: true, timeout: timeouts.upstreamIdleMs });

  const secretValue = (name: string): string | undefined => {
    const value = Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : undefined;
    return isValidSecretValue(value) ? value : undefined;
  };

  const emit = (entry: AuditEntry): void => {
    try {
      log(entry);
    } catch {
      // An audit sink failure must never take a request (or the process) down.
    }
  };

  const handle = (req: http.IncomingMessage, res: http.ServerResponse, expectContinue: boolean): void => {
    const startedAt = now();
    const rawUrl = req.url ?? '';
    const method = req.method ?? '';
    let routeName: string | null = null;
    let bytesIn = 0;
    let bytesOut = 0;
    let phase: 'pending' | 'streaming' | 'done' = 'pending';
    let upstreamReq: http.ClientRequest | undefined;
    let upstreamError: string | undefined;

    req.on('error', noop);
    res.on('error', noop);

    res.once('close', () => {
      // The client left before we finished: stop paying for the upstream call.
      if (!res.writableFinished) upstreamReq?.destroy();
      emit({
        event: 'request',
        ts: new Date(startedAt).toISOString(),
        route: routeName,
        method: method.slice(0, 16),
        path: logPath(rawUrl),
        status: res.headersSent ? res.statusCode : 499,
        durationMs: now() - startedAt,
        bytesIn,
        bytesOut,
        ...(upstreamError ? { upstreamError } : {}),
      });
    });

    /** Generic, constant bodies only: never request data, never node error text. */
    const fail = (status: number, code: string, extra?: Record<string, string>): void => {
      if (phase === 'streaming') {
        res.destroy();
        return;
      }
      if (phase === 'done') return;
      phase = 'done';
      const body = JSON.stringify({ error: code });
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        connection: 'close',
        ...extra,
      });
      if (method !== 'HEAD') bytesOut += Buffer.byteLength(body);
      res.end(body);
    };

    try {
      const target = inspectRequestTarget(rawUrl);
      if (!target.ok) return fail(400, 'bad_request');

      if (!ALLOWED_METHODS.has(method)) return fail(405, 'method_not_allowed', { allow: [...ALLOWED_METHODS].join(', ') });

      if (target.path === HEALTH_PATH && (method === 'GET' || method === 'HEAD')) {
        phase = 'done';
        const body = '{"ok":true}';
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
        if (method !== 'HEAD') bytesOut += body.length;
        res.end(body);
        return;
      }

      const route = matchRoute(routes, target.path);
      if (!route) return fail(404, 'not_found');
      routeName = route.name;

      const declaredLength = req.headers['content-length'];
      if (declaredLength !== undefined) {
        if (!/^\d{1,15}$/.test(declaredLength)) return fail(400, 'bad_request');
        if (Number(declaredLength) > config.maxBodyBytes) return fail(413, 'payload_too_large');
      }
      const transferEncoding = req.headers['transfer-encoding'];
      if (transferEncoding !== undefined && transferEncoding.trim().toLowerCase() !== 'chunked') {
        return fail(400, 'bad_request');
      }

      const injected: Array<[string, string]> = [];
      for (const injection of route.inject) {
        const value = secretValue(injection.secret);
        if (value === undefined) return fail(503, 'service_unavailable');
        injected.push([injection.header, injection.scheme ? `${injection.scheme} ${value}` : value]);
      }

      const remainder = target.path.slice(route.prefix.length);
      const upstreamUrl = buildUpstreamUrl(route, remainder, target.query);
      if (!upstreamUrl) return fail(502, 'bad_gateway');

      // Anything the client sent that could carry or forge a credential is dropped,
      // then ours is written. Inbound credentials are replaced, never merged.
      const hopByHop = connectionTokens(req.headers.connection);
      const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (isStrippedRequestHeader(name) || route.injectNames.has(name) || hopByHop.has(name)) continue;
        headers[name] = value;
      }
      for (const [name, value] of injected) headers[name] = value;
      if (transferEncoding !== undefined) headers['transfer-encoding'] = 'chunked';

      // From here on the request is accepted: finish the 100-continue handshake.
      if (expectContinue) res.writeContinue();

      const requestOptions = { method, headers, timeout: config.upstreamTimeoutMs };
      const clientReq =
        upstreamUrl.protocol === 'https:'
          ? https.request(upstreamUrl, { ...requestOptions, agent: httpsAgent })
          : http.request(upstreamUrl, { ...requestOptions, agent: httpAgent });
      upstreamReq = clientReq;

      let timedOut = false;
      let tooLarge = false;
      // Event callbacks run outside the try/catch above, and an exception there would take the
      // whole sidecar (every in-flight request) down. Contain it to this one request.
      const guarded =
        <A extends unknown[]>(handler: (...args: A) => void) =>
        (...args: A): void => {
          try {
            handler(...args);
          } catch {
            clientReq.destroy();
            fail(500, 'internal_error');
          }
        };
      const failFromError = guarded((): void => {
        if (tooLarge) fail(413, 'payload_too_large');
        else if (timedOut) fail(504, 'gateway_timeout');
        else fail(502, 'bad_gateway');
      });
      clientReq.on(
        'timeout',
        guarded(() => {
          timedOut = true;
          clientReq.destroy();
        })
      );
      clientReq.on('error', (err: unknown) => {
        // Only the code is kept (see AuditEntry.upstreamError); the client still gets a constant body.
        // A timeout/oversize abort is ours, not an upstream fault, so it is not blamed on it.
        if (!tooLarge && !timedOut) upstreamError = upstreamErrorCode(err);
        failFromError();
      });

      clientReq.on(
        'response',
        guarded((upstreamRes: http.IncomingMessage) => {
          if (phase !== 'pending') {
            upstreamRes.destroy();
            return;
          }
          const status = upstreamRes.statusCode ?? 0;
          if (status < 200 || status > 599) {
            // Not a status we can relay (node's writeHead throws on some): treat as a bad upstream.
            upstreamRes.destroy();
            fail(502, 'bad_gateway');
            return;
          }
          const secretValues = referenced.map(secretValue).filter((v): v is string => v !== undefined);
          res.writeHead(status, filterResponseHeaders(upstreamRes.headers, secretValues));
          phase = 'streaming';
          res.flushHeaders();
          const outCounter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytesOut += chunk.length;
              callback(null, chunk);
            },
          });
          // On error pipeline() destroys upstreamRes (and so the upstream socket), the counter and
          // res: the response is already half sent, so cutting both ends is the right outcome.
          pipeline(upstreamRes, outCounter, res, noop);
        })
      );

      // Plain pipe(), not pipeline(): on failure pipeline() destroys the inbound request,
      // and with it the socket our 413/502 still has to travel on.
      const inCounter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytesIn += chunk.length;
          if (bytesIn > config.maxBodyBytes) {
            tooLarge = true;
            callback(new BodyTooLargeError());
            return;
          }
          callback(null, chunk);
        },
      });
      inCounter.on(
        'error',
        guarded(() => {
          req.unpipe(inCounter);
          req.pause();
          clientReq.destroy();
          failFromError();
        })
      );
      req.pipe(inCounter).pipe(clientReq);
    } catch {
      fail(500, 'internal_error');
    }
  };

  const reject501 = (req: http.IncomingMessage, socket: Duplex): void => {
    const startedAt = now();
    const body = '{"error":"not_implemented"}';
    socket.on('error', noop);
    socket.end(
      `HTTP/1.1 501 Not Implemented\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
    );
    emit({
      event: 'request',
      ts: new Date(startedAt).toISOString(),
      route: null,
      method: (req.method ?? '').slice(0, 16),
      path: logPath(req.url ?? ''),
      status: 501,
      durationMs: now() - startedAt,
      bytesIn: 0,
      bytesOut: Buffer.byteLength(body),
    });
  };

  const server = http.createServer(
    {
      headersTimeout: timeouts.headersMs,
      requestTimeout: timeouts.requestMs,
      keepAliveTimeout: timeouts.keepAliveMs,
      // node only checks the two timeouts above every N ms (default 30s); check often enough to mean it.
      connectionsCheckingInterval: Math.max(50, Math.min(5_000, Math.floor(timeouts.headersMs / 2))),
    },
    (req, res) => handle(req, res, false)
  );
  server.on('checkContinue', (req, res) => handle(req, res, true));
  // WebSocket and other protocol upgrades, and CONNECT tunnels, are not supported.
  server.on('upgrade', reject501);
  server.on('connect', reject501);
  server.on('close', () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  });
  return server;
}

// ---------------------------------------------------------------------------
// Process entry
// ---------------------------------------------------------------------------

/** Read config and secrets from the environment, failing closed. Never echoes values. */
export function loadProxyInputs(env: NodeJS.ProcessEnv): { config: CredentialProxyConfig; secrets: Record<string, string> } {
  const raw = env[CONFIG_ENV];
  if (raw === undefined || raw === '') throw new ProxyConfigError(`${CONFIG_ENV} is not set`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProxyConfigError(`${CONFIG_ENV} is not valid JSON`);
  }
  const config = validateProxyConfig(parsed);

  const secrets: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const name of referencedSecrets(config)) {
    const value = env[secretEnvName(name)];
    if (value === undefined || value === '') missing.push(name);
    else if (!isValidSecretValue(value)) invalid.push(name);
    else secrets[name] = value;
  }
  if (missing.length > 0) {
    throw new ProxyConfigError(
      `missing secret(s): ${missing.join(', ')} (expected in ${missing.map(secretEnvName).join(', ')})`
    );
  }
  if (invalid.length > 0) {
    throw new ProxyConfigError(`secret(s) with unusable characters: ${invalid.join(', ')}`);
  }
  return { config, secrets };
}

function installShutdown(server: http.Server): void {
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    // close() stops accepting and, on node >= 19, drops idle keep-alive connections at once.
    server.close(() => process.exit(0));
    // In-flight streams get a short grace period, then the rest are cut.
    setTimeout(() => server.closeAllConnections(), SHUTDOWN_GRACE_MS).unref();
  };
  // `once`: a second signal falls through to node's default and terminates immediately.
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/**
 * Start the sidecar from AV_PROXY_CONFIG + AV_SECRET_*. Rejects (never exits)
 * on bad input so it is testable; the bundled entry turns a rejection into exit
 * code 1. Resolves once listening, after printing exactly one line:
 * {"event":"listening","port":N}
 */
export async function runFromEnv(env: NodeJS.ProcessEnv = process.env, options: RunOptions = {}): Promise<http.Server> {
  const { config, secrets } = loadProxyInputs(env);
  const server = createCredentialProxy({
    config,
    secrets,
    ...(options.log ? { log: options.log } : {}),
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.listenPort;
  const write = options.stdout ?? ((text: string) => void process.stdout.write(text));
  write(`${JSON.stringify({ event: 'listening', port })}\n`);
  if (options.handleSignals ?? true) installShutdown(server);
  return server;
}

async function main(): Promise<void> {
  process.stdout.on('error', noop);
  try {
    await runFromEnv();
  } catch (err) {
    const message =
      err instanceof ProxyConfigError ? err.message : `could not start (${(err as NodeJS.ErrnoException).code ?? 'error'})`;
    process.stderr.write(`agentvault-proxy: ${message}\n`);
    process.exit(1);
  }
}

// Replaced by esbuild's `define` in bundle.ts. Never defined when this file is
// imported (tests, dist), so importing the module starts nothing.
declare const __AV_PROXY_AUTOSTART__: boolean | undefined;
if (typeof __AV_PROXY_AUTOSTART__ !== 'undefined' && __AV_PROXY_AUTOSTART__ === true) {
  void main();
}
