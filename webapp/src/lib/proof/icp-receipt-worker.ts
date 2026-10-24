import type { IcpWriteReceipt } from '@/lib/types'
import { checkIcpReceipt, type IcpReceiptCheckResult } from './icp-receipt-check'

/*
 * The thread signed memory write receipts are checked on, started by
 * icp-receipt-runner.ts. The check's curve code is used only here, so it is
 * bundled with this worker instead of with every page, and a large receipt
 * does not hold up the page while it is checked. It answers each request with
 * the checker's result and nothing else.
 */

export interface ReceiptCheckRequest {
  id: number
  receipt: IcpWriteReceipt
  expectedCanisterId: string | null
}

export interface ReceiptCheckAnswer {
  id: number
  result: IcpReceiptCheckResult
}

addEventListener('message', (event: MessageEvent<ReceiptCheckRequest>) => {
  const { id, receipt, expectedCanisterId } = event.data
  const answer = (result: IcpReceiptCheckResult) => postMessage({ id, result } satisfies ReceiptCheckAnswer)
  // The check never rejects; should its answer fail to reach the page, the page still gets one, so its list of checks moves on.
  checkIcpReceipt(receipt, expectedCanisterId)
    .then(answer)
    .catch(() => answer({ state: 'check-failed', reason: 'The check did not finish.' }))
})
