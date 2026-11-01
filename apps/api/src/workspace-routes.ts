import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { WorkspaceManager } from './workspaces';

@Controller('workspace')
export class WorkspaceController {
  constructor(
    @Inject(WorkspaceManager) private readonly workspaces: WorkspaceManager,
  ) {}

  @Get()
  current() {
    return this.workspaces.current();
  }

  @Post('connect')
  connect(@Body() body: unknown) {
    return this.workspaces.connect(body);
  }

  @Get('connections/:id')
  connection(@Param('id') id: string) {
    return this.workspaces.connection(id);
  }
}
