/**
 * The webapp's archive workflow (POST /api/agents/[id]/archive) from the
 * Arweave upload on: what it records once a node has answered the POST.
 * Acceptance is not mining, so an accepted upload must leave the record
 * pending with its transaction id, never confirmed, and the bytes posted must
 * hash to the checksum recorded for them, which is what the evidence page
 * checks against arweave.net/raw/{tx}.
 *
 * What is posted is public and permanent, so it must carry no local paths,
 * wallet details, backup or canister state: only the agent, its canister and
 * network, and a digest of each artifact (the token file's withheld).
 *
 * Packaging, deployment, backup, the agent store and the wallet store are
 * stand-ins. The archive store and ArweaveClient are the real modules, with
 * HOME pointed at a temporary directory and the real arweave library talking
 * to a stand-in gateway. Webapp modules are imported through a variable so the
 * root typecheck, which does not know the webapp's aliases, does not follow
 * them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { arweaveTestJwk, fakeArweaveGateway, sha256Hex, type FakeGateway } from '../fixtures/arweave-gateway.js';

const WEBAPP = vi.hoisted(() => '../../webapp/src');

const env = vi.hoisted(() => ({
  sourcePath: '',
  wallets: {} as Record<string, Record<string, unknown>>,
  deployCalls: 0,
}));

vi.mock('@/lib/server/agent-models.js', () => ({
  buildAgentModel: (agentId: string) => (agentId === 'agent-1' ? { id: 'agent-1', name: 'Agent One' } : null),
  readAgentConfigRecord: () => null,
  resolveAgentSourcePath: () => env.sourcePath,
  resolveProjectRoot: (sourcePath: string) => sourcePath,
}));
vi.mock('@/wallet/index.js', () => ({
  listAgentWallets: () => Object.keys(env.wallets),
  getWallet: (_agentId: string, walletId: string) => env.wallets[walletId] ?? null,
  generateWallet: vi.fn(),
  importWalletFromPrivateKey: vi.fn(),
  importWalletFromSeed: vi.fn(),
}));
vi.mock('@/archival/archive-manager.js', async () => await import('../../src/archival/archive-manager.js'));
vi.mock('@/archival/arweave-client.js', async () => await import('../../src/archival/arweave-client.js'));
vi.mock('@/backup/index.js', () => ({
  exportBackup: async () => ({
    success: true,
    path: '/home/alice/.agentvault/backups/agent-1.json',
    manifest: { canisterState: { tasks: ['private-task-text'] } },
  }),
}));
vi.mock('@/packaging/index.js', () => ({
  packageAgent: async () => ({ wasmPath: '/home/alice/build/agent-1.wasm', config: { version: '1.2.0' } }),
}));
vi.mock('@/deployment/index.js', () => ({
  deployAgent: async () => {
    env.deployCalls += 1;
    return { canister: { canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai' }, deployTool: 'icp', warnings: ['/home/alice/dfx.json'] };
  },
}));

interface Workflow {
  runArchiveWorkflow: (input: { agentId: string; profile: string }) => Promise<
    | { success: true; receipt: { archiveId: string; arweave?: { transactionId?: string } } }
    | { success: false; error: { code: string; message: string } }
  >;
  listAllArchiveRecords: (agentName?: string) => Array<Record<string, unknown>>;
}

const ARTIFACT_FILES: Record<string, string> = {
  'agent.json': '{"name":"Agent One"}',
  'skills.json': '{"skills":["search"]}',
  'token.json': '{"token":"tok-123"}',
  'soul.json': '{"tone":"calm"}',
  'memory.json': '{"notes":["met Alice"]}',
};

// The archive store reads HOME once, when it is first imported, and a mocked
// module survives vi.resetModules, so the whole file shares one temporary HOME
// and each test starts from an empty archives directory.
let tmp: string;
let archivesDir: string;
let gateway: FakeGateway;
let workflow: Workflow;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-archive-workflow-'));
  vi.stubEnv('HOME', path.join(tmp, 'home'));
  archivesDir = path.join(tmp, 'home', '.agentvault', 'archives');
  workflow = (await import(/* @vite-ignore */ `${WEBAPP}/lib/server/archive-workflow`)) as Workflow;
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(archivesDir, { recursive: true, force: true });

  env.sourcePath = path.join(tmp, 'agent');
  fs.rmSync(env.sourcePath, { recursive: true, force: true });
  fs.mkdirSync(env.sourcePath);
  for (const [file, content] of Object.entries(ARTIFACT_FILES)) {
    fs.writeFileSync(path.join(env.sourcePath, file), content);
  }
  env.deployCalls = 0;
  env.wallets = {
    'icp-1': { id: 'icp-1', agentId: 'agent-1', chain: 'icp', address: 'icp-address', creationMethod: 'generate', createdAt: 1, updatedAt: 1 },
    'ar-1': {
      id: 'ar-1',
      agentId: 'agent-1',
      chain: 'arweave',
      address: 'arweave-address',
      creationMethod: 'generate',
      createdAt: 1,
      updatedAt: 1,
      chainMetadata: { jwk: arweaveTestJwk() },
    },
  };

  gateway = fakeArweaveGateway();
  vi.stubGlobal('fetch', gateway.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runArchiveWorkflow upload', () => {
  it('leaves an accepted upload pending with its transaction id', async () => {
    const result = await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    expect(result.success).toBe(true);
    const [tx] = gateway.posted;
    expect(result.success && result.receipt.arweave?.transactionId).toBe(tx!.id);
    const records = workflow.listAllArchiveRecords('agent-1');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'pending', transactionId: tx!.id });
    expect(tx!.tags['agent-id']).toBe('agent-1');
  });

  it('records the SHA-256 and size of exactly the bytes it posted', async () => {
    await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    const [tx] = gateway.posted;
    const [record] = workflow.listAllArchiveRecords('agent-1');
    expect(sha256Hex(tx!.data)).toBe(record!['checksum']);
    expect(tx!.dataSize).toBe(record!['sizeBytes']);
  });

  it('gives up after 60 s on a gateway that never answers, and marks the record failed', async () => {
    gateway.hang.add('tx');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const run = workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });
      await vi.waitFor(() => expect(gateway.hung).toContain('tx'));
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await run;

      expect(result).toMatchObject({ success: false, error: { code: 'ARWEAVE_UPLOAD_FAILED' } });
      expect(!result.success && result.error.message).toContain('did not complete within 60s');
      const [record] = workflow.listAllArchiveRecords('agent-1');
      expect(record!['status']).toBe('failed');
      expect(record!['transactionId']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the record failed when the gateway rejects the upload', async () => {
    gateway.postStatus = 400;

    const result = await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    expect(result).toMatchObject({ success: false, error: { code: 'ARWEAVE_UPLOAD_FAILED' } });
    const [record] = workflow.listAllArchiveRecords('agent-1');
    expect(record!['status']).toBe('failed');
    expect(record!['transactionId']).toBeUndefined();
  });
});

describe('runArchiveWorkflow public payload', () => {
  function postedPayload(): { text: string; json: Record<string, unknown> } {
    const [tx] = gateway.posted;
    const text = tx!.data.toString('utf8');
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  }

  it('names the agent, canister and network, and nothing else', async () => {
    await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    const { json } = postedPayload();
    expect(Object.keys(json).sort()).toEqual(
      ['agentId', 'agentName', 'artifacts', 'canisterId', 'createdAt', 'format', 'network'].sort(),
    );
    expect(json).toMatchObject({
      format: 'agentvault-deployment-receipt-v1',
      agentId: 'agent-1',
      agentName: 'Agent One',
      canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
      network: 'local',
    });
  });

  it('publishes no local paths, wallet details, backup or canister state', async () => {
    await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    const { text } = postedPayload();
    expect(text).not.toContain(tmp);
    expect(text).not.toContain('/home/alice');
    expect(text).not.toContain('private-task-text');
    expect(text).not.toContain('icp-address');
    expect(text).not.toContain('arweave-address');
    for (const content of Object.values(ARTIFACT_FILES)) {
      expect(text).not.toContain(content);
    }
  });

  it('digests each artifact by name, size and SHA-256, withholding the token file\'s', async () => {
    await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    const digest = (kind: string, file: string) => ({
      kind,
      basename: file,
      sha256: sha256Hex(ARTIFACT_FILES[file]!),
      bytes: Buffer.byteLength(ARTIFACT_FILES[file]!),
    });
    expect(postedPayload().json['artifacts']).toEqual([
      digest('config', 'agent.json'),
      digest('skill', 'skills.json'),
      { kind: 'token', basename: 'token.json', sha256: null, bytes: null },
      digest('soul', 'soul.json'),
      digest('memory', 'memory.json'),
    ]);
  });

  it('records no digest for an artifact that is a directory', async () => {
    fs.rmSync(path.join(env.sourcePath, 'memory.json'));
    fs.mkdirSync(path.join(env.sourcePath, 'memory'));

    await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    const artifacts = postedPayload().json['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts.find((a) => a['kind'] === 'memory')).toEqual({ kind: 'memory', basename: 'memory', sha256: null, bytes: null });
  });

  it('stops before deploying when an artifact cannot be read', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const result = await workflow.runArchiveWorkflow({ agentId: 'agent-1', profile: 'other' });

    expect(result).toMatchObject({ success: false, error: { code: 'ARTIFACT_READ_FAILED' } });
    expect(env.deployCalls).toBe(0);
    expect(gateway.posted).toHaveLength(0);
  });
});
