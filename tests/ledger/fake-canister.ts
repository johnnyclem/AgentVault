import type { MemoryRepoHistoryPort, MemoryRepoPort, RepoCommit } from '../../src/ledger/index.js';

interface StoredCommit extends RepoCommit {
  message: string;
  tags: string[];
}

/**
 * A memory_repo held in memory, following the canister's rules: `initRepo` makes a genesis
 * commit on `main`; a branch starts at its base's head; a commit's parent is its branch's head
 * and it becomes the new head. Plays both parts the ledger needs, writing checkpoints as an
 * anchor and being read back as history.
 */
export class FakeCanister implements MemoryRepoPort, MemoryRepoHistoryPort {
  readonly canisterId = 'aaaaa-aa';
  readonly network = 'local' as const;
  readonly commits: StoredCommit[] = [];
  readonly heads = new Map<string, string>();
  private clock = 1_700_000_000_000_000_000n;

  constructor(options: { initialized?: boolean } = {}) {
    if (options.initialized ?? true) this.append('main', 'Genesis: Initialize from Soul.md', '# soul', ['genesis']);
  }

  /** What `commitToBranch` does: parent is the branch head, and the commit becomes it. */
  append(branch: string, message: string, diff: string, tags: string[]): string {
    const id = `c_${this.commits.length + 1}`;
    this.commits.push({ id, parent: this.heads.get(branch) ?? null, branch, timestamp: (this.clock += 1_000_000_000n), diff, message, tags });
    this.heads.set(branch, id);
    return id;
  }

  async branches(): Promise<string[]> {
    return [...this.heads.keys()];
  }

  async createBranch(name: string, base: string): Promise<void> {
    const head = this.heads.get(base);
    if (!head) throw new Error(`Branch '${base}' has no commits`);
    if (this.heads.has(name)) throw new Error(`Branch '${name}' already exists`);
    this.heads.set(name, head);
  }

  async commit(branch: string, message: string, diff: string, tags: string[]): Promise<{ commitId: string; receipt: null }> {
    if (!this.heads.has(branch)) throw new Error(`Branch '${branch}' does not exist`);
    return { commitId: this.append(branch, message, diff, tags), receipt: null };
  }

  async commitDiff(commitId: string): Promise<string | null> {
    return this.commits.find((commit) => commit.id === commitId)?.diff ?? null;
  }

  async branchHeads(): Promise<Map<string, string>> {
    return new Map(this.heads);
  }

  async getCommit(commitId: string): Promise<RepoCommit | null> {
    const found = this.commits.find((commit) => commit.id === commitId);
    return found ? { id: found.id, parent: found.parent, branch: found.branch, timestamp: found.timestamp, diff: found.diff } : null;
  }
}
