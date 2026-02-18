import { NextRequest, NextResponse } from 'next/server'
import { deleteArchive, listAllArchiveRecords } from '@/archival/archive-manager.js'
import type { ArchiveMetadata } from '@/archival/archive-manager.js'

interface ArchiveRecordResponse {
  id: string
  status: 'prepared' | 'uploading' | 'completed' | 'failed'
  canisterId: string
  timestamp: string
  size: number
  checksum: string
  arweaveTxId?: string
  cost?: number
}

export async function GET(
  request: NextRequest
): Promise<NextResponse> {
  try {
    const url = new URL(request.url)
    const agentName = url.searchParams.get('agent')
    const records = listAllArchiveRecords(agentName ?? undefined)

    const response: ArchiveRecordResponse[] = records.map((record) => {
      const canisterId = record.tags.canisterId || record.tags['canister-id'] || ''

      return {
        id: record.id,
        status: toArchiveStatus(record.status),
        canisterId,
        timestamp: new Date(record.timestamp).toISOString(),
        size: record.sizeBytes,
        checksum: record.checksum,
        arweaveTxId: record.transactionId,
        cost: toCost(record.tags),
      }
    })

    return NextResponse.json({
      success: true,
      data: response,
    })
  } catch (_error) {
    return NextResponse.json({
      success: false,
      error: { message: 'Failed to fetch archives' },
    }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest
): Promise<NextResponse> {
  try {
    const body = await request.json()
    return NextResponse.json({
      success: false,
      error: { message: 'POST /archives is not supported in this build. Use /agents/[id]/archive' },
      details: body,
    }, { status: 405 })
  } catch (_error) {
    return NextResponse.json({ success: false, error: { message: 'Failed to create archive' } }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest
): Promise< NextResponse> {
  try {
    const archiveId = new URL(request.url).searchParams.get('id')

    if (!archiveId) {
      return NextResponse.json({
        success: false,
        error: { message: 'archive id is required' },
      }, { status: 400 })
    }

    const deleted = deleteArchive(archiveId)
    if (!deleted) {
      return NextResponse.json({
        success: false,
        error: { message: `Archive '${archiveId}' not found` },
      }, { status: 404 })
    }

    return NextResponse.json({
      success: true,
      data: { id: archiveId },
    })
  } catch (_error) {
    return NextResponse.json({
      success: false,
      error: { message: 'Failed to delete archive' },
    }, { status: 500 })
  }
}

function toArchiveStatus(status: ArchiveMetadata['status']): ArchiveRecordResponse['status'] {
  if (status === 'pending') {
    return 'prepared'
  }

  if (status === 'confirmed') {
    return 'completed'
  }

  if (status === 'failed') {
    return 'failed'
  }

  return status
}

function toCost(tags: Record<string, string>): number | undefined {
  const raw = tags['cost']
  if (!raw) {
    return undefined
  }

  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}
