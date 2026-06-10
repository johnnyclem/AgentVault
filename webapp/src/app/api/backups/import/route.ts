import { NextResponse } from 'next/server';
import { importBackup } from '@/backup/index';

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
    
    const result = await importBackup({
      inputPath,
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
