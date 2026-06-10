import { NextResponse } from 'next/server';
import { exportBackup, previewBackup, importBackup, listBackups } from '@/backup/index';

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const agentName = url.searchParams.get('agent');
    
    if (agentName) {
      const backups = await listBackups(agentName);
      return NextResponse.json({
        success: true,
        data: backups,
      });
    }
    
    return NextResponse.json({
      success: false,
      error: 'agent name is required',
    }, { status: 400 });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, agentName, ...options } = body;
    
    if (!agentName) {
      return NextResponse.json({
        success: false,
        error: 'agentName is required',
      }, { status: 400 });
    }

    switch (action) {
      case 'export':
        const outputPath = options.output || `./${agentName}.json`;
        const exportResult = await exportBackup({
          agentName,
          outputPath,
          includeConfig: true,
        });
        return NextResponse.json({ success: exportResult.success, data: exportResult });
        
      case 'import':
        if (!options.inputPath) {
          return NextResponse.json({
            success: false,
            error: 'inputPath is required for import',
          }, { status: 400 });
        }
        const importResult = await importBackup({
          inputPath: options.inputPath,
          targetAgentName: options.targetAgentName,
          overwrite: options.overwrite,
        });
        return NextResponse.json({ success: importResult.success, data: importResult });
        
      case 'preview':
        if (!options.inputPath) {
          return NextResponse.json({
            success: false,
            error: 'inputPath is required for preview',
          }, { status: 400 });
        }
        const manifest = await previewBackup(options.inputPath);
        return NextResponse.json({ success: true, data: manifest });
        
      default:
        return NextResponse.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
