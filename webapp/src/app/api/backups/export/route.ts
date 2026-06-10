import { NextResponse } from 'next/server';
import { exportBackup } from '@/backup/index';

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
    
    const result = await exportBackup({
      agentName,
      outputPath: outputPath || `./${agentName}.json`,
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
