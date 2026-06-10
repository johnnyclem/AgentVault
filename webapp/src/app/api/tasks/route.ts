import { NextResponse } from 'next/server'

export async function GET(): Promise<NextResponse> {
  try {
    // Task tracking is not yet backed by a canister; return an empty list so
    // the dashboard renders its empty state instead of an error.
    const tasks: unknown[] = []
    return NextResponse.json({ success: true, data: tasks })
  } catch (_error) {
    return NextResponse.json({ success: false, error: { message: 'Failed to fetch tasks' } }, { status: 500 })
  }
}
