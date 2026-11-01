import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import {
  connectWorkspaceSchema,
  type WorkspaceConnection,
} from '@specide/schema';
import {
  atomicWrite,
  DocumentsService,
  WORKSPACE_OPTIONS,
  type WorkspaceOptions,
} from './documents';
import { GitService } from './git';

const execute = promisify(execFile);
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const selectionSchema = z.object({
  operationId: z.uuid(),
  previousId: z.string(),
  fingerprint: z.string(),
  path: z.string().nullable(),
});
type Selection = z.infer<typeof selectionSchema>;
interface Session {
  id: string;
  storageKey: string;
  root: string;
  source: WorkspaceConnection['source'];
  documents: DocumentsService;
  git: GitService;
  connectionError?: string;
}
function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}
function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
  );
}

@Injectable()
export class WorkspaceManager implements OnModuleInit {
  private active!: Session;
  private selection: Selection | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private defaultRoot = '';
  private productRoot: string | null = null;
  private productCommonDir: string | null = null;

  constructor(
    @Inject(WORKSPACE_OPTIONS) private readonly options: WorkspaceOptions,
  ) {}

  async onModuleInit() {
    this.defaultRoot = await realpath(this.options.root);
    if (this.options.productRoot) {
      this.productRoot = await realpath(this.options.productRoot);
      try {
        this.productCommonDir = await this.commonDir(this.productRoot);
      } catch {
        /* An installed product may not be a Git checkout. */
      }
    }
    let connectionError: string | undefined;
    try {
      this.selection = selectionSchema.parse(
        JSON.parse(await readFile(this.configPath(), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        connectionError =
          'Не удалось прочитать сохраненное подключение. Открыта исходная папка.';
    }
    if (this.selection?.path) {
      try {
        const root = await this.validateRepository(this.selection.path);
        this.active = await this.build(
          root,
          'repository',
          this.selection.operationId,
        );
        return;
      } catch {
        connectionError =
          'Сохраненный репозиторий недоступен. Открыта исходная папка; можно выбрать другое подключение.';
      }
    }
    this.active = await this.build(
      this.defaultRoot,
      'default',
      connectionError ? 'fallback' : (this.selection?.operationId ?? 'initial'),
    );
    this.active.connectionError = connectionError;
  }

  private configPath() {
    return resolve(this.options.state, 'connection.json');
  }
  private identity(root: string, nonce: string) {
    return digest(root + '\0' + nonce);
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async git(path: string, args: string[]) {
    const env = { ...process.env };
    for (const key of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ])
      delete env[key];
    env.GIT_OPTIONAL_LOCKS = '0';
    env.GIT_TERMINAL_PROMPT = '0';
    return (
      await execute(
        'git',
        ['--no-pager', '-c', 'core.fsmonitor=false', '-C', path, ...args],
        { env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 },
      )
    ).stdout.trim();
  }
  private async commonDir(root: string) {
    return realpath(
      resolve(root, await this.git(root, ['rev-parse', '--git-common-dir'])),
    );
  }

  private async validateRepository(input: string) {
    if (input.includes('\0'))
      fail(400, 'INVALID_PATH', 'Некорректный путь репозитория.');
    const expanded = input.startsWith('~/')
      ? resolve(homedir(), input.slice(2))
      : input;
    if (!isAbsolute(expanded))
      fail(
        400,
        'INVALID_PATH',
        'Укажите абсолютный путь к локальной папке репозитория.',
      );
    let root: string;
    try {
      root = await realpath(expanded);
      if (!(await lstat(root)).isDirectory())
        fail(400, 'INVALID_PATH', 'Выберите папку репозитория.');
    } catch (error) {
      if (error instanceof HttpException) throw error;
      fail(400, 'INVALID_PATH', 'Папка не существует или недоступна.');
    }
    if (
      this.productRoot &&
      (contains(this.productRoot, root) || contains(root, this.productRoot))
    ) {
      fail(
        400,
        'PRODUCT_REPOSITORY',
        'Выберите отдельный репозиторий вне папки исходного кода specIDE.',
      );
    }
    const state = await realpath(this.options.state).catch(() =>
      resolve(this.options.state),
    );
    if (contains(root, state) || contains(state, root))
      fail(
        400,
        'STATE_OVERLAP',
        'Папка репозитория не должна пересекаться со служебными данными приложения.',
      );
    try {
      const top = await realpath(
        await this.git(root, ['rev-parse', '--show-toplevel']),
      );
      if (top !== root)
        fail(
          400,
          'NOT_REPOSITORY_ROOT',
          'Укажите корневую папку Git-репозитория, а не вложенную папку.',
        );
      if (
        this.productCommonDir &&
        (await this.commonDir(root)) === this.productCommonDir
      ) {
        fail(
          400,
          'PRODUCT_REPOSITORY',
          'Этот worktree использует Git-хранилище исходного кода specIDE. Нужен независимый репозиторий.',
        );
      }
    } catch (error) {
      if (error instanceof HttpException) throw error;
      fail(
        400,
        'NOT_A_REPOSITORY',
        'Не найден локальный рабочий Git-репозиторий. Клонирование по URL пока не поддерживается.',
      );
    }
    return root;
  }

  private async build(
    root: string,
    source: Session['source'],
    nonce: string,
  ): Promise<Session> {
    const storageKey = digest(root);
    const state =
      root === this.defaultRoot
        ? this.options.state
        : resolve(this.options.state, 'workspaces', storageKey);
    const options = { root, state };
    const documents = new DocumentsService(options);
    await documents.onModuleInit();
    const git = new GitService(options, documents);
    await git.onModuleInit();
    return {
      id: this.identity(root, nonce),
      storageKey,
      root,
      source,
      documents,
      git,
    };
  }

  private async info(session: Session): Promise<WorkspaceConnection> {
    let documentCount = 0;
    let connectionError = session.connectionError;
    try {
      documentCount = (await session.documents.workspace()).documentCount;
    } catch {
      connectionError =
        'Папка рабочего пространства недоступна. Можно подключить другой репозиторий.';
    }
    return {
      id: session.id,
      storageKey: session.storageKey,
      path: session.root,
      source: session.source,
      name: session.root.split(sep).at(-1)!,
      mode: 'local',
      documentCount,
      connectionError,
    };
  }

  current() {
    return this.exclusive(() => this.info(this.active));
  }

  run<T>(
    expectedId: string | undefined,
    action: (session: Session) => Promise<T>,
    mutation = false,
  ): Promise<T> {
    return this.exclusive(async () => {
      if (mutation && !expectedId)
        fail(
          400,
          'WORKSPACE_REQUIRED',
          'Не указан идентификатор рабочего пространства.',
        );
      if (expectedId && expectedId !== this.active.id)
        fail(
          409,
          'WORKSPACE_CHANGED',
          'Рабочее пространство переключено в другой вкладке. Перезагрузите страницу перед продолжением.',
        );
      return action(this.active);
    });
  }

  connect(input: unknown): Promise<WorkspaceConnection> {
    return this.exclusive(async () => {
      const parsed = connectWorkspaceSchema.safeParse(input);
      if (!parsed.success)
        fail(
          400,
          'VALIDATION_ERROR',
          'Проверьте путь и параметры подключения.',
        );
      const request = parsed.data;
      const fingerprint = digest(JSON.stringify(request));
      if (this.selection?.operationId === request.operationId) {
        if (this.selection.fingerprint !== fingerprint)
          fail(
            409,
            'OPERATION_REUSED',
            'ID подключения уже использован с другими параметрами.',
          );
        const target = this.selection.path ?? this.defaultRoot;
        if (this.active.id !== this.identity(target, request.operationId))
          fail(
            409,
            'WORKSPACE_CHANGED',
            'Результат подключения изменился. Перезагрузите страницу.',
          );
        return this.info(this.active);
      }
      if (request.expectedWorkspaceId !== this.active.id)
        fail(
          409,
          'WORKSPACE_CHANGED',
          'Рабочее пространство уже переключено. Перезагрузите страницу.',
        );
      await this.active.documents.assertCanSwitch();
      await this.active.git.assertCanSwitch();
      const root =
        request.path === null
          ? this.defaultRoot
          : await this.validateRepository(request.path);
      const candidate = await this.build(
        root,
        request.path === null ? 'default' : 'repository',
        request.operationId,
      );
      const info = await this.info(candidate);
      if (info.connectionError)
        fail(400, 'REPOSITORY_UNAVAILABLE', info.connectionError);
      const selection: Selection = {
        operationId: request.operationId,
        previousId: this.active.id,
        fingerprint,
        path: request.path === null ? null : root,
      };
      await atomicWrite(this.configPath(), JSON.stringify(selection));
      this.selection = selection;
      this.active = candidate;
      return info;
    });
  }

  connection(id: string): Promise<WorkspaceConnection> {
    return this.exclusive(async () => {
      if (!z.uuid().safeParse(id).success)
        fail(400, 'INVALID_OPERATION', 'Некорректный ID подключения.');
      if (this.selection?.operationId !== id)
        fail(
          404,
          'OPERATION_NOT_FOUND',
          'Подключение еще не зарегистрировано или уже заменено.',
        );
      const root = this.selection.path ?? this.defaultRoot;
      if (this.active.id !== this.identity(root, id))
        fail(
          409,
          'WORKSPACE_CHANGED',
          'Репозиторий после подключения стал недоступен.',
        );
      return this.info(this.active);
    });
  }
}
