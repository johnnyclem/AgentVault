import { describe, expect, it } from 'vitest';
import { publicBackupManifest, type BackupManifest } from '../../src/backup/backup.js';

function fullManifest(): BackupManifest {
  return {
    version: '1.1',
    agentName: 'research-scout',
    timestamp: new Date('2026-10-24T10:00:00Z'),
    created: new Date('2026-10-24T10:00:00Z'),
    agentConfig: { name: 'research-scout', apiKey: 'sk-secret' } as unknown as BackupManifest['agentConfig'],
    canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
    canisterState: {
      canisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai',
      status: 'running',
      fetchedAt: '2026-10-24T10:00:00Z',
      memory: { note: 'private memory' },
      tasks: [{ id: 't1' }],
      context: { user: 'jane' },
    },
    checksums: { 'research-scout.zip.enc': 'ab'.repeat(32) },
    size: 2048,
    components: ['agent', 'canister-state'],
    localEncryptedZipPath: '/home/jane/.agentvault/backups/research-scout.zip.enc',
    encryptedZipSha256: 'ab'.repeat(32),
    encryptedKey: { ciphertext: 'c0ffee', iv: '00', tag: '11' },
    keySignature: 'deadbeef',
  };
}

describe('publicBackupManifest', () => {
  it('publishes only the allow-listed fields', () => {
    const published = publicBackupManifest(fullManifest(), 'ab'.repeat(32));
    expect(Object.keys(published).sort()).toEqual(
      ['agentName', 'canisterId', 'checksums', 'components', 'created', 'encryptedZipSha256', 'size', 'version'].sort(),
    );
  });

  it('never carries the config, canister state, local path or wrapped key', () => {
    const text = JSON.stringify(publicBackupManifest(fullManifest(), 'ab'.repeat(32)));
    for (const leaked of ['sk-secret', 'private memory', 'jane', '/home/', 'c0ffee', 'deadbeef']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('omits canisterId when the backup has none', () => {
    const manifest = fullManifest();
    delete manifest.canisterId;
    expect(publicBackupManifest(manifest, 'ab'.repeat(32))).not.toHaveProperty('canisterId');
  });
});
