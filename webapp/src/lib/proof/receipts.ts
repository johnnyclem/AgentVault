import type { ArchiveMetadata } from '@/archival/archive-manager.js'
import type { ArweaveReceipt } from '@/lib/types'

/*
 * Turns the archive index's records into the receipts the Evidence page lists.
 * A record is a receipt only once it has a transaction id: without one nothing
 * reached Arweave. The index's 'confirmed' and 'pending' both become
 * 'submitted', because the server wrote 'confirmed' as soon as the gateway
 * accepted the upload and never checked that the transaction was mined.
 * Imports stay type-only so the root test suite can load this file by path.
 */
export function toReceipts(records: readonly ArchiveMetadata[]): ArweaveReceipt[] {
  return records.filter(hasTransaction).map((record) => ({
    archiveId: record.id,
    txId: record.transactionId,
    checksum: record.checksum,
    sizeBytes: record.sizeBytes,
    recordedAt: toIso(record.timestamp),
    recordedStatus: toRecordedStatus(record.status),
  }))
}

function hasTransaction(record: ArchiveMetadata): record is ArchiveMetadata & { transactionId: string } {
  return typeof record.transactionId === 'string' && record.transactionId.length > 0
}

// A record with a transaction id was accepted by the gateway, so anything the
// index does not mark as uploading or failed reads as submitted.
function toRecordedStatus(status: ArchiveMetadata['status']): ArweaveReceipt['recordedStatus'] {
  if (status === 'failed' || status === 'uploading') return status
  return 'submitted'
}

// The index is YAML on disk, so the time may come back as a Date or a string.
function toIso(value: Date | string): string | null {
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}
