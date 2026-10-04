import { NextResponse } from 'next/server'

/**
 * The routes Polytician's AgentVault client calls (its vault_* tools, its
 * AgentVault inference provider and its secret reads), as that client
 * allowlists them.
 */
const POLYTICIAN_CLIENT_PATHS = [
  /^\/api\/inference$/,
  /^\/api\/memory-repo\/branches\/[^/]+$/,
  /^\/api\/memory-repo\/commits$/,
  /^\/api\/memory-repo\/tombstone$/,
  /^\/api\/archival\/upload$/,
  /^\/api\/secrets\/[^/]+$/,
]

export function isPolyticianClientPath(pathname: string): boolean {
  return POLYTICIAN_CLIENT_PATHS.some((pattern) => pattern.test(pathname))
}

/**
 * An error response for those routes, in the shape Polytician's client reads
 * (its AVErrorResponse): `error` is the message, a string, with `code` beside
 * it. The client throws with `error` as the message and Polytician's tools
 * pass on only that message, so the message starts with the code. The
 * `{ message, code }` object the webapp's own routes answer with reached
 * Polytician users as "[object Object]".
 */
export function polyticianClientError(status: number, code: string, message: string, details?: unknown): NextResponse {
  return NextResponse.json(
    { success: false, code, error: `${code}: ${message}`, ...(details === undefined ? {} : { details }) },
    { status }
  )
}
