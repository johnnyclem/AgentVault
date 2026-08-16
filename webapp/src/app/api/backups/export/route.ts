import { NextResponse } from 'next/server';
import { exportBackup } from '@/backup/index';
import { resolveBackupPath } from '@/lib/server/paths';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { agentName, outputPath } = body;

    if (!agentName) {
      return NextResponse.json({
        success: false,
        error: 'agentName is required',
      }, { status: 400 });
    }

    // Confine to the backup directory: an unconstrained outputPath makes this
    // an arbitrary local file write.
    let resolvedOutput: string;
    try {
      resolvedOutput = resolveBackupPath(outputPath || `${agentName}.json`);
    } catch (error) {
      return NextResponse.json({
        success: false,
        error: error instanceof Error ? error.message : 'Invalid outputPath',
      }, { status: 400 });
    }

    const result = await exportBackup({
      agentName,
      outputPath: resolvedOutput,
      includeConfig: true,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
