import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { WorkspaceManager } from './workspaces';

@Controller('git')
export class GitController {
  constructor(
    @Inject(WorkspaceManager) private readonly workspaces: WorkspaceManager,
  ) {}

  @Get('status')
  status(@Headers('x-specide-workspace') scope?: string) {
    return this.workspaces.run(scope, (session) => session.git.status());
  }

  @Get('diff')
  diff(
    @Query('path') path: string,
    @Query('commit') commit?: string,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(scope, (session) =>
      session.git.diff(path, commit),
    );
  }

  @Get('history')
  history(
    @Query('offset') offset?: string,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(scope, (session) =>
      session.git.history(offset === undefined ? 0 : Number(offset)),
    );
  }

  @Get('commits/:hash')
  details(
    @Param('hash') hash: string,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(scope, (session) => session.git.details(hash));
  }

  @Post('commit')
  commit(
    @Body() body: unknown,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(
      scope,
      (session) => session.git.commit(body),
      true,
    );
  }

  @Post('push')
  push(@Body() body: unknown, @Headers('x-specide-workspace') scope?: string) {
    return this.workspaces.run(
      scope,
      (session) => session.git.push(body),
      true,
    );
  }

  @Get('operations/:id')
  operation(
    @Param('id') id: string,
    @Headers('x-specide-workspace') scope?: string,
  ) {
    return this.workspaces.run(scope, (session) => session.git.operation(id));
  }
}
