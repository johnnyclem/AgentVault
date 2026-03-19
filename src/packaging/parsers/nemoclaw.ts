import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from '../../debugging/debug-logger.js';
import type {
  NemoClawConfig,
  ConfigLocation,
  ConfigValidationResult,
} from '../config-schemas.js';

function findNemoClawConfig(sourcePath: string): ConfigLocation | null {
  const absolutePath = path.resolve(sourcePath);

  const configFiles = ['nemoclaw.json', 'nemoclaw.config.json', '.nemoclaw.json'];
  for (const file of configFiles) {
    const filePath = path.join(absolutePath, file);
    if (fs.existsSync(filePath)) {
      return {
        path: filePath,
        type: 'json',
      };
    }
  }

  // Check for config inside .nemoclaw directory
  const nemoClawDir = path.join(absolutePath, '.nemoclaw');
  if (fs.existsSync(nemoClawDir) && fs.statSync(nemoClawDir).isDirectory()) {
    const dirConfig = path.join(nemoClawDir, 'config.json');
    if (fs.existsSync(dirConfig)) {
      return {
        path: dirConfig,
        type: 'json',
      };
    }
  }

  return null;
}

function validateNemoClawConfig(config: NemoClawConfig): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.name || config.name.trim() === '') {
    errors.push('Agent name is required');
  }

  if (config.version) {
    const versionRegex = /^\d+\.\d+\.\d+$/;
    if (!versionRegex.test(config.version)) {
      errors.push(`Invalid version format: ${config.version}. Expected: X.Y.Z`);
    }
  }

  if (config.entryPoint) {
    const sourcePath = process.cwd();
    const entryPath = path.join(sourcePath, config.entryPoint);
    if (!fs.existsSync(entryPath)) {
      warnings.push(`Entry point does not exist: ${config.entryPoint}`);
    }
  }

  if (config.runtime && !['local', 'cloud', 'hybrid'].includes(config.runtime)) {
    errors.push(`Invalid runtime: ${config.runtime}. Expected: local, cloud, or hybrid`);
  }

  if (config.sandboxLevel && !['strict', 'standard', 'permissive'].includes(config.sandboxLevel)) {
    errors.push(`Invalid sandboxLevel: ${config.sandboxLevel}. Expected: strict, standard, or permissive`);
  }

  if (config.platform && !['geforce-rtx', 'rtx-pro', 'dgx-station', 'dgx-spark', 'auto'].includes(config.platform)) {
    errors.push(`Invalid platform: ${config.platform}. Expected: geforce-rtx, rtx-pro, dgx-station, dgx-spark, or auto`);
  }

  if (config.policies?.dataRetention && !['none', 'session', 'persistent'].includes(config.policies.dataRetention)) {
    errors.push(`Invalid dataRetention policy: ${config.policies.dataRetention}. Expected: none, session, or persistent`);
  }

  if (!config.entryPoint) {
    warnings.push('No entry point defined. Agent may not be executable.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export async function parseNemoClawConfig(
  sourcePath: string,
  _verbose: boolean = false
): Promise<NemoClawConfig> {
  debugLog(`[NemoClaw] Parsing configuration from: ${sourcePath}`);

  const configLocation = findNemoClawConfig(sourcePath);

  if (configLocation === null) {
    throw new Error(
      'No NemoClaw agent configuration found. ' +
        'Expected nemoclaw.json, nemoclaw.config.json, or .nemoclaw.json file in the agent source path.'
    );
  }

  debugLog(`[NemoClaw] Found ${configLocation.type.toUpperCase()} config: ${configLocation.path}`);

  let config: NemoClawConfig;

  try {
    const content = fs.readFileSync(configLocation.path, 'utf-8');
    const parsed = JSON.parse(content);

    config = {
      type: 'nemoclaw',
      name: parsed.name || 'nemoclaw-agent',
      version: parsed.version,
      description: parsed.description,
      entryPoint: parsed.entryPoint,
      model: parsed.model || 'nemotron-4-340b',
      runtime: parsed.runtime || 'local',
      sandboxLevel: parsed.sandboxLevel || 'standard',
      privacyRouter: parsed.privacyRouter ?? true,
      platform: parsed.platform || 'auto',
      skills: parsed.skills || [],
      policies: {
        networkAccess: parsed.policies?.networkAccess ?? false,
        filesystemWrite: parsed.policies?.filesystemWrite ?? false,
        dataRetention: parsed.policies?.dataRetention || 'session',
      },
    };

    debugLog(`[NemoClaw] Parsed name: ${config.name}`);
    debugLog(`[NemoClaw] Parsed version: ${config.version}`);
    debugLog(`[NemoClaw] Parsed entryPoint: ${config.entryPoint || 'none'}`);
    debugLog(`[NemoClaw] Parsed model: ${config.model}`);
    debugLog(`[NemoClaw] Parsed runtime: ${config.runtime}`);
    debugLog(`[NemoClaw] Parsed platform: ${config.platform}`);
    debugLog(`[NemoClaw] Parsed sandboxLevel: ${config.sandboxLevel}`);
    debugLog(`[NemoClaw] Parsed privacyRouter: ${config.privacyRouter}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to parse NemoClaw config: ${message}`);
  }

  const validation = validateNemoClawConfig(config);

  if (!validation.valid) {
    const errorMessage = `NemoClaw agent configuration validation failed:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`;
    throw new Error(errorMessage);
  }

  if (validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      debugLog(`[NemoClaw] Warning: ${warning}`);
    }
  }

  return config;
}

export function findNemoClawConfigs(rootPath: string): string[] {
  const configs: string[] = [];

  function searchDirectory(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git') {
          searchDirectory(fullPath);
        }
      } else if (entry.isFile()) {
        if (entry.name === 'nemoclaw.json' || entry.name === 'nemoclaw.config.json' || entry.name === '.nemoclaw.json') {
          configs.push(fullPath);
        }
      }
    }
  }

  searchDirectory(rootPath);
  return configs;
}
