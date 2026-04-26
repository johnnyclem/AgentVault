import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface AssetRow {
  raw: Record<string, string>;
  id: string;
  type: 'sfx' | 'music';
  prompt: string;
  durationSeconds: number;
  outputFile: string;
}

interface CliOptions {
  csvPath: string;
  outputDir: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    csvPath: 'catfish audio assets.csv',
    outputDir: 'generated/catfish-audio',
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextArg = argv[i + 1];
    if (arg === '--csv' && nextArg) {
      options.csvPath = nextArg;
      i += 1;
    } else if (arg === '--out' && nextArg) {
      options.outputDir = nextArg;
      i += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseCsv(csvContent: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < csvContent.length; i += 1) {
    const char = csvContent[i];
    const next = csvContent[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        i += 1;
      }
      row.push(current.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current.trim());
    if (row.some((cell) => cell.length > 0)) {
      rows.push(row);
    }
  }

  if (rows.length < 2) {
    throw new Error('CSV must include a header row and at least one asset row.');
  }

  const headerRow = rows[0];
  if (!headerRow) {
    throw new Error('CSV header row is missing.');
  }
  const headers = headerRow.map(normalizeHeader);
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, idx) => {
      obj[header] = cells[idx] ?? '';
    });
    return obj;
  });
}

function pickFirst(row: Record<string, string>, candidates: string[]): string {
  for (const candidate of candidates) {
    if (row[candidate]) {
      return row[candidate];
    }
  }
  return '';
}

function buildAssetRows(records: Record<string, string>[]): AssetRow[] {
  return records.map((row, index) => {
    const id = pickFirst(row, ['id', 'asset_id', 'name', 'asset_name']) || `asset-${index + 1}`;
    const typeValue = pickFirst(row, ['type', 'asset_type', 'category']).toLowerCase();
    const type: 'sfx' | 'music' = typeValue.includes('music') ? 'music' : 'sfx';
    const prompt = pickFirst(row, ['prompt', 'description', 'text']);

    if (!prompt) {
      throw new Error(`Missing prompt for row ${index + 2} (${id}).`);
    }

    const durationRaw = pickFirst(row, ['duration_seconds', 'duration', 'seconds']) || '10';
    const durationSeconds = Number.parseInt(durationRaw, 10);
    const sanitizedId = id.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    const ext = type === 'music' ? '.mp3' : '.wav';
    const outputFile = pickFirst(row, ['output_file', 'filename']) || `${String(index + 1).padStart(3, '0')}-${sanitizedId}${ext}`;

    return {
      raw: row,
      id,
      type,
      prompt,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 10,
      outputFile,
    };
  });
}

async function generateSoundEffect(apiKey: string, prompt: string, durationSeconds: number): Promise<ArrayBuffer> {
  const response = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: durationSeconds,
      prompt_influence: 0.5,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs SFX request failed (${response.status}): ${errorText}`);
  }

  return response.arrayBuffer();
}

async function generateMusic(apiKey: string, prompt: string, durationSeconds: number): Promise<ArrayBuffer> {
  const response = await fetch('https://api.elevenlabs.io/v1/music', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: durationSeconds,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs music request failed (${response.status}): ${errorText}`);
  }

  return response.arrayBuffer();
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { csvPath, outputDir, dryRun } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ELEVEN_LABS_API_KEY ?? process.env.ELEVENLABS_API_KEY;

  if (!(await fileExists(csvPath))) {
    throw new Error(`Could not find CSV: "${csvPath}". Place your asset sheet at this path or pass --csv <path>.`);
  }

  const csvText = await readFile(csvPath, 'utf8');
  const rows = buildAssetRows(parseCsv(csvText));
  await mkdir(outputDir, { recursive: true });

  const manifest: Array<Record<string, string | number>> = [];

  for (const row of rows) {
    const outputPath = join(outputDir, row.outputFile);
    process.stdout.write(`• ${row.id} (${row.type}) -> ${outputPath}\n`);

    if (dryRun) {
      manifest.push({
        id: row.id,
        type: row.type,
        prompt: row.prompt,
        durationSeconds: row.durationSeconds,
        outputFile: row.outputFile,
        status: 'dry-run',
      });
      continue;
    }

    if (!apiKey) {
      throw new Error('Missing ELEVEN_LABS_API_KEY (or ELEVENLABS_API_KEY) environment variable.');
    }

    const buffer = row.type === 'music'
      ? await generateMusic(apiKey, row.prompt, row.durationSeconds)
      : await generateSoundEffect(apiKey, row.prompt, row.durationSeconds);

    await writeFile(outputPath, Buffer.from(buffer));
    manifest.push({
      id: row.id,
      type: row.type,
      prompt: row.prompt,
      durationSeconds: row.durationSeconds,
      outputFile: row.outputFile,
      status: 'generated',
    });
  }

  const manifestPath = join(outputDir, 'manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`\nDone. Wrote ${manifest.length} asset records to ${manifestPath}.\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
