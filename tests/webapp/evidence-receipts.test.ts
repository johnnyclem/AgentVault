/**
 * The receipts mapper behind the Evidence page (webapp/src/lib/proof/receipts.ts):
 * archive index records in, Arweave receipts out. Only records with a
 * transaction id become receipts. The index's 'confirmed' and 'pending' both
 * become 'submitted', since the server never checked that anything was mined,
 * and nothing the index holds beyond the receipt's own fields is passed on.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';

interface Receipt {
  archiveId: string;
  txId: string;
  checksum: string;
  sizeBytes: number;
  recordedAt: string | null;
  recordedStatus: 'submitted' | 'uploading' | 'failed';
}

interface ReceiptsModule {
  toReceipts: (records: Array<Record<string, unknown>>) => Receipt[];
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'receipts.ts');
let receipts: ReceiptsModule;

beforeAll(async () => {
  receipts = (await import(MODULE)) as ReceiptsModule;
});

const TX = 'bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U';
const CHECKSUM = 'c'.repeat(64);

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'archive-1761300000000-1a2b3c4d',
    agentName: 'research-agent',
    agentVersion: '1.0.0',
    transactionId: TX,
    timestamp: new Date('2026-10-22T10:00:00.000Z'),
    sizeBytes: 2048,
    checksum: CHECKSUM,
    tags: { canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', error: 'something' },
    status: 'pending',
    blockHeight: 1_200_137,
    ...overrides,
  };
}

describe('toReceipts', () => {
  it('maps a record to exactly the receipt fields, dropping tags, version and block height', () => {
    expect(receipts.toReceipts([record()])).toEqual([
      {
        archiveId: 'archive-1761300000000-1a2b3c4d',
        txId: TX,
        checksum: CHECKSUM,
        sizeBytes: 2048,
        recordedAt: '2026-10-22T10:00:00.000Z',
        recordedStatus: 'submitted',
      },
    ]);
  });

  it('keeps only records that have a transaction id', () => {
    const mapped = receipts.toReceipts([
      record({ id: 'with-tx' }),
      record({ id: 'staged', transactionId: undefined }),
      record({ id: 'empty-tx', transactionId: '' }),
      record({ id: 'failed-before-upload', transactionId: undefined, status: 'failed' }),
    ]);

    expect(mapped.map((receipt) => receipt.archiveId)).toEqual(['with-tx']);
  });

  it('labels confirmed and pending as submitted, and keeps uploading and failed', () => {
    const statuses = ['confirmed', 'pending', 'uploading', 'failed'].map(
      (status) => receipts.toReceipts([record({ status })])[0]?.recordedStatus,
    );

    expect(statuses).toEqual(['submitted', 'submitted', 'uploading', 'failed']);
  });

  it('never passes on a status of confirmed, whatever the index says', () => {
    const mapped = receipts.toReceipts(
      ['confirmed', 'pending', 'uploading', 'failed', 'mined', undefined].map((status) => record({ status })),
    );

    expect(mapped.map((receipt) => receipt.recordedStatus)).not.toContain('confirmed');
  });

  it('reads the time whether the YAML index gave back a Date or a string', () => {
    const [fromDate, fromString] = receipts.toReceipts([
      record({ timestamp: new Date('2026-10-22T10:00:00.000Z') }),
      record({ timestamp: '2026-10-23T09:30:00Z' }),
    ]);

    expect(fromDate?.recordedAt).toBe('2026-10-22T10:00:00.000Z');
    expect(fromString?.recordedAt).toBe('2026-10-23T09:30:00.000Z');
  });

  it('gives a null time for a record whose time does not parse, rather than dropping it or throwing', () => {
    const mapped = receipts.toReceipts([record({ timestamp: 'yesterday-ish' }), record({ timestamp: undefined })]);

    expect(mapped.map((receipt) => receipt.recordedAt)).toEqual([null, null]);
  });

  it('passes the recorded checksum and size through untouched, for the browser to validate', () => {
    const [mapped] = receipts.toReceipts([record({ checksum: 'sha256-not-hex', sizeBytes: -5 })]);

    expect(mapped?.checksum).toBe('sha256-not-hex');
    expect(mapped?.sizeBytes).toBe(-5);
  });

  it('returns nothing for an empty index', () => {
    expect(receipts.toReceipts([])).toEqual([]);
  });
});
