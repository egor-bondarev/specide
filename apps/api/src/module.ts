import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { DocumentsController } from './routes';
import { WORKSPACE_OPTIONS } from './documents';
import { GitController } from './git-routes';
import { WorkspaceManager } from './workspaces';
import { WorkspaceController } from './workspace-routes';

@Module({
  controllers: [DocumentsController, GitController, WorkspaceController],
  providers: [
    {
      provide: WORKSPACE_OPTIONS,
      useValue: {
        root: resolve(
          process.env.SPECIDE_WORKSPACE ?? '../../examples/workspace',
        ),
        state: resolve(process.env.SPECIDE_STATE_DIR ?? '../../.specide'),
        productRoot: resolve(__dirname, '../../..'),
      },
    },
    WorkspaceManager,
  ],
})
export class AppModule {}
