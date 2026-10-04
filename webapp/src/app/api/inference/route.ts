import { NextRequest, NextResponse } from 'next/server'
import { validateAuthToken } from '@/lib/server/auth'
import { polyticianClientError } from '@/lib/server/polytician-client'
import { InferenceFallbackChain, type FallbackInferenceRequest, type InferenceProvider } from '@/inference/fallback-chain'

interface AVInferRequest {
  prompt: string
  preferredBackend?: InferenceProvider
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

interface AVInferResponse {
  text: string
  backend: InferenceProvider
  latencyMs: number
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResult = validateAuthToken(request)
  if (!authResult.authorized) {
    return polyticianClientError(401, 'UNAUTHORIZED', authResult.error ?? 'Unauthorized')
  }

  try {
    const body: AVInferRequest = await request.json()
    
    if (!body.prompt) {
      return polyticianClientError(400, 'BAD_REQUEST', 'Missing required field: prompt')
    }

    const disableProviders: InferenceProvider[] = []
    if (body.preferredBackend) {
      const allProviders: InferenceProvider[] = ['bittensor', 'venice', 'local']
      for (const p of allProviders) {
        if (p !== body.preferredBackend) {
          disableProviders.push(p)
        }
      }
    }

    const chain = new InferenceFallbackChain({
      disableProviders,
      venice: {
        apiKey: process.env.VENICE_API_KEY,
      },
      localModel: {
        endpoint: process.env.LOCAL_MODEL_ENDPOINT || 'http://localhost:11434',
      },
    })

    const inferRequest: FallbackInferenceRequest = {
      prompt: body.prompt,
      maxTokens: body.maxTokens,
      temperature: body.temperature,
      systemPrompt: body.systemPrompt,
    }

    const result = await chain.infer(inferRequest)

    if (!result.success || !result.text || !result.provider) {
      return polyticianClientError(502, 'INFERENCE_FAILED', result.error ?? 'All inference providers failed', result.attemptsLog)
    }

    const response: AVInferResponse = {
      text: result.text,
      backend: result.provider,
      latencyMs: result.responseTime ?? 0,
    }

    return NextResponse.json({ success: true, data: response })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return polyticianClientError(500, 'INTERNAL_ERROR', message)
  }
}
