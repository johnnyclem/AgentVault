import { NextResponse } from 'next/server';
import { importBackup } from '@/backup/index';
import { resolveBackupPath } from '@/lib/server/paths';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { inputPath, targetAgentName, overwrite } = body;

    if (!inputPath) {
      return NextResponse.json({
        success: false,
        error: 'inputPath is required for import',
      }, { status: 400 });
    }

    // Confine to the backup directory: an unconstrained inputPath makes this
    // an arbitrary local file read.
    let resolvedInput: string;
    try {
      resolvedInput = resolveBackupPath(inputPath);
    } catch (error) {
      return NextResponse.json({
        success: false,
        error: error instanceof Error ? error.message : 'Invalid inputPath',
      }, { status: 400 });
    }

    const result = await importBackup({
      inputPath: resolvedInput,
      targetAgentName,
      overwrite,
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
