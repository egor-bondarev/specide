import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleInit,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
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
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createTwoFilesPatch } from 'diff';
import { parseRequirement } from '@specide/markdown';
import {
  gitCommitRequestSchema,
  gitPushRequestSchema,
  type GitChange,
  type GitCommit,
  type GitCommitFile,
  type GitDiff,
  type GitHistory,
  type GitOperation,
  type GitStatus,
  type GitPushTarget,
  type GitPushResult,
} from '@specide/schema';
import {
  atomicWrite,
  DocumentsService,
  WORKSPACE_OPTIONS,
  type WorkspaceOptions,
} from './documents';

function fail(status: number, code: string, message: string): never {
  throw new HttpException({ code, message }, status);
}
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const recordSchema = z.object({
  id: z.uuid(),
  workspace: z.string(),
  repository: z.string(),
  gitDir: z.string(),
  fingerprint: z.string(),
  ref: z.string(),
  base: z.string().nullable(),
  next: z.string().nullable(),
  indexBefore: z.string().nullable(),
  indexAfter: z.string().nullable(),
  status: z.enum(['pending', 'succeeded', 'failed', 'needs_review']),
  commit: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
type Record = Omit<z.infer<typeof recordSchema>, 'commit'> & {
  commit?: GitCommit;
};
interface Context {
  repository: string;
  gitDir: string;
  prefix: string;
  head: string | null;
  ref: string;
  branch: string | null;
}
interface Snapshot {
  path: string;
  repoPath: string;
  before: string | null;
  after: string | null;
  mode: string;
  token: string;
  kind: GitChange['kind'];
  blockedReason?: string;
}
class GitCommandError extends Error {
  constructor(
    public readonly code: number | string,
    public readonly stderr: string,
    public readonly stdout: string = '',
  ) {
    super(stderr || 'Git command failed');
  }
}

@Injectable()
export class GitService implements OnModuleInit {
  private root = '';
  private state = '';
  private recoveryRequired = false;

  constructor(
    @Inject(WORKSPACE_OPTIONS) private readonly options: WorkspaceOptions,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async onModuleInit() {
    this.root = await realpath(this.options.root);
    this.state = resolve(this.options.state, 'git');
    await mkdir(this.state, { recursive: true });
    await this.documents.runExclusive(() => this.recoverPending());
  }

  private run(
    args: string[],
    input?: string,
    index?: string,
    directory = this.root,
    timeout = 20000,
    network = false,
  ): Promise<string> {
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
    Object.assign(env, {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
    });
    if (index) env.GIT_INDEX_FILE = index;
    if (network)
      Object.assign(env, {
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
        SSH_ASKPASS_REQUIRE: 'never',
      });
    return new Promise((resolveOutput, reject) => {
      const child = execFile(
        'git',
        [
          '--no-pager',
          '--literal-pathspecs',
          '-c',
          'core.fsmonitor=false',
          '-C',
          directory,
          ...args,
        ],
        { env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error)
            reject(
              new GitCommandError(
                (error as NodeJS.ErrnoException).code ?? 'GIT_FAILED',
                stderr,
                stdout,
              ),
            );
          else resolveOutput(stdout);
        },
      );
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    });
  }

  private async optional(
    args: string[],
    codes: (number | string)[] = [1, 128],
  ) {
    try {
      return await this.run(args);
    } catch (error) {
      if (error instanceof GitCommandError && codes.includes(error.code))
        return null;
      throw error;
    }
  }

  private async context(): Promise<Context | null> {
    const repository = await this.optional(['rev-parse', '--show-toplevel']);
    if (repository === null) return null;
    const root = await realpath(repository.trim());
    const head =
      (await this.optional(['rev-parse', '--verify', 'HEAD']))?.trim() ?? null;
    const symbolic =
      (await this.optional(['symbolic-ref', '--quiet', 'HEAD']))?.trim() ??
      null;
    return {
      repository: root,
      gitDir: (await this.run(['rev-parse', '--absolute-git-dir'])).trim(),
      prefix: relative(root, this.root).split(sep).join('/'),
      head,
      ref: symbolic ?? 'HEAD',
      branch: symbolic?.replace(/^refs\/heads\//, '') ?? null,
    };
  }

  private async requiredContext(): Promise<Context> {
    const context = await this.context();
    if (!context)
      fail(
        400,
        'NOT_A_REPOSITORY',
        'Рабочее пространство не входит в Git-репозиторий.',
      );
    return context;
  }

  private workspacePath(context: Context, path: string): string | null {
    if (!context.prefix) return path;
    return path.startsWith(context.prefix + '/')
      ? path.slice(context.prefix.length + 1)
      : null;
  }

  private validatePath(path: string): string {
    if (
      typeof path !== 'string' ||
      !path ||
      path.includes('\0') ||
      isAbsolute(path)
    )
      fail(400, 'INVALID_PATH', 'Некорректный путь документа.');
    const inside = relative(this.root, resolve(this.root, path));
    if (inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside))
      fail(400, 'INVALID_PATH', 'Файл находится вне рабочего пространства.');
    return inside.split(sep).join('/');
  }

  private async blob(
    commit: string | null,
    path: string,
  ): Promise<string | null> {
    if (!commit) return null;
    return this.optional(['cat-file', 'blob', commit + ':' + path], [128, 1]);
  }

  private isSystem(source: string | null, path: string): boolean {
    if (source === null) return false;
    try {
      return parseRequirement(source, path).metadata.type === 'system';
    } catch {
      return false;
    }
  }

  private async snapshot(
    context: Context,
    rawPath: string,
  ): Promise<Snapshot | null> {
    const path = this.validatePath(rawPath);
    const repoPath = context.prefix ? context.prefix + '/' + path : path;
    const before = await this.blob(context.head, repoPath);
    let after: string | null = null;
    let mode = '100644';
    let blockedReason: string | undefined;
    let exists = false;
    try {
      const absolute = resolve(this.root, path);
      const stat = await lstat(absolute);
      exists = true;
      if (!stat.isFile() || stat.isSymbolicLink()) {
        blockedReason = 'Этот путь не является обычным Markdown-файлом.';
      } else {
        const safe = await realpath(absolute);
        const inside = relative(this.root, safe);
        if (
          inside === '..' ||
          inside.startsWith('..' + sep) ||
          isAbsolute(inside)
        )
          fail(
            400,
            'INVALID_PATH',
            'Файл находится вне рабочего пространства.',
          );
        after = await readFile(safe, 'utf8');
        mode = stat.mode & 0o111 ? '100755' : '100644';
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!this.isSystem(before, path) && !this.isSystem(after, path))
      return null;
    if (exists && !this.isSystem(after, path))
      blockedReason ??= 'Свойства системного требования некорректны.';
    const token = hash(
      JSON.stringify({
        head: context.head,
        ref: context.ref,
        path,
        after,
        exists,
        mode,
        blockedReason,
      }),
    );
    return {
      path,
      repoPath,
      before,
      after,
      mode,
      token,
      blockedReason,
      kind: !exists ? 'deleted' : before === null ? 'added' : 'modified',
    };
  }

  private async changes(context: Context): Promise<Snapshot[]> {
    const raw = await this.run([
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--ignore-submodules=all',
      '--',
      '.',
    ]);
    const changes: Snapshot[] = [];
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const path = this.workspacePath(context, entry.slice(3));
      if (path === null || !path.endsWith('.md')) continue;
      const snapshot = await this.snapshot(context, path);
      if (snapshot) {
        if (entry.slice(0, 2).includes('U'))
          snapshot.blockedReason = 'В файле есть неразрешенный Git-конфликт.';
        changes.push(snapshot);
      }
    }
    return changes;
  }

  private async staged(): Promise<boolean> {
    try {
      await this.run([
        'diff',
        '--cached',
        '--quiet',
        '--ita-visible-in-index',
        '--no-ext-diff',
        '--no-textconv',
      ]);
      return false;
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) return true;
      throw error;
    }
  }

  async status(): Promise<GitStatus> {
    let context: Context | null;
    try {
      context = await this.context();
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 'ENOENT')
        return {
          available: false,
          reason: 'Git не установлен.',
          hasStagedChanges: false,
          changes: [],
        };
      throw error;
    }
    if (!context)
      return {
        available: false,
        reason: 'Рабочее пространство не входит в Git-репозиторий.',
        hasStagedChanges: false,
        changes: [],
      };
    return {
      available: true,
      repository: basename(context.repository),
      branch: context.branch,
      head: context.head,
      hasStagedChanges: await this.staged(),
      recoveryRequired: this.recoveryRequired,
      push: (await this.pushDestination(context)).info,
      changes: (await this.changes(context)).map((item) => ({
        path: item.path,
        kind: item.kind,
        snapshotToken: item.token,
        blockedReason: item.blockedReason,
      })),
    };
  }

  private async pushDestination(
    context: Context,
  ): Promise<{ info: GitPushTarget; url?: string; ref?: string }> {
    const unavailable = (reason: string) => ({
      info: { available: false, reason },
    });
    if (!context.head) return unavailable('Сначала создайте коммит.');
    if (!context.branch)
      return unavailable('Для Push нужно переключиться на именованную ветку.');
    const configuredRemote = (
      await this.optional([
        'config',
        '--get',
        'branch.' + context.branch + '.remote',
      ])
    )?.trim();
    const merges = (
      await this.optional([
        'config',
        '--get-all',
        'branch.' + context.branch + '.merge',
      ])
    )
      ?.trim()
      .split('\n');
    const remotes = (await this.run(['remote'])).trim().split('\n');
    const remote =
      configuredRemote ?? (remotes.includes('origin') ? 'origin' : undefined);
    if (!remote)
      return unavailable(
        'Не настроен удаленный репозиторий: добавьте origin или upstream ветки в Git.',
      );
    if (remote === '.' || !remotes.includes(remote))
      return unavailable(
        'Upstream ветки не указывает на настроенный удаленный репозиторий.',
      );
    if (
      (configuredRemote && merges?.length !== 1) ||
      (!configuredRemote && merges)
    )
      return unavailable('Некорректная настройка upstream ветки.');
    const ref = configuredRemote ? merges![0] : 'refs/heads/' + context.branch;
    if (
      !ref.startsWith('refs/heads/') ||
      (await this.optional(['check-ref-format', ref])) === null
    )
      return unavailable(
        'Push поддерживается только в удаленную ветку refs/heads.',
      );
    const urls = (
      await this.optional(
        ['remote', 'get-url', '--push', '--all', '--', remote],
        [1, 2, 128],
      )
    )
      ?.trim()
      .split('\n');
    if (!urls?.[0] || urls.length !== 1)
      return unavailable(
        'Для Push нужен ровно один адрес отправки выбранного remote.',
      );
    const url = urls[0];
    return {
      info: {
        available: true,
        remote,
        branch: ref.slice('refs/heads/'.length),
        token: hash(
          JSON.stringify({
            head: context.head,
            ref: context.ref,
            remote,
            destination: ref,
            url,
          }),
        ),
      },
      url,
      ref,
    };
  }

  push(input: unknown): Promise<GitPushResult> {
    return this.documents.runExclusive(async () => {
      const parsed = gitPushRequestSchema.safeParse(input);
      if (!parsed.success)
        fail(
          400,
          'VALIDATION_ERROR',
          'Обновите состояние Git перед отправкой.',
        );
      await this.recoverPending();
      if (this.recoveryRequired)
        fail(
          409,
          'RECOVERY_REQUIRED',
          'Перед Push нужна проверка незавершенной Git-операции.',
        );
      const context = await this.requiredContext();
      const target = await this.pushDestination(context);
      if (!target.info.available)
        fail(400, 'PUSH_UNAVAILABLE', target.info.reason!);
      if (
        parsed.data.expectedHead !== context.head ||
        parsed.data.targetToken !== target.info.token
      )
        fail(
          409,
          'PUSH_STATE_CHANGED',
          'Ветка, коммит или адрес отправки изменились. Обновите Git и подтвердите Push заново.',
        );
      try {
        // Pin the confirmed commit and destination; never send later commits or other refs.
        await this.run(
          [
            'push',
            '--porcelain',
            '--no-force',
            '--no-follow-tags',
            '--recurse-submodules=no',
            '--',
            target.url!,
            parsed.data.expectedHead + ':' + target.ref!,
          ],
          undefined,
          undefined,
          this.root,
          60000,
          true,
        );
      } catch (error) {
        if (!(error instanceof GitCommandError)) throw error;
        const output = error.stderr + '\n' + error.stdout;
        if (
          /non-fast-forward|fetch first|updates were rejected|\[rejected\]/i.test(
            output,
          )
        )
          fail(
            409,
            'PUSH_REJECTED',
            'Удаленная ветка содержит другие коммиты. Сначала получите и согласуйте изменения через Git; force-push отключен.',
          );
        if (
          /authentication failed|could not read username|permission.*denied|publickey|access denied|authorization failed|terminal prompts disabled|could not read password|returned error: (401|403)/i.test(
            output,
          )
        )
          fail(
            401,
            'PUSH_AUTH_REQUIRED',
            'Не удалось авторизоваться. Проверьте доступ к репозиторию и настройки Git/SSH на машине сервера.',
          );
        if (/remote rejected|hook declined/i.test(output))
          fail(
            409,
            'PUSH_REJECTED',
            'Сервер отклонил Push. Проверьте права доступа и правила защищенной ветки.',
          );
        // Git output can contain a credential-bearing URL; do not return it to the browser.
        fail(
          502,
          'PUSH_UNCONFIRMED',
          'Подтверждение Push не получено. Проверьте соединение и доступ к репозиторию. Отправка могла завершиться; ее можно повторить без force-push.',
        );
      }
      return {
        remote: target.info.remote!,
        branch: target.info.branch!,
        head: parsed.data.expectedHead,
      };
    });
  }

  private patch(
    path: string,
    before: string | null,
    after: string | null,
  ): string {
    return createTwoFilesPatch(
      'a/' + path,
      'b/' + path,
      before ?? '',
      after ?? '',
      '',
      '',
      { context: 3 },
    );
  }

  async diff(path: string, commit?: string): Promise<GitDiff> {
    const context = await this.requiredContext();
    if (commit) {
      const details = await this.details(commit);
      if (!details.files.some((file) => file.path === path))
        fail(404, 'NOT_FOUND', 'Документа нет в выбранной версии.');
      const parent = await this.parent(commit);
      const repoPath = context.prefix
        ? context.prefix + '/' + this.validatePath(path)
        : this.validatePath(path);
      return {
        path,
        patch: this.patch(
          path,
          await this.blob(parent, repoPath),
          await this.blob(commit, repoPath),
        ),
        snapshotToken: null,
      };
    }
    const snapshot = (await this.changes(context)).find(
      (item) => item.path === path,
    );
    if (!snapshot)
      fail(
        404,
        'NOT_FOUND',
        'У документа нет сохраненных изменений относительно HEAD.',
      );
    return {
      path,
      patch: this.patch(path, snapshot.before, snapshot.after),
      snapshotToken: snapshot.token,
      blockedReason: snapshot.blockedReason,
    };
  }

  private async parent(commit: string): Promise<string | null> {
    const values = (
      await this.run(['rev-list', '--parents', '-n', '1', commit])
    )
      .trim()
      .split(' ');
    return values[1] ?? null;
  }

  async details(commit: string): Promise<GitCommit> {
    if (!oid.test(commit))
      fail(400, 'INVALID_COMMIT', 'Некорректный идентификатор версии.');
    const context = await this.requiredContext();
    const metadata = await this.optional([
      'show',
      '--no-patch',
      '--format=%H%x00%an%x00%aI%x00%B',
      commit,
    ]);
    if (!metadata) fail(404, 'NOT_FOUND', 'Версия не найдена.');
    const [commitHash, author, date, ...message] = metadata.split('\0');
    if (!oid.test(commitHash))
      fail(404, 'NOT_FOUND', 'Объект не является версией Git.');
    const parent = await this.parent(commit);
    const raw = await this.run([
      'diff-tree',
      '--no-commit-id',
      '--name-status',
      '-z',
      '-r',
      '--no-renames',
      ...(parent ? [parent, commit] : ['--root', commit]),
      '--',
      '.',
    ]);
    const parts = raw.split('\0');
    const files: GitCommitFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i],
        repoPath = parts[i + 1];
      const path = this.workspacePath(context, repoPath);
      if (path === null || !path.endsWith('.md')) continue;
      if (
        !this.isSystem(await this.blob(commit, repoPath), path) &&
        !this.isSystem(await this.blob(parent, repoPath), path)
      )
        continue;
      files.push({
        path,
        kind: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      });
    }
    return {
      hash: commitHash,
      author,
      date,
      message: message.join('\0').trim(),
      files,
    };
  }

  async history(offset = 0): Promise<GitHistory> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail(400, 'INVALID_OFFSET', 'Некорректная страница истории.');
    const context = await this.requiredContext();
    if (!context.head) return { commits: [], hasMore: false, nextOffset: 0 };
    const ids = (
      await this.run([
        'log',
        '--format=%H',
        '--max-count=20',
        '--skip=' + offset,
        '--',
        '.',
      ])
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    const commits: GitCommit[] = [];
    for (const id of ids) {
      const commit = await this.details(id);
      if (commit.files.length) commits.push(commit);
    }
    return {
      commits,
      hasMore: ids.length === 20,
      nextOffset: offset + ids.length,
    };
  }

  private recordPath(id: string) {
    if (!z.uuid().safeParse(id).success)
      fail(400, 'INVALID_OPERATION', 'Некорректный ID операции.');
    return resolve(this.state, id + '.json');
  }

  private async readRecord(id: string): Promise<Record> {
    try {
      const value = recordSchema.parse(
        JSON.parse(await readFile(this.recordPath(id), 'utf8')),
      ) as Record;
      if (value.workspace !== this.root)
        fail(
          409,
          'WORKSPACE_MISMATCH',
          'Журнал относится к другому рабочему пространству.',
        );
      return value;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        fail(404, 'OPERATION_NOT_FOUND', 'Операция еще не зарегистрирована.');
      fail(500, 'JOURNAL_ERROR', 'Не удалось прочитать журнал Git.');
    }
  }

  private writeRecord(record: Record) {
    return atomicWrite(this.recordPath(record.id), JSON.stringify(record));
  }
  private ownerPath(record: Record) {
    return resolve(record.gitDir, 'specide-' + record.id + '.index');
  }
  private temporaryIndex(id: string) {
    return resolve(this.state, id + '.index');
  }
  private indexPath(record: Record) {
    return resolve(record.gitDir, 'index');
  }
  private lockPath(record: Record) {
    return resolve(record.gitDir, 'index.lock');
  }
  private async fileHash(path: string) {
    try {
      return hash(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async ownsLock(record: Record) {
    try {
      const [owner, lock] = await Promise.all([
        lstat(this.ownerPath(record)),
        lstat(this.lockPath(record)),
      ]);
      return owner.dev === lock.dev && owner.ino === lock.ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async cleanup(record: Record) {
    if (await this.ownsLock(record)) await unlink(this.lockPath(record));
    for (const path of [this.ownerPath(record), this.temporaryIndex(record.id)])
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }

  private async recover(record: Record): Promise<Record> {
    if (record.status !== 'pending') return record;
    const context = await this.requiredContext();
    if (
      context.repository !== record.repository ||
      context.gitDir !== record.gitDir ||
      context.ref !== record.ref
    ) {
      record.status = 'needs_review';
      record.error = {
        code: 'RECOVERY_REQUIRED',
        message:
          'Репозиторий или ветка изменились во время фиксации. Нужна проверка состояния Git.',
      };
    } else if (record.next && context.head === record.next) {
      if (await this.ownsLock(record)) {
        if ((await this.fileHash(this.ownerPath(record))) !== record.indexAfter)
          fail(409, 'RECOVERY_REQUIRED', 'Подготовленный индекс изменился.');
        await rename(this.lockPath(record), this.indexPath(record));
      }
      if ((await this.fileHash(this.indexPath(record))) === record.indexAfter) {
        record.status = 'succeeded';
        record.commit = await this.details(record.next);
      } else {
        record.status = 'needs_review';
        record.error = {
          code: 'RECOVERY_REQUIRED',
          message:
            'Версия создана, но индекс Git изменился. Автоматическая перезапись отключена.',
        };
      }
    } else if (context.head === record.base) {
      record.status = 'failed';
      record.error = {
        code: 'COMMIT_INTERRUPTED',
        message:
          'Фиксация не завершилась. Можно повторить ее; рабочие файлы сохранены.',
      };
    } else {
      record.status = 'needs_review';
      record.error = {
        code: 'RECOVERY_REQUIRED',
        message:
          'История Git изменилась во время операции. Нужна проверка состояния.',
      };
    }
    await this.writeRecord(record);
    // Only the lock linked to our own file may be removed.
    await this.cleanup(record);
    return record;
  }

  private async recoverPending() {
    this.recoveryRequired = false;
    for (const name of await readdir(this.state)) {
      if (/^[a-f0-9-]{36}\.json$/.test(name)) {
        const record = await this.recover(
          await this.readRecord(name.slice(0, -5)),
        );
        if (record.status === 'needs_review') this.recoveryRequired = true;
      }
    }
  }

  private publicOperation(record: Record): GitOperation {
    return {
      id: record.id,
      status: record.status,
      commit: record.commit,
      error: record.error,
    };
  }

  async assertCanSwitch() {
    for (const name of await readdir(this.state)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const record = await this.readRecord(name.slice(0, -5));
      if (record.status === 'pending') {
        fail(
          409,
          'PENDING_OPERATIONS',
          'Перед переключением нужно проверить незавершенную Git-операцию.',
        );
      }
    }
  }

  operation(id: string): Promise<GitOperation> {
    return this.documents.runExclusive(async () => {
      const record = await this.recover(await this.readRecord(id));
      if (record.status === 'needs_review') this.recoveryRequired = true;
      return this.publicOperation(record);
    });
  }

  protected async publishHead(
    ref: string,
    next: string,
    previous: string | null,
  ) {
    await this.run([
      'update-ref',
      '-m',
      'specIDE: requirements',
      ref,
      next,
      previous ?? '0'.repeat(next.length),
    ]);
  }

  commit(input: unknown): Promise<GitOperation> {
    return this.documents.runExclusive(async () => {
      const parsed = gitCommitRequestSchema.safeParse(input);
      if (!parsed.success)
        fail(
          400,
          'VALIDATION_ERROR',
          'Выберите документы, просмотрите изменения и укажите описание версии.',
        );
      const request = parsed.data;
      const fingerprint = hash(JSON.stringify(request));
      try {
        const previous = await this.readRecord(request.operationId);
        if (previous.fingerprint !== fingerprint)
          fail(
            409,
            'OPERATION_REUSED',
            'ID фиксации уже использован с другими данными.',
          );
        return this.publicOperation(await this.recover(previous));
      } catch (error) {
        if (!(error instanceof HttpException) || error.getStatus() !== 404)
          throw error;
      }
      await this.recoverPending();
      if (this.recoveryRequired)
        fail(
          409,
          'RECOVERY_REQUIRED',
          'Нужно проверить незавершенную Git-операцию перед новой фиксацией.',
        );
      const context = await this.requiredContext();
      if (await this.staged())
        fail(
          409,
          'INDEX_NOT_EMPTY',
          'В индексе Git уже подготовлены изменения. Они не будут включены или сброшены приложением.',
        );
      if (
        new Set(request.files.map((file) => file.path)).size !==
        request.files.length
      )
        fail(400, 'DUPLICATE_PATH', 'Документ выбран несколько раз.');
      const current = await this.changes(context);
      const validPaths = new Set(
        (await this.documents.list()).documents.map((doc) => doc.path),
      );
      const selected: Snapshot[] = [];
      for (const file of request.files) {
        const snapshot = current.find((item) => item.path === file.path);
        if (!snapshot || snapshot.token !== file.snapshotToken)
          fail(
            409,
            'SNAPSHOT_CHANGED',
            'Файл или базовая версия изменились после просмотра. Обновите сравнение и подтвердите его заново.',
          );
        if (
          snapshot.blockedReason ||
          (snapshot.kind !== 'deleted' && !validPaths.has(snapshot.path))
        )
          fail(
            409,
            'INVALID_DOCUMENT',
            snapshot.blockedReason ??
              'У документа некорректные или повторные свойства.',
          );
        selected.push(snapshot);
      }
      try {
        await this.run(['var', 'GIT_AUTHOR_IDENT']);
        await this.run(['var', 'GIT_COMMITTER_IDENT']);
      } catch {
        fail(
          400,
          'IDENTITY_REQUIRED',
          'Для Git не настроены имя и email автора.',
        );
      }
      const record: Record = {
        id: request.operationId,
        workspace: this.root,
        repository: context.repository,
        gitDir: context.gitDir,
        fingerprint,
        ref: context.ref,
        base: context.head,
        next: null,
        indexBefore: await this.fileHash(resolve(context.gitDir, 'index')),
        indexAfter: null,
        status: 'pending',
      };
      await this.writeRecord(record);
      try {
        const index = this.temporaryIndex(record.id);
        if (record.indexBefore !== null) {
          await copyFile(
            this.indexPath(record),
            index,
            constants.COPYFILE_EXCL,
          );
          await this.run(
            ['update-index', '--no-split-index'],
            undefined,
            index,
          );
        } else {
          await this.run(
            context.head
              ? ['read-tree', context.head]
              : ['read-tree', '--empty'],
            undefined,
            index,
          );
        }
        for (const item of selected) {
          if (item.kind === 'deleted')
            await this.run(
              ['update-index', '--force-remove', '--', item.repoPath],
              undefined,
              index,
              context.repository,
            );
          else {
            const object = (
              await this.run(
                ['hash-object', '-w', '--stdin'],
                item.after!,
                index,
              )
            ).trim();
            await this.run(
              [
                'update-index',
                '--add',
                '--cacheinfo',
                item.mode,
                object,
                item.repoPath,
              ],
              undefined,
              index,
              context.repository,
            );
          }
        }
        const tree = (await this.run(['write-tree'], undefined, index)).trim();
        record.next = (
          await this.run(
            [
              'commit-tree',
              '--no-gpg-sign',
              tree,
              ...(context.head ? ['-p', context.head] : []),
              '-F',
              '-',
            ],
            request.message + '\n',
            index,
          )
        ).trim();
        record.indexAfter = await this.fileHash(index);
        await this.writeRecord(record);
        await copyFile(index, this.ownerPath(record), constants.COPYFILE_EXCL);
        const prepared = await open(this.ownerPath(record), 'r+');
        try {
          await prepared.sync();
        } finally {
          await prepared.close();
        }
        try {
          await link(this.ownerPath(record), this.lockPath(record));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            fail(423, 'GIT_BUSY', 'Индекс Git занят другой операцией.');
          throw error;
        }
        const latest = await this.requiredContext();
        if (
          latest.head !== record.base ||
          latest.ref !== record.ref ||
          (await this.fileHash(this.indexPath(record))) !== record.indexBefore
        )
          fail(
            409,
            'SNAPSHOT_CHANGED',
            'История или индекс Git изменились. Обновите сравнение.',
          );
        await this.publishHead(record.ref, record.next, record.base);
        await rename(this.lockPath(record), this.indexPath(record));
        record.commit = await this.details(record.next);
        record.status = 'succeeded';
        await this.writeRecord(record);
        await this.cleanup(record);
        return this.publicOperation(record);
      } catch (error) {
        if (error instanceof HttpException) {
          const latest = await this.requiredContext();
          if (latest.head === record.base) {
            record.status = 'failed';
            record.error = {
              code: 'COMMIT_FAILED',
              message: (error.getResponse() as { message: string }).message,
            };
            await this.writeRecord(record);
            await this.cleanup(record);
            throw error;
          }
        }
        fail(
          503,
          'RESULT_UNKNOWN',
          'Результат фиксации пока неизвестен. Проверьте операцию; новый коммит автоматически не создается.',
        );
      }
    });
  }
}
