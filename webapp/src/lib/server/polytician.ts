import { NextResponse } from 'next/server'
import type { PolyticianMCPClient } from '@/orchestration/mcp-client'

type PolyticianTools = typeof import('@/orchestration/polytician-tools')

/**
 * Spawn the Polytician MCP server at entryPoint, run fn against it, and always
 * disconnect, so a failed call does not leave the server process running.
 */
export async function withPolytician<T>(
  entryPoint: string,
  namespace: string,
  fn: (client: PolyticianMCPClient, tools: PolyticianTools) => Promise<T>
): Promise<T> {
  const [{ PolyticianMCPClient }, tools] = await Promise.all([
    import('@/orchestration/mcp-client'),
    import('@/orchestration/polytician-tools'),
  ])
  const client = new PolyticianMCPClient({ namespace, entryPoint })
  try {
    await client.connect()
    return await fn(client, tools)
  } finally {
    await client.disconnect()
  }
}

// HTTP statuses for Polytician 3.0's error codes. INVALID_RESULT (a result that
// does not match the tool's output schema) and OUTCOME_UNKNOWN (an archive or
// push that got no answer in time) are AgentVault's own.
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  NAMESPACE_DENIED: 403,
  VERSION_CONFLICT: 409,
  OVERWRITE_REFUSED: 409,
  CONFIG_ERROR: 503,
  UPSTREAM_ERROR: 502,
  INVALID_RESULT: 502,
  OUTCOME_UNKNOWN: 504,
}

/**
 * The error response for a failed Polytician call. A tool error carries
 * Polytician's message and code, from its { error, code } body. Any other
 * failure (the server would not start or exited, with its stderr in the
 * message, or did not answer) is logged here and answered with a generic
 * message, so Polytician's logs do not reach HTTP callers.
 */
export function polyticianErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && error.name === 'MCPToolError') {
    const code = (error as Error & { code?: string }).code ?? 'POLYTICIAN_ERROR'
    return NextResponse.json(
      { success: false, error: { message: error.message, code } },
      { status: STATUS_BY_CODE[code] ?? 500 }
    )
  }

  console.error('Polytician call failed:', error)
  const timedOut = error instanceof Error && error.name === 'MCPTimeoutError'
  return NextResponse.json(
    {
      success: false,
      error: timedOut
        ? { message: 'Polytician did not answer in time', code: 'POLYTICIAN_TIMEOUT' }
        : { message: 'Polytician server unavailable', code: 'POLYTICIAN_UNAVAILABLE' },
    },
    { status: timedOut ? 504 : 502 }
  )
}

/** The JSON object in a request body, or null when the body is not one. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}
