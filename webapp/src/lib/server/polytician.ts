import { NextResponse } from 'next/server'
import type { PolyticianMCPClient } from '@/orchestration/mcp-client'
import { isValidPolyticianNamespace } from '@/orchestration/polytician-config'

type PolyticianTools = typeof import('@/orchestration/polytician-tools')

/**
 * The 400 answer for an agentId that cannot be a Polytician namespace, else
 * null. The agentId (the agent's name, as the webapp's agents are keyed) is
 * the namespace the routes work in, so one agent's concepts stay in one
 * namespace whichever surface wrote them: the CLI and orchestrate default to
 * the same name.
 */
export function invalidAgentIdResponse(agentId: string): NextResponse | null {
  if (isValidPolyticianNamespace(agentId)) {
    return null
  }
  return NextResponse.json(
    {
      success: false,
      error: {
        message: "agentId must be a Polytician namespace: 1-64 letters, digits, '.', '_', ':' or '-', starting with a letter or digit",
        code: 'INVALID_AGENT_ID',
      },
    },
    { status: 400 }
  )
}

/**
 * Spawn the Polytician MCP server at entryPoint, run fn against it with every
 * namespace-taking call in the agent's namespace, and always disconnect, so a
 * failed call does not leave the server process running. Polytician gets
 * AGENTVAULT_API_URL and AGENTVAULT_POLYTICIAN_API_TOKEN as its
 * POLYTICIAN_AV_API_URL and POLYTICIAN_AV_API_TOKEN (unless those are set),
 * so it registers its vault_* tools. The server's environment is read, never
 * the home directory.
 */
export async function withPolytician<T>(
  entryPoint: string,
  namespace: string,
  fn: (client: PolyticianMCPClient, tools: PolyticianTools) => Promise<T>
): Promise<T> {
  const [{ PolyticianMCPClient }, tools, { polyticianServerConfig }] = await Promise.all([
    import('@/orchestration/mcp-client'),
    import('@/orchestration/polytician-tools'),
    import('@/orchestration/polytician-config'),
  ])
  const client = new PolyticianMCPClient(polyticianServerConfig({ entryPoint, namespace }))
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
 * Polytician's message and code, from its { error, code } body; a setting
 * AgentVault refused before starting Polytician (an AGENTVAULT_API_URL
 * Polytician would refuse) is 503 POLYTICIAN_CONFIG_ERROR, with a message
 * that holds no secret. Any other failure (the server would not start or
 * exited, with its stderr in the message, or did not answer) is logged here
 * and answered with a generic message, so Polytician's logs do not reach
 * HTTP callers.
 */
export function polyticianErrorResponse(error: unknown): NextResponse {
  if (error instanceof Error && error.name === 'PolyticianConfigError') {
    return NextResponse.json(
      { success: false, error: { message: error.message, code: 'POLYTICIAN_CONFIG_ERROR' } },
      { status: 503 }
    )
  }
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
