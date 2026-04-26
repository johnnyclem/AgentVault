import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { exportBackup } from '../backup/index.js';
import {
  prepareArchive,
  markArchiveUploading,
  updateArchiveTransaction,
  confirmArchive,
  failArchive,
  getArchiveData,
} from '../archival/archive-manager.js';
import { ArweaveClient, type JWKInterface } from '../archival/arweave-client.js';
import { generateStubCanisterId } from '../deployment/index.js';

export type GoogleAdkTemplate = 'loop-agent' | 'workflow-agent' | 'sequential-agent' | 'parallel-agent';

export interface MintGoogleAdkAgentOptions {
  agentName: string;
  template: GoogleAdkTemplate;
  targetRoot?: string;
  installAdk?: boolean;
  arweaveJwkPath?: string;
}

export interface MintGoogleAdkAgentResult {
  agentDir: string;
  canisterId: string;
  backupPath: string;
  archiveId?: string;
  arweaveTransactionId?: string;
  adkInstalled: boolean;
  warnings: string[];
}

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

async function ensureGoogleAdkAvailable(installIfMissing: boolean): Promise<{ installed: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const pythonBins = ['python3', 'python'];

  for (const pythonBin of pythonBins) {
    const show = await execa(pythonBin, ['-m', 'pip', 'show', 'google-adk'], { reject: false });
    if (show.exitCode === 0) {
      return { installed: true, warnings };
    }

    if (!installIfMissing) {
      continue;
    }

    const install = await execa(
      pythonBin,
      ['-m', 'pip', 'install', 'google-adk', 'google-a2a'],
      { reject: false },
    );

    if (install.exitCode === 0) {
      return { installed: true, warnings };
    }

    warnings.push(`Failed to install Google ADK with ${pythonBin}: ${install.stderr || install.stdout}`);
  }

  warnings.push('Google ADK is not available. Install manually with: python3 -m pip install google-adk google-a2a');
  return { installed: false, warnings };
}

function buildTemplateSource(agentName: string, template: GoogleAdkTemplate): string {
  const strategyMap: Record<GoogleAdkTemplate, string> = {
    'loop-agent': 'loop',
    'workflow-agent': 'workflow',
    'sequential-agent': 'sequential',
    'parallel-agent': 'parallel',
  };

  return `"""${agentName}: Google ADK + A2A compatible scaffold."""

from dataclasses import dataclass

@dataclass
class AgentContext:
    task: str

class ${agentName.replace(/-/g, '_')}Agent:
    strategy = "${strategyMap[template]}"

    def run(self, context: AgentContext) -> str:
        return f"[${template}] handled task: {context.task}"

if __name__ == "__main__":
    agent = ${agentName.replace(/-/g, '_')}Agent()
    print(agent.run(AgentContext(task="hello from agentvault")))
`;
}

function writeScaffoldFiles(agentDir: string, agentName: string, template: GoogleAdkTemplate, canisterId: string): void {
  const agentVaultDir = path.join(agentDir, '.agentvault');
  const configDir = path.join(agentVaultDir, 'config');
  const backupDir = path.join(agentVaultDir, 'backups');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const manifest = {
    name: agentName,
    protocol: 'a2a',
    framework: 'google-adk',
    template,
    canisterId,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(agentDir, 'agent.py'), buildTemplateSource(agentName, template), 'utf8');
  fs.writeFileSync(path.join(agentDir, 'requirements.txt'), 'google-adk\ngoogle-a2a\n', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'a2a-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(configDir, 'agent.config.json'),
    JSON.stringify(
      {
        name: agentName,
        type: `google-adk-${template}`,
        canisterId,
        description: `Scaffolded Google ADK ${template}`,
        createdAt: Date.now(),
      },
      null,
      2,
    ),
    'utf8',
  );
}

async function createBirthdayBackup(agentDir: string, agentName: string, canisterId: string): Promise<string> {
  const backupPath = path.join(agentDir, '.agentvault', 'backups', 'birthday-backup.json');
  const backupResult = await exportBackup({
    agentName,
    outputPath: backupPath,
    canisterId,
    includeCanisterState: false,
  });

  if (!backupResult.success || !backupResult.path) {
    throw new Error(backupResult.error || 'Failed to create birthday backup');
  }

  return backupResult.path;
}

async function createArweaveBirthdayArchive(
  agentName: string,
  template: GoogleAdkTemplate,
  canisterId: string,
  backupPath: string,
  arweaveJwkPath?: string,
): Promise<{ archiveId?: string; transactionId?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const archivePayload = {
    kind: 'birthday-backup',
    agentName,
    template,
    canisterId,
    backupPath,
    createdAt: new Date().toISOString(),
  };

  const prepared = prepareArchive(agentName, '1.0.0', archivePayload, {
    tags: {
      birthday: 'true',
      framework: 'google-adk',
      template,
    },
  });

  if (!prepared.success || !prepared.archiveId) {
    warnings.push(prepared.error || 'Failed to prepare Arweave archive');
    return { warnings };
  }

  if (!arweaveJwkPath) {
    warnings.push('Arweave wallet not provided. Archive prepared locally but not uploaded.');
    return { archiveId: prepared.archiveId, warnings };
  }

  try {
    const data = getArchiveData(prepared.archiveId);
    if (!data) {
      throw new Error('Prepared archive data was not found on disk.');
    }

    const jwk = JSON.parse(fs.readFileSync(arweaveJwkPath, 'utf8')) as JWKInterface;
    const client = new ArweaveClient();
    markArchiveUploading(prepared.archiveId);

    const upload = await client.uploadJSON(data, jwk, {
      tags: {
        'App-Name': 'AgentVault',
        'Agent-Name': agentName,
        'Canister-ID': canisterId,
        Birthday: 'true',
      },
    });

    if (!upload.success || !upload.transactionId) {
      failArchive(prepared.archiveId, upload.error || 'Upload failed');
      warnings.push(upload.error || 'Failed to upload birthday archive to Arweave');
      return { archiveId: prepared.archiveId, warnings };
    }

    updateArchiveTransaction(prepared.archiveId, upload.transactionId);
    confirmArchive(prepared.archiveId);
    return { archiveId: prepared.archiveId, transactionId: upload.transactionId, warnings };
  } catch (error) {
    failArchive(prepared.archiveId, error instanceof Error ? error.message : 'Unknown error');
    warnings.push(`Arweave upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { archiveId: prepared.archiveId, warnings };
  }
}

export async function mintGoogleAdkAgent(options: MintGoogleAdkAgentOptions): Promise<MintGoogleAdkAgentResult> {
  const warnings: string[] = [];
  const agentName = normalizeAgentName(options.agentName);

  if (!agentName) {
    throw new Error('Agent name is required');
  }

  const targetRoot = options.targetRoot ?? process.cwd();
  const agentDir = path.resolve(targetRoot, agentName);

  if (fs.existsSync(agentDir) && fs.readdirSync(agentDir).length > 0) {
    throw new Error(`Target directory is not empty: ${agentDir}`);
  }

  fs.mkdirSync(agentDir, { recursive: true });

  const adkStatus = await ensureGoogleAdkAvailable(options.installAdk !== false);
  warnings.push(...adkStatus.warnings);

  const canisterId = generateStubCanisterId();
  writeScaffoldFiles(agentDir, agentName, options.template, canisterId);

  const backupPath = await createBirthdayBackup(agentDir, agentName, canisterId);
  const archive = await createArweaveBirthdayArchive(
    agentName,
    options.template,
    canisterId,
    backupPath,
    options.arweaveJwkPath,
  );
  warnings.push(...archive.warnings);

  return {
    agentDir,
    canisterId,
    backupPath,
    archiveId: archive.archiveId,
    arweaveTransactionId: archive.transactionId,
    adkInstalled: adkStatus.installed,
    warnings,
  };
}
