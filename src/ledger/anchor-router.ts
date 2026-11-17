/**
 * Where each stream is anchored.
 *
 * A stream anchors to the place it names (an owner's own canister, say), else to the place the
 * gateway was started with, else nowhere: a gateway with no default simply does not anchor a stream
 * nobody gave a place. The connection to each canister is made once and kept, and a failed
 * connection is tried again on the next pass.
 */

import type { AnchorRouter } from './anchor.js';
import { DEFAULT_LEDGER_BRANCH, MemoryRepoAnchor, type MemoryRepoPort } from './memory-repo-anchor.js';
import type { LedgerStore } from './store.js';

export interface DestinationRouterOptions {
  store: LedgerStore;
  /** Connects to a destination, which for this anchor is a canister id. */
  connect: (destination: string) => Promise<MemoryRepoPort>;
  /** Where a stream that names no place is anchored; when absent such a stream is not anchored. */
  defaultDestination?: string;
  branch?: string;
}

/** Where `stream` is anchored, or null when nowhere. */
export function destinationOf(store: LedgerStore, defaultDestination: string | undefined, stream: string): string | null {
  return store.anchorTarget(stream) ?? defaultDestination ?? null;
}

export function createDestinationRouter(options: DestinationRouterOptions): AnchorRouter {
  const { store, connect, defaultDestination, branch = DEFAULT_LEDGER_BRANCH } = options;
  const anchors = new Map<string, Promise<MemoryRepoAnchor>>();
  return (stream) => {
    const destination = destinationOf(store, defaultDestination, stream);
    if (!destination) return null;
    let anchor = anchors.get(destination);
    if (!anchor) {
      const connecting = connect(destination).then((port) => new MemoryRepoAnchor(port, branch));
      anchors.set(destination, connecting);
      // A connection that failed is not kept, so the next pass tries again.
      connecting.catch(() => anchors.delete(destination));
      anchor = connecting;
    }
    return anchor;
  };
}
