import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { DocumentsService } from './documents';

@Controller()
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Get('workspace')
  workspace() {
    return this.documents.workspace();
  }

  @Get('documents')
  list() {
    return this.documents.list();
  }

  @Post('documents')
  create(@Body() body: unknown) {
    return this.documents.create(body);
  }

  @Get('documents/:id')
  get(@Param('id') id: string) {
    return this.documents.get(id);
  }

  @Put('documents/:id')
  save(@Param('id') id: string, @Body() body: unknown) {
    return this.documents.save(id, body);
  }

  @Get('operations/:id')
  operation(@Param('id') id: string) {
    return this.documents.operation(id);
  }
}
