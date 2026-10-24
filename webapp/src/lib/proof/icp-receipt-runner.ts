import type { IcpWriteReceipt } from '@/lib/types'
import type { IcpReceiptCheckResult } from './icp-receipt-check'
import type { ReceiptCheckAnswer, ReceiptCheckRequest } from './icp-receipt-worker'

/*
 * Runs signed memory write checks on a worker (icp-receipt-worker.ts), one
 * request per receipt. The checker is imported only by that worker, so its
 * curve code is not part of this page's bundle or the code every page shares.
 * A worker that cannot start, or that stops, answers each check it held as
 * one that could not be checked: never as verified.
 */

export interface ReceiptChecker {
  check(receipt: IcpWriteReceipt, expectedCanisterId: string | null): Promise<IcpReceiptCheckResult>
  /** Stops the worker; checks still waiting are never answered */
  dispose(): void
}

export const COULD_NOT_START = 'This browser could not start the check.'
export const STOPPED = 'The check stopped before it finished.'

export function createReceiptChecker(start: () => Worker = startWorker): ReceiptChecker {
  let worker: Worker | null = null
  let lastId = 0
  const waiting = new Map<number, (result: IcpReceiptCheckResult) => void>()

  function stop(reason: string) {
    worker?.terminate()
    worker = null
    for (const answer of waiting.values()) answer({ state: 'check-failed', reason })
    waiting.clear()
  }

  function running(): Worker {
    if (worker) return worker
    const started = start()
    started.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<ReceiptCheckAnswer> | null
      const answer = typeof data?.id === 'number' ? waiting.get(data.id) : undefined
      if (!answer || !data?.result) return
      waiting.delete(data.id as number)
      answer(data.result)
    }
    started.onerror = () => stop(STOPPED)
    started.onmessageerror = () => stop(STOPPED)
    worker = started
    return started
  }

  return {
    check(receipt, expectedCanisterId) {
      return new Promise((answer) => {
        const id = ++lastId
        try {
          const request: ReceiptCheckRequest = { id, receipt, expectedCanisterId }
          const target = running()
          waiting.set(id, answer)
          target.postMessage(request)
        } catch (error) {
          console.debug('Signed memory write receipt: the check could not start.', error)
          waiting.delete(id)
          answer({ state: 'check-failed', reason: COULD_NOT_START })
        }
      })
    },
    dispose() {
      worker?.terminate()
      worker = null
      waiting.clear()
    },
  }
}

function startWorker(): Worker {
  return new Worker(new URL('./icp-receipt-worker.ts', import.meta.url))
}
