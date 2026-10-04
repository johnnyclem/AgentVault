import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'
import { ArweaveClient } from '@/archival/arweave-client'

interface UploadRequest {
  data: string
  tags?: Record<string, string>
  metadata?: Record<string, unknown>
  jwk?: {
    kty: string
    n: string
    e: string
    d?: string
    p?: string
    q?: string
    dp?: string
    dq?: string
    qi?: string
  }
}

interface UploadResponse {
  txId: string
  url: string
  timestamp: string
  tags: Record<string, string>
  size: number
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  try {
    const body: UploadRequest = await request.json()
    
    if (!body.data) {
      return polyticianClientError(400, 'BAD_REQUEST', 'Missing required field: data')
    }

    if (!body.jwk) {
      return polyticianClientError(400, 'BAD_REQUEST', 'Missing required field: jwk (Arweave wallet)')
    }

    const protocol = (process.env.ARWEAVE_PROTOCOL || 'https') as 'https' | 'http'
    const client = new ArweaveClient({
      host: process.env.ARWEAVE_HOST || 'arweave.net',
      port: parseInt(process.env.ARWEAVE_PORT ?? '443', 10),
      protocol: (process.env.ARWEAVE_PROTOCOL as 'http' | 'https') || 'https',
    })

    const dataBuffer = Buffer.from(body.data, 'utf-8')
    
    const tags: Record<string, string> = {
      'Content-Type': 'application/json',
      'App-Name': 'AgentVault',
      ...body.tags,
    }
    
    if (body.metadata) {
      tags['X-AgentVault-Metadata'] = JSON.stringify(body.metadata)
    }

    const result = await client.uploadData(dataBuffer, body.jwk, { tags })

    if (!result.success || !result.transactionId) {
      return polyticianClientError(502, 'UPLOAD_FAILED', result.error ?? 'Upload failed')
    }

    const response: UploadResponse = {
      txId: result.transactionId,
      url: `https://arweave.net/${result.transactionId}`,
      timestamp: new Date().toISOString(),
      tags,
      size: dataBuffer.length,
    }

    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return polyticianClientError(500, 'INTERNAL_ERROR', message)
  }
}
