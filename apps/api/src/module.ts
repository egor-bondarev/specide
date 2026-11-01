import { Module } from '@nestjs/common';
import { resolve } from 'node:path';
import { DocumentsController } from './routes';
import { DocumentsService, WORKSPACE_OPTIONS } from './documents';

@Module({
  controllers: [DocumentsController],
  providers: [
    {
      provide: WORKSPACE_OPTIONS,
      useValue: {
        root: resolve(
          process.env.SPECIDE_WORKSPACE ?? '../../examples/workspace',
        ),
        state: resolve(process.env.SPECIDE_STATE_DIR ?? '../../.specide'),
      },
    },
    DocumentsService,
  ],
})
export class AppModule {}
