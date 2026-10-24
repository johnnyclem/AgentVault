import { NextRequest, NextResponse } from 'next/server'
import { buildAgentModel } from '@/lib/server/agent-models'
import { listAllArchiveRecords } from '@/lib/server/archive-workflow'
import { toReceipts } from '@/lib/proof/receipts'
import type { AgentEvidence } from '@/lib/types'

/*
 * The evidence the server holds for one agent: its Arweave receipts, as the
 * archive index recorded them. It sends no verdict. Whether a transaction was
 * mined and holds the recorded bytes is checked in the browser, against the
 * gateway, so nothing here can claim it.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id } = await params
    const agent = buildAgentModel(id)

    if (!agent) {
      return NextResponse.json(
        { success: false, error: { message: `No agent '${id}'`, code: 'AGENT_NOT_FOUND' } },
        { status: 404 }
      )
    }

    // The archive workflow records each archive under the agent's id.
    const evidence: AgentEvidence = {
      agentId: agent.id,
      agentName: agent.name,
      receipts: toReceipts(listAllArchiveRecords(agent.id)),
      generatedAt: new Date().toISOString(),
    }

    return NextResponse.json({ success: true, data: evidence })
  } catch (_error) {
    return NextResponse.json(
      { success: false, error: { message: 'The server could not read this agent or its archive records.' } },
      { status: 500 }
    )
  }
}
