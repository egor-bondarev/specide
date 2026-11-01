import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { WorkspaceManager } from './workspaces';

@Controller()
export class DocumentsController {
  constructor(
    @Inject(WorkspaceManager) private readonly workspaces: WorkspaceManager,
  ) {}

  @Get('documents')
  list(@Headers('x-specide-workspace') scope?: string) {
    return this.workspaces.run(scope, (session) => session.documents.list());
  }

  @Post('documents')
  create(
    @Body() body: unknown,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(
      scope,
      (session) => session.documents.create(body),
      true,
    );
  }

  @Get('documents/:id')
  get(@Param('id') id: string, @Headers('x-specide-workspace') scope?: string) {
    return this.workspaces.run(scope, (session) => session.documents.get(id));
  }

  @Put('documents/:id')
  save(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(
      scope,
      (session) => session.documents.save(id, body),
      true,
    );
  }

  @Get('operations/:id')
  operation(
    @Param('id') id: string,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(scope, (session) =>
      session.documents.operation(id),
    );
  }
}
