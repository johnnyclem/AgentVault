import { NextRequest, NextResponse } from 'next/server'
import { unauthorizedResponse, validateAuthToken } from '@/lib/server/auth'
import { InvalidCursorError, readIcpWriteReceiptPage, type ReceiptPage } from '@/lib/server/memory-write-receipts'

/*
 * The receipts for memory_repo writes this server signed, newest first, for
 * the Signed memory writes page. They go out as stored, with the full signed
 * argument: the browser needs those bytes to recompute the request id and
 * check the signature, and the canister already serves the same content to
 * anyone who queries it. No verdict is sent; every check runs in the browser.
 *
 * The middleware gates this path with the API token like every /api route;
 * it is checked here as well, as the other memory-repo routes do. This is
 * not a Polytician path, so errors use the webapp's { message, code } shape.
 */

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

/** The page, as GET answers it in `data` */
interface ReceiptsResponse extends ReceiptPage {
  /** Whether this server has a memory_repo canister and a signing identity set, so it makes signed writes at all */
  writesConfigured: boolean
  /**
   * The memory_repo canister this server writes to (MEMORY_REPO_CANISTER_ID),
   * or null when none is set. The page checks each receipt names this
   * canister: the store may also hold receipts for a canister the server
   * wrote to before, or that another server sharing the directory writes to.
   */
  canisterId: string | null
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  const { searchParams } = new URL(request.url)
  const limit = parseLimit(searchParams.get('limit'))
  if (limit === null) {
    return failure(400, 'INVALID_LIMIT', `limit must be a whole number from 1 to ${MAX_LIMIT}.`)
  }

  try {
    const page = await readIcpWriteReceiptPage({ cursor: searchParams.get('cursor'), limit })
    const data: ReceiptsResponse = {
      ...page,
      writesConfigured: writesConfigured(),
      canisterId: process.env.MEMORY_REPO_CANISTER_ID || null,
    }
    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      return failure(400, 'INVALID_CURSOR', error.message)
    }
    console.error(`memory_repo write receipts could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return failure(500, 'RECEIPTS_UNREADABLE', 'The server could not read its memory write receipts.')
  }
}

function parseLimit(value: string | null): number | null {
  if (value === null) return DEFAULT_LIMIT
  if (!/^\d{1,2}$/.test(value)) return null
  const limit = Number(value)
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null
}

/** Presence only: the key is not loaded here, so this says nothing about whether it works. */
function writesConfigured(): boolean {
  return Boolean(
    process.env.MEMORY_REPO_CANISTER_ID &&
      (process.env.AGENTVAULT_ICP_IDENTITY_PEM_FILE || process.env.AGENTVAULT_ICP_IDENTITY_PEM)
  )
}

function failure(status: number, code: string, message: string): NextResponse {
  return NextResponse.json(
    { success: false, error: { message, code } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  )
}
