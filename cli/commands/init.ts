/**
 * Init command - Initialize a new AgentVault project
 *
 * Supports the documented quick-start flow:
 *   npx agentvault@latest init my-agent --template default
 *
 * If the positional argument names a directory that does not exist yet, a new
 * project is scaffolded there from the chosen template. If it names an
 * existing directory (or is omitted), that directory is initialized in place.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Command } from 'commander';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';

export type ProjectTemplate = 'default' | 'minimal';

export const PROJECT_TEMPLATES: ProjectTemplate[] = ['default', 'minimal'];

export interface InitOptions {
  name?: string;
  template?: string;
  force?: boolean;
  yes?: boolean;
  verbose?: boolean;
  v?: boolean;
}

export interface InitAnswers {
  name: string;
  description: string;
  confirm: boolean;
}

const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;

export function sanitizeAgentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'my-agent';
}

export async function promptForInitOptions(options: InitOptions): Promise<InitAnswers | null> {
  // If --yes flag is provided, use defaults
  if (options.yes) {
    return {
      name: options.name ?? 'my-agent',
      description: 'An AgentVault agent',
      confirm: true,
    };
  }

  const answers = await inquirer.prompt<InitAnswers>([
    {
      type: 'input',
      name: 'name',
      message: 'What is the name of your agent?',
      default: options.name ?? 'my-agent',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Agent name is required';
        }
        if (!AGENT_NAME_PATTERN.test(input)) {
          return 'Agent name must be lowercase alphanumeric with hyphens only';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'description',
      message: 'Provide a description for your agent:',
      default: 'An AgentVault agent',
    },
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Create agent with these settings?',
      default: true,
    },
  ]);

  return answers;
}

/**
 * Write template files into the project directory. Existing files are never
 * overwritten, so re-running init on a real project is safe.
 */
export function scaffoldTemplate(
  projectPath: string,
  template: ProjectTemplate,
  name: string,
  description: string
): string[] {
  const written: string[] = [];

  const writeIfMissing = (relative: string, content: string): void => {
    const filePath = path.join(projectPath, relative);
    if (fs.existsSync(filePath)) {
      return;
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    written.push(relative);
  };

  writeIfMissing(
    'agent.json',
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        description,
        type: 'generic',
        entryPoint: 'index.js',
      },
      null,
      2
    ) + '\n'
  );

  writeIfMissing(
    'index.js',
    `/**
 * ${name} - AgentVault agent entry point
 *
 * The exported handler receives a task payload and returns a result. It is
 * bundled to WASM by \`agentvault package\` and executed inside your canister.
 */

export async function handleTask(task) {
  return {
    status: 'ok',
    echo: task,
    timestamp: Date.now(),
  };
}

export default { handleTask };
`
  );

  if (template === 'default') {
    writeIfMissing(
      'README.md',
      `# ${name}

${description}

## Develop

Edit \`index.js\` — it is your agent's entry point.

## Package and deploy

\`\`\`bash
npx agentvault@latest package ./
npx agentvault@latest deploy --network local
\`\`\`

Use \`--network ic\` to deploy to ICP mainnet.
`
    );
  }

  return written;
}

export async function executeInit(
  answers: InitAnswers,
  options: InitOptions,
  sourcePath: string
): Promise<void> {
  const projectRoot = path.resolve(sourcePath);
  const projectDir = path.join(projectRoot, '.agentvault');

  if (fs.existsSync(projectDir) && !options.force) {
    console.log(
      chalk.yellow('This directory is already an AgentVault project.'),
      'Re-run with',
      chalk.bold('--force'),
      'to re-initialize.'
    );
    return;
  }

  const isNewDirectory = !fs.existsSync(projectRoot);
  if (isNewDirectory) {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  const spinner = ora('Initializing AgentVault project...').start();

  const agentDir = path.join(projectDir, 'agent');
  const canisterDir = path.join(projectDir, 'canister');
  const configDir = path.join(projectDir, 'config');
  const srcDir = path.join(projectDir, 'src');
  const canisterWasmDir = path.join(canisterDir, 'wasm');

  const directories = [agentDir, canisterDir, configDir, srcDir, canisterWasmDir];
  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const configPath = path.join(configDir, 'agent.config.json');
  const configContent = {
    name: answers.name,
    type: 'generic',
    version: '1.0.0',
    createdAt: Date.now(),
    description: answers.description || 'An AgentVault agent',
  };
  fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2), 'utf-8');

  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    const gitignoreContent = `# Dependencies
node_modules/
dist/
*.log
.env
*.local
.DS_Store

# AgentVault generated files
*.wasm
*.backup
*.state.json

# AgentVault local state
.agentvault/
`;
    fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
  }

  const template = (options.template ?? 'default') as ProjectTemplate;
  const scaffolded = scaffoldTemplate(
    projectRoot,
    template,
    answers.name,
    answers.description || 'An AgentVault agent'
  );

  // Detect soul.md in working directory
  const soulPath = path.join(projectRoot, 'soul.md');
  const soulDetected = fs.existsSync(soulPath);
  if (soulDetected) {
    const memoryRepoConfigPath = path.join(projectDir, 'memory-repo.config.json');
    const memoryRepoConfig = {
      soulDetected: true,
      soulFile: 'soul.md',
      detectedAt: Date.now(),
    };
    fs.writeFileSync(memoryRepoConfigPath, JSON.stringify(memoryRepoConfig, null, 2), 'utf-8');
  }

  spinner.succeed('AgentVault project initialized successfully!');

  console.log();
  console.log(chalk.green('✓'), 'Project initialized at:', chalk.bold(projectRoot));
  console.log();
  console.log(chalk.cyan('Project files:'));
  for (const file of scaffolded) {
    console.log('  ├──', file, chalk.yellow('(template)'));
  }
  console.log('  ├── .agentvault/', chalk.yellow('(local project state)'));
  console.log('  └── .gitignore');
  console.log();
  console.log(chalk.cyan('Configuration:'));
  console.log('  ├── Name:', chalk.bold(configContent.name));
  console.log('  ├── Template:', chalk.bold(template));
  console.log('  ├── Version:', chalk.bold(configContent.version));
  console.log('  └── Description:', chalk.bold(configContent.description));
  console.log();
  if (soulDetected) {
    console.log(chalk.cyan('Soul.md detected:'));
    console.log('  ├── Soul file:', chalk.bold('soul.md'));
    console.log('  └── Config:', chalk.bold('memory-repo.config.json'));
    console.log();
  }

  const cdHint = projectRoot !== path.resolve('.') ? path.relative('.', projectRoot) : null;
  console.log(chalk.cyan('Next steps:'));
  let step = 1;
  if (cdHint) {
    console.log(`  ${step++}. Enter your project:`, chalk.bold(`cd ${cdHint}`));
  }
  console.log(`  ${step++}. Edit`, chalk.bold('index.js'), 'to implement your agent');
  console.log(`  ${step++}. Package it:`, chalk.bold('npx agentvault@latest package ./'));
  console.log(`  ${step++}. Deploy it:`, chalk.bold('npx agentvault@latest deploy --network local'));
  if (soulDetected) {
    console.log(`  ${step++}. Run`, chalk.bold('agentvault memory init soul.md'), 'to initialize memory from Soul.md');
  }
}

export function initCommand(): Command {
  const command = new Command('init');

  command
    .description('Initialize a new AgentVault project')
    .argument('[project]', 'project directory to create or initialize', '.')
    .option('-n, --name <name>', 'name of the agent (defaults to the project directory name)')
    .option('-t, --template <template>', 'project template (default, minimal)', 'default')
    .option('--force', 're-initialize an existing AgentVault project')
    .option('-y, --yes', 'skip prompts and use defaults')
    .option('-v, --verbose', 'display detailed configuration information')
    .option('--vv', 'extra verbose mode for debugging')
    .action(async (project: string, options: InitOptions) => {
      console.log(chalk.bold('\n🔐 AgentVault Project Initialization\n'));

      const template = options.template ?? 'default';
      if (!PROJECT_TEMPLATES.includes(template as ProjectTemplate)) {
        console.error(
          chalk.red(`Unknown template "${template}".`),
          'Available templates:',
          PROJECT_TEMPLATES.join(', ')
        );
        process.exitCode = 1;
        return;
      }

      const projectWasNamed = project !== '.';
      const defaultName = sanitizeAgentName(
        options.name ?? (projectWasNamed ? path.basename(path.resolve(project)) : 'my-agent')
      );

      // Naming the project on the command line is the 1-click path: no prompts.
      const answers = projectWasNamed || options.yes || options.name
        ? { name: defaultName, description: 'An AgentVault agent', confirm: true }
        : await promptForInitOptions(options);

      if (!answers || !answers.confirm) {
        console.log(chalk.yellow('Initialization cancelled.'));
        return;
      }

      await executeInit(answers, options, project);
    });

  return command;
}
