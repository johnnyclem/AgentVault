'use client'

import { useCallback, useEffect, useReducer, useRef } from 'react'
import { apiClient } from '@/lib/api-client'
import { createReceiptChecker, type ReceiptChecker } from '@/lib/proof/icp-receipt-runner'
import {
  INITIAL_SIGNED_WRITES,
  PAGE_SIZE,
  SIGNED_WRITES_COPY,
  nextSignedWritesState,
  nextToCheck,
  readSignedWritesPage,
} from '@/lib/proof/signed-writes'

/**
 * Loads the deployment's signed memory write receipts, newest first, a page
 * at a time, and checks each one in this browser, one after another in list
 * order, on a worker. Large writes wait until the reader asks for them. The
 * server sends only what it recorded and the canister it names; no verdict
 * comes from it.
 */
export function useSignedWrites() {
  const [state, dispatch] = useReducer(nextSignedWritesState, INITIAL_SIGNED_WRITES)
  // Each load gets a number, so an answer for a load that was replaced (a
  // retry) cannot land in the list that replaced it.
  const latestLoad = useRef(0)
  // Started on the first check and stopped when the page goes away.
  const checker = useRef<ReceiptChecker | null>(null)

  useEffect(
    () => () => {
      checker.current?.dispose()
      checker.current = null
    },
    []
  )

  const load = useCallback(async () => {
    const generation = ++latestLoad.current
    dispatch({ type: 'load', generation })
    const res = await apiClient.get<unknown>(receiptsPath(null))
    const page = res.success ? readSignedWritesPage(res.data) : null
    if (page) dispatch({ type: 'loaded', generation, page })
    else dispatch({ type: 'load-failed', generation, error: res.error ?? { message: SIGNED_WRITES_COPY.unreadablePage } })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const { generation, nextCursor, canisterId } = state
  const olderStatus = state.older.status
  const loadOlder = useCallback(async () => {
    if (!nextCursor || olderStatus === 'loading') return
    const cursor = nextCursor
    dispatch({ type: 'load-older', generation, cursor })
    const res = await apiClient.get<unknown>(receiptsPath(cursor))
    const page = res.success ? readSignedWritesPage(res.data) : null
    if (page) dispatch({ type: 'loaded-older', generation, cursor, page })
    else {
      dispatch({ type: 'older-failed', generation, cursor, error: res.error ?? { message: SIGNED_WRITES_COPY.unreadablePage } })
    }
  }, [generation, nextCursor, olderStatus])

  const checkLarge = useCallback((index: number) => dispatch({ type: 'check-requested', generation, index }), [generation])

  // The next receipt in line, started only once the one before it has a
  // result. Starting it from a timer lets the browser paint and take input
  // between checks. A null in the server's list is still checked, and reads
  // as a receipt that cannot be read.
  const index = nextToCheck(state)
  const receipt = index === null ? undefined : state.receipts[index]
  useEffect(() => {
    if (index === null || receipt === undefined) return
    const timer = setTimeout(() => {
      dispatch({ type: 'check-started', generation, index })
      checker.current ??= createReceiptChecker()
      checker.current
        .check(receipt, canisterId)
        .then((result) => dispatch({ type: 'checked', generation, index, result }))
    }, 0)
    return () => clearTimeout(timer)
  }, [generation, index, receipt, canisterId])

  return { state, retry: load, loadOlder, checkLarge }
}

function receiptsPath(cursor: string | null): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) })
  if (cursor) query.set('cursor', cursor)
  return `/memory-repo/receipts?${query}`
}
