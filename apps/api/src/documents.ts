import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import {
  contentVersion,
  parseRequirement,
  serializeRequirement,
} from '@specide/markdown';
import {
  createDocumentSchema,
  saveDocumentSchema,
  type DocumentList,
  type RequirementDocument,
  type DocumentOperation,
  type WorkspaceInfo,
} from '@specide/schema';
import { systemRequirementTemplate } from './system-template';

export const WORKSPACE_OPTIONS = Symbol('WORKSPACE_OPTIONS');
export interface WorkspaceOptions {
  root: string;
  state: string;
}
const operationRecordSchema = z.object({
  id: z.uuid(),
  workspace: z.string(),
  fingerprint: z.string(),
  path: z.string(),
  kind: z.enum(['save', 'create']).default('save'),
  beforeVersion: z.string().nullable(),
  afterVersion: z.string(),
  status: z.enum(['pending', 'succeeded', 'failed', 'needs_review']),
  document: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
type OperationRecord = Omit<
  z.infer<typeof operationRecordSchema>,
  'document'
> & { document?: RequirementDocument };

function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}

export async function atomicWrite(
  path: string,
  source: string,
  options: { createOnly?: boolean } = {},
): Promise<void> {
  const temporary = resolve(
    dirname(path),
    '.' + basename(path) + '.' + randomUUID() + '.tmp',
  );
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(source, 'utf8');
    await file.sync();
    await file.close();
    if (options.createOnly) {
      // Publishing a hard link fails if the target exists; rename would overwrite it.
      await link(temporary, path);
      await unlink(temporary);
    } else {
      await rename(temporary, path);
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

@Injectable()
export class DocumentsService implements OnModuleInit {
  private tail: Promise<unknown> = Promise.resolve();
  private root = '';
  private state = '';

  constructor(
    @Inject(WORKSPACE_OPTIONS) private readonly options: WorkspaceOptions,
  ) {}

  async onModuleInit() {
    this.root = await realpath(this.options.root);
    await mkdir(this.options.state, { recursive: true });
    this.state = await realpath(this.options.state);
    for (const name of await readdir(this.state)) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        await this.recover(await this.readRecord(name.slice(0, -5)));
      }
    }
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async safePath(path: string): Promise<string> {
    const resolved = await realpath(resolve(this.root, path));
    const inside = relative(this.root, resolved);
    if (
      inside === '..' ||
      inside.startsWith('..' + sep) ||
      isAbsolute(inside)
    ) {
      fail(400, 'INVALID_PATH', 'Файл находится вне рабочего пространства.');
    }
    return resolved;
  }

  private async scan(): Promise<{
    listing: DocumentList;
    reservedIds: Set<string>;
  }> {
    const result: DocumentList = { documents: [], issues: [] };
    const reservedIds = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        if (/^SR-\d+\.md$/.test(entry.name))
          reservedIds.add(entry.name.slice(0, -3));
        const rel = relative(this.root, path).split(sep).join('/');
        try {
          const safe = await this.safePath(rel);
          const document = parseRequirement(await readFile(safe, 'utf8'), rel);
          if (document.metadata.type !== 'system') continue;
          reservedIds.add(document.metadata.id);
          result.documents.push({
            path: rel,
            metadata: document.metadata,
            version: document.version,
          });
        } catch {
          result.issues.push({
            path: rel,
            message:
              'Не удалось прочитать документ или проверить его свойства.',
          });
        }
      }
    };
    await walk(this.root);
    const counts = new Map<string, number>();
    result.documents.forEach((d) =>
      counts.set(d.metadata.id, (counts.get(d.metadata.id) ?? 0) + 1),
    );
    result.documents = result.documents.filter((d) => {
      if (counts.get(d.metadata.id) === 1) return true;
      result.issues.push({
        path: d.path,
        message: 'Повторный идентификатор: ' + d.metadata.id,
      });
      return false;
    });
    result.documents.sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
    return { listing: result, reservedIds };
  }

  async list(): Promise<DocumentList> {
    return (await this.scan()).listing;
  }

  async workspace(): Promise<WorkspaceInfo> {
    const list = await this.list();
    return {
      name: basename(this.root),
      mode: 'local',
      documentCount: list.documents.length,
    };
  }

  async get(id: string): Promise<RequirementDocument> {
    const listing = await this.list();
    const summary = listing.documents.find((d) => d.metadata.id === id);
    if (!summary)
      fail(
        404,
        'NOT_FOUND',
        'Документ не найден или имеет некорректные свойства.',
      );
    const source = await readFile(await this.safePath(summary.path), 'utf8');
    return parseRequirement(source, summary.path);
  }

  private recordPath(id: string) {
    return resolve(this.state, id + '.json');
  }

  private async readRecord(id: string): Promise<OperationRecord> {
    if (!z.uuid().safeParse(id).success)
      fail(400, 'INVALID_OPERATION', 'Некорректный идентификатор операции.');
    try {
      const parsed = operationRecordSchema.parse(
        JSON.parse(await readFile(this.recordPath(id), 'utf8')),
      );
      if (parsed.workspace !== this.root)
        fail(
          409,
          'WORKSPACE_MISMATCH',
          'Журнал относится к другому рабочему пространству.',
        );
      return parsed as OperationRecord;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        fail(404, 'OPERATION_NOT_FOUND', 'Операция еще не зарегистрирована.');
      fail(500, 'JOURNAL_ERROR', 'Не удалось проверить журнал сохранения.');
    }
  }

  private async writeRecord(record: OperationRecord) {
    await atomicWrite(this.recordPath(record.id), JSON.stringify(record));
  }

  private async recover(record: OperationRecord): Promise<OperationRecord> {
    if (record.status !== 'pending') return record;
    let source: string | undefined;
    let missing = false;
    try {
      source = await readFile(await this.safePath(record.path), 'utf8');
    } catch (error) {
      missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    const version = source === undefined ? undefined : contentVersion(source);
    if (version === record.afterVersion) {
      record.status = 'succeeded';
      record.document = parseRequirement(source!, record.path);
    } else if (
      version === record.beforeVersion ||
      (record.kind === 'create' && record.beforeVersion === null && missing)
    ) {
      record.status = 'failed';
      record.error = {
        code:
          record.kind === 'create' ? 'CREATE_INTERRUPTED' : 'SAVE_INTERRUPTED',
        message:
          record.kind === 'create'
            ? 'Документ не был создан. Можно повторить создание.'
            : 'Запись не была выполнена. Можно повторить сохранение.',
      };
    } else {
      record.status = 'needs_review';
      record.error = {
        code: 'RECOVERY_REQUIRED',
        message:
          'Файл изменился во время прерванного сохранения. Перечитайте его перед продолжением.',
      };
    }
    await this.writeRecord(record);
    return record;
  }

  private publicOperation(record: OperationRecord): DocumentOperation {
    return {
      id: record.id,
      status: record.status,
      document: record.document,
      error: record.error,
    };
  }

  operation(id: string): Promise<DocumentOperation> {
    return this.exclusive(async () =>
      this.publicOperation(await this.recover(await this.readRecord(id))),
    );
  }

  save(id: string, input: unknown): Promise<DocumentOperation> {
    return this.exclusive(async () => {
      const parsed = saveDocumentSchema.safeParse(input);
      if (!parsed.success)
        fail(
          400,
          'VALIDATION_ERROR',
          'Проверьте название, статус и свойства документа.',
        );
      const request = parsed.data;
      if (request.metadata.type !== 'system')
        fail(
          403,
          'INACTIVE_TYPE',
          'Сейчас доступны только системные требования.',
        );
      if (id !== request.metadata.id)
        fail(
          400,
          'IDENTITY_CHANGED',
          'Идентификатор документа нельзя менять при сохранении.',
        );
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ id, request }))
        .digest('hex');
      try {
        const existing = await this.readRecord(request.operationId);
        if (existing.fingerprint !== fingerprint)
          fail(
            409,
            'OPERATION_REUSED',
            'Этот ID сохранения уже использован с другими данными.',
          );
        return this.publicOperation(await this.recover(existing));
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 404)
          throw error;
      }
      const document = await this.get(id);
      const path = await this.safePath(document.path);
      const original = await readFile(path, 'utf8');
      if (contentVersion(original) !== request.expectedVersion) {
        fail(
          409,
          'VERSION_CONFLICT',
          'Документ уже изменен. Ваш текст сохранен в редакторе; перечитайте файл перед продолжением.',
        );
      }
      if (document.metadata.type !== request.metadata.type)
        fail(400, 'TYPE_CHANGED', 'Тип существующего документа нельзя менять.');
      const target = serializeRequirement(
        request.metadata,
        request.body,
        original,
      );
      const record: OperationRecord = {
        id: request.operationId,
        workspace: this.root,
        fingerprint,
        path: document.path,
        kind: 'save',
        beforeVersion: contentVersion(original),
        afterVersion: contentVersion(target),
        status: 'pending',
      };
      await this.writeRecord(record);
      try {
        await atomicWrite(path, target);
        record.status = 'succeeded';
        record.document = parseRequirement(target, document.path);
        await this.writeRecord(record);
        return this.publicOperation(record);
      } catch {
        fail(
          503,
          'RESULT_UNKNOWN',
          'Подтверждение сохранения не получено. Проверьте результат операции.',
        );
      }
    });
  }

  private async systemDirectory(): Promise<string> {
    let directory = this.root;
    for (const segment of ['requirements', 'system']) {
      const next = resolve(directory, segment);
      try {
        await mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const entry = await lstat(next);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        fail(
          400,
          'INVALID_PATH',
          'Папка системных требований должна быть обычной папкой рабочего пространства.',
        );
      }
      directory = await this.safePath(relative(this.root, next));
    }
    return directory;
  }

  private async nextSystemId(): Promise<string> {
    const { reservedIds } = await this.scan();
    for (const name of await readdir(this.state)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const record = await this.readRecord(name.slice(0, -5));
      const filename = basename(record.path);
      if (/^SR-\d+\.md$/.test(filename)) reservedIds.add(filename.slice(0, -3));
      if (record.document?.metadata.type === 'system')
        reservedIds.add(record.document.metadata.id);
    }
    let maximum = 0n;
    for (const id of reservedIds) {
      const number = BigInt(id.slice(3));
      if (number > maximum) maximum = number;
    }
    return 'SR-' + (maximum + 1n).toString().padStart(3, '0');
  }

  create(input: unknown): Promise<DocumentOperation> {
    return this.exclusive(async () => {
      const parsed = createDocumentSchema.safeParse(input);
      if (!parsed.success)
        fail(
          400,
          'VALIDATION_ERROR',
          'Укажите название до 200 символов; ответственный — до 160 символов.',
        );
      const request = parsed.data;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ kind: 'create', request }))
        .digest('hex');
      try {
        const existing = await this.readRecord(request.operationId);
        if (existing.fingerprint !== fingerprint)
          fail(
            409,
            'OPERATION_REUSED',
            'Этот ID операции уже использован с другими данными.',
          );
        return this.publicOperation(await this.recover(existing));
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 404)
          throw error;
      }
      const directory = await this.systemDirectory();
      const id = await this.nextSystemId();
      const path = resolve(directory, id + '.md');
      const relativePath = relative(this.root, path).split(sep).join('/');
      const target = serializeRequirement(
        {
          id,
          type: 'system',
          title: request.title,
          status: 'draft',
          ...(request.owner ? { owner: request.owner } : {}),
        },
        systemRequirementTemplate,
      );
      const record: OperationRecord = {
        id: request.operationId,
        workspace: this.root,
        fingerprint,
        kind: 'create',
        path: relativePath,
        beforeVersion: null,
        afterVersion: contentVersion(target),
        status: 'pending',
      };
      await this.writeRecord(record);
      try {
        await atomicWrite(path, target, { createOnly: true });
        record.document = parseRequirement(target, relativePath);
        record.status = 'succeeded';
        await this.writeRecord(record);
        return this.publicOperation(record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          record.status = 'failed';
          record.error = {
            code: 'FILE_EXISTS',
            message:
              'Файл с таким ID уже появился. Повторите создание; существующий файл не изменен.',
          };
          await this.writeRecord(record);
          fail(409, record.error.code, record.error.message);
        }
        fail(
          503,
          'RESULT_UNKNOWN',
          'Подтверждение создания не получено. Проверьте результат операции.',
        );
      }
    });
  }
}
