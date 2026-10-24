/**
 * The page's side of the receipt check worker
 * (webapp/src/lib/proof/icp-receipt-runner.ts): each check goes to the
 * worker with the canister the server names and is answered by the worker's
 * reply to that request alone. A worker that cannot start, or that stops,
 * answers every check it held as one that could not be checked, never as
 * verified, and the next check starts a fresh worker.
 */

import { describe, it, expect, beforeAll, afterAll, vi, type MockInstance } from 'vitest';
import { join } from 'node:path';

type Result = { state: string; [field: string]: unknown };

interface Request {
  id: number;
  receipt: unknown;
  expectedCanisterId: string | null;
}

/** Stands in for a Worker: records what it is sent, and lets a test answer or fail it */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  sent: Request[] = [];
  terminated = false;

  postMessage(request: Request) {
    this.sent.push(request);
  }

  terminate() {
    this.terminated = true;
  }

  answer(id: number, result: unknown) {
    this.onmessage?.({ data: { id, result } });
  }
}

interface RunnerModule {
  createReceiptChecker: (start: () => FakeWorker) => {
    check: (receipt: unknown, expectedCanisterId: string | null) => Promise<Result>;
    dispose: () => void;
  };
  COULD_NOT_START: string;
  STOPPED: string;
}

// Loaded by path, so the root typecheck does not compile the webapp (its @/ imports resolve only under webapp/tsconfig.json)
const MODULE = join(import.meta.dirname, '..', '..', 'webapp', 'src', 'lib', 'proof', 'icp-receipt-runner.ts');
const NAMED = 'rrkah-fqaaa-aaaaa-aaaaq-cai';
const VERIFIED: Result = { state: 'verified', keyType: 'ed25519' };
const FAILED: Result = { state: 'signature-invalid', keyType: 'ed25519' };

let runner: RunnerModule;
let debug: MockInstance<typeof console.debug>;

beforeAll(async () => {
  runner = (await import(MODULE)) as RunnerModule;
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterAll(() => {
  debug.mockRestore();
});

/** A checker over fake workers, and the workers it started so far */
function setup() {
  const workers: FakeWorker[] = [];
  const checker = runner.createReceiptChecker(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { checker, workers };
}

describe('createReceiptChecker', () => {
  it('starts one worker on the first check and sends it the receipt with the canister the server names', async () => {
    const { checker, workers } = setup();
    const receipt = { id: 'r0' };

    const pending = checker.check(receipt, NAMED);
    checker.check({ id: 'r1' }, NAMED);

    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent).toEqual([
      { id: 1, receipt, expectedCanisterId: NAMED },
      { id: 2, receipt: { id: 'r1' }, expectedCanisterId: NAMED },
    ]);
    workers[0]!.answer(1, VERIFIED);
    expect(await pending).toEqual(VERIFIED);
  });

  it('answers each check with the reply to its own request, in whatever order they come', async () => {
    const { checker, workers } = setup();
    const first = checker.check({ id: 'r0' }, NAMED);
    const second = checker.check({ id: 'r1' }, NAMED);

    workers[0]!.answer(2, FAILED);
    workers[0]!.answer(1, VERIFIED);

    expect(await first).toEqual(VERIFIED);
    expect(await second).toEqual(FAILED);
  });

  it('ignores a reply for no request it sent, or one already answered', async () => {
    const { checker, workers } = setup();
    const pending = checker.check({ id: 'r0' }, NAMED);
    const worker = workers[0]!;

    worker.answer(99, VERIFIED);
    worker.onmessage?.({ data: null });
    worker.onmessage?.({ data: { id: 1 } });
    worker.answer(1, FAILED);
    worker.answer(1, VERIFIED);

    expect(await pending).toEqual(FAILED);
  });

  it.each(['onerror', 'onmessageerror'] as const)(
    'answers every check a stopped worker held (%s) as not checked, and starts a fresh worker for the next',
    async (event) => {
      const { checker, workers } = setup();
      const first = checker.check({ id: 'r0' }, NAMED);
      const second = checker.check({ id: 'r1' }, NAMED);

      workers[0]![event]?.({});

      expect(await first).toEqual({ state: 'check-failed', reason: runner.STOPPED });
      expect(await second).toEqual({ state: 'check-failed', reason: runner.STOPPED });
      expect(workers[0]!.terminated).toBe(true);
      // A late reply from the stopped worker changes nothing.
      workers[0]!.answer(1, VERIFIED);

      const third = checker.check({ id: 'r2' }, NAMED);
      expect(workers).toHaveLength(2);
      workers[1]!.answer(3, VERIFIED);
      expect(await third).toEqual(VERIFIED);
    },
  );

  it('answers a check as not checked when no worker can be started', async () => {
    const checker = runner.createReceiptChecker(() => {
      throw new Error('Worker is not defined');
    });

    expect(await checker.check({ id: 'r0' }, NAMED)).toEqual({ state: 'check-failed', reason: runner.COULD_NOT_START });
  });

  it('answers a check as not checked when the receipt cannot be sent to the worker', async () => {
    const { checker, workers } = setup();
    const pending = checker.check({ id: 'r0' }, NAMED);
    workers[0]!.postMessage = () => {
      throw new Error('DataCloneError');
    };

    expect(await checker.check({ id: 'r1' }, NAMED)).toEqual({ state: 'check-failed', reason: runner.COULD_NOT_START });
    workers[0]!.answer(1, VERIFIED);
    expect(await pending).toEqual(VERIFIED);
  });

  it('stops the worker when the page goes away, and answers nothing after', async () => {
    const { checker, workers } = setup();
    const answered = vi.fn();
    checker.check({ id: 'r0' }, NAMED).then(answered);

    checker.dispose();
    workers[0]!.answer(1, VERIFIED);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(workers[0]!.terminated).toBe(true);
    expect(answered).not.toHaveBeenCalled();
  });
});
