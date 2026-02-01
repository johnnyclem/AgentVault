/**
 * Agent type detection logic
 *
 * Detects what type of agent is in a given directory based on
 * configuration files and directory structure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentType, AgentConfig } from './types.js';

/**
 * Configuration file patterns for each agent type
 */
const AGENT_PATTERNS: Record<AgentType, { files: string[]; dirs: string[] }> = {
  clawdbot: {
    files: ['clawdbot.json', 'clawdbot.config.json', '.clawdbot'],
    dirs: ['.clawdbot'],
  },
  goose: {
    files: ['goose.yaml', 'goose.yml', 'goose.config.yaml', '.gooserc'],
    dirs: ['.goose'],
  },
  cline: {
    files: ['cline.json', 'cline.config.json', '.cline'],
    dirs: ['.cline'],
  },
  generic: {
    files: ['agent.json', 'agent.yaml', 'agent.yml', 'agentvault.json'],
    dirs: [],
  },
};

/**
 * Check if a file exists at the given path
 */
function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a directory exists at the given path
 */
function directoryExists(dirPath: string): boolean {
  try {
    return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Try to read and parse a JSON config file
 */
function tryReadJsonConfig(
  filePath: string
): { name?: string; version?: string; entryPoint?: string } | null {
  try {
    if (!fileExists(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Detect the agent type from a source directory
 */
export function detectAgentType(sourcePath: string): AgentType {
  const absolutePath = path.resolve(sourcePath);

  // Check for specific agent types in order of precedence
  for (const agentType of ['clawdbot', 'goose', 'cline'] as AgentType[]) {
    const patterns = AGENT_PATTERNS[agentType];

    // Check for config files
    for (const file of patterns.files) {
      if (fileExists(path.join(absolutePath, file))) {
        return agentType;
      }
    }

    // Check for config directories
    for (const dir of patterns.dirs) {
      if (directoryExists(path.join(absolutePath, dir))) {
        return agentType;
      }
    }
  }

  // Default to generic if no specific agent type is detected
  return 'generic';
}

/**
 * Extract agent name from the source path or config
 */
function extractAgentName(sourcePath: string, config: Record<string, unknown> | null): string {
  // First, try to get name from config
  if (config && typeof config.name === 'string' && config.name.trim()) {
    return config.name.trim();
  }

  // Fall back to directory name
  const dirName = path.basename(path.resolve(sourcePath));

  // Sanitize the directory name
  return dirName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

/**
 * Find the configuration file for a detected agent type
 */
function findConfigFile(sourcePath: string, agentType: AgentType): string | null {
  const absolutePath = path.resolve(sourcePath);
  const patterns = AGENT_PATTERNS[agentType];

  for (const file of patterns.files) {
    const filePath = path.join(absolutePath, file);
    if (fileExists(filePath)) {
      return filePath;
    }
  }

  return null;
}

/**
 * Detect the entry point for the agent
 */
function detectEntryPoint(sourcePath: string, agentType: AgentType): string | undefined {
  const absolutePath = path.resolve(sourcePath);

  // Common entry point patterns
  const entryPoints = [
    'index.ts',
    'index.js',
    'main.ts',
    'main.js',
    'agent.ts',
    'agent.js',
    'src/index.ts',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
  ];

  // Agent-specific entry points
  if (agentType === 'clawdbot') {
    entryPoints.unshift('clawdbot.ts', 'clawdbot.js');
  } else if (agentType === 'goose') {
    entryPoints.unshift('goose.py', 'main.py');
  } else if (agentType === 'cline') {
    entryPoints.unshift('cline.ts', 'cline.js');
  }

  for (const entry of entryPoints) {
    const entryPath = path.join(absolutePath, entry);
    if (fileExists(entryPath)) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Detect agent configuration from a source directory
 */
export function detectAgent(sourcePath: string): AgentConfig {
  const absolutePath = path.resolve(sourcePath);

  // Detect agent type
  const agentType = detectAgentType(sourcePath);

  // Find and read config file
  const configFile = findConfigFile(sourcePath, agentType);
  const config = configFile ? tryReadJsonConfig(configFile) : null;

  // Extract name
  const name = extractAgentName(sourcePath, config);

  // Detect entry point
  const entryPoint = detectEntryPoint(sourcePath, agentType);

  return {
    name,
    type: agentType,
    sourcePath: absolutePath,
    entryPoint,
    version: config?.version,
  };
}

/**
 * Validate that the source path exists and is a directory
 */
export function validateSourcePath(sourcePath: string): { valid: boolean; error?: string } {
  const absolutePath = path.resolve(sourcePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      valid: false,
      error: `Source path does not exist: ${absolutePath}`,
    };
  }

  if (!fs.statSync(absolutePath).isDirectory()) {
    return {
      valid: false,
      error: `Source path is not a directory: ${absolutePath}`,
    };
  }

  return { valid: true };
}
