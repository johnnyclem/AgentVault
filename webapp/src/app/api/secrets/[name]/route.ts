import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'

const SECRETS_PROVIDER = process.env.SECRETS_PROVIDER || 'environment'

interface SecretResponse {
  name: string
  value: string
  provider: string
  rotatedAt?: string
}

async function getSecretFromProvider(name: string): Promise<{ value: string; rotatedAt?: string } | null> {
  if (SECRETS_PROVIDER === 'hashicorp') {
    const vaultAddr = process.env.VAULT_ADDR
    const vaultToken = process.env.VAULT_TOKEN
    
    if (!vaultAddr || !vaultToken) {
      return null
    }
    
    try {
      const response = await fetch(`${vaultAddr}/v1/secret/data/${name}`, {
        headers: {
          'X-Vault-Token': vaultToken,
        },
      })
      
      if (!response.ok) {
        return null
      }
      
      const data = await response.json() as { data?: { data?: { value?: string; rotated_at?: string } } }
      const secretData = data.data?.data
      
      if (!secretData?.value) {
        return null
      }
      
      return {
        value: secretData.value,
        rotatedAt: secretData.rotated_at,
      }
    } catch {
      return null
    }
  }
  
  const value = process.env[name]
  if (!value) {
    return null
  }
  
  return { value }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  const { name } = await params

  try {
    const secret = await getSecretFromProvider(name)
    
    if (!secret) {
      return polyticianClientError(404, 'SECRET_NOT_FOUND', `Secret not found: ${name}`)
    }

    const response: SecretResponse = {
      name,
      value: secret.value,
      provider: SECRETS_PROVIDER,
      rotatedAt: secret.rotatedAt,
    }

    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return polyticianClientError(500, 'INTERNAL_ERROR', message)
  }
}
