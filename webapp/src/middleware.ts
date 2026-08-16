import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken, unauthorizedResponse } from '@/lib/server/auth'

/**
 * Authentication gate for the API surface.
 *
 * This runs before every `/api/*` route and is deliberately fail-closed: a
 * route is protected unless its path is listed in PUBLIC_API_PATHS below.
 * Previously each route opted *in* by calling validateAuthToken itself, and 24
 * of 50 routes never did — including ones that write to the filesystem and
 * shell out to `dfx`. Defaulting to "protected" means a newly added route
 * cannot be forgotten into being public.
 *
 * Note that this gate is all-or-nothing: the token grants access to the whole
 * API. It is a deployment guard, not an authorization model — it does not
 * scope access per agent, per wallet, or per operation.
 */

/**
 * Paths served without a token. Empty by design: every current endpoint reads
 * or mutates agent, wallet, backup or deployment state. Add a path here only
 * after confirming it exposes nothing sensitive.
 */
const PUBLIC_API_PATHS = new Set<string>([])

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl

  if (PUBLIC_API_PATHS.has(pathname)) {
    return NextResponse.next()
  }

  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return unauthorizedResponse(authResult.error ?? 'Unauthorized')
  }

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
