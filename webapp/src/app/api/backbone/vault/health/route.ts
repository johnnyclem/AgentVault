import { NextResponse } from 'next/server'
import { getVaultHealthService } from '@/lib/server/backbone'

export async function GET(): Promise<NextResponse> {
  const service = getVaultHealthService()
  const health = await service.check()

  const status = health.configured && !health.healthy ? 503 : 200
  return NextResponse.json(health, { status })
}
