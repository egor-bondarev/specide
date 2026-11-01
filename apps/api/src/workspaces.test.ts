import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceManager } from './workspaces';

const execute = promisify(execFile);
let directory: string;
let root: string;
let state: string;
let repo: string;
let productRoot: string;
let manager: WorkspaceManager;

async function start() {
  const value = new WorkspaceManager({ root, state, productRoot });
  await value.onModuleInit();
  return value;
}
async function connect(path: string | null, service = manager) {
  return service.connect({
    operationId: randomUUID(),
    expectedWorkspaceId: (await service.current()).id,
    path,
  });
}
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), 'specide-connection-')),
  );
  root = join(directory, 'default');
  state = join(directory, 'state');
  repo = join(directory, 'requirements');
  productRoot = join(directory, 'product');
  for (const path of [root, repo, productRoot]) await mkdir(path);
  for (const path of [repo, productRoot])
    await execute('git', ['init', '-q', path]);
  manager = await start();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('independent repository connection', () => {
  it('persists selection, creates documents only in the target, and restores default', async () => {
    const initial = await manager.current();
    const selected = await connect(repo);
    expect(selected).toMatchObject({
      path: repo,
      source: 'repository',
      documentCount: 0,
    });
    expect(await readdir(repo)).toEqual(['.git']);
    const operationId = randomUUID();
    const created = await manager.run(
      selected.id,
      (session) =>
        session.documents.create({
          operationId,
          title: 'Independent requirement',
        }),
      true,
    );
    expect(created.status).toBe('succeeded');
    expect(
      await readFile(join(repo, 'requirements/system/SR-001.md'), 'utf8'),
    ).toContain('Independent requirement');
    expect(await readdir(root)).toEqual([]);
    const restarted = await start();
    expect(await restarted.current()).toMatchObject({
      id: selected.id,
      storageKey: selected.storageKey,
      path: repo,
      documentCount: 1,
    });
    const reset = await connect(null, restarted);
    expect(reset).toMatchObject({
      path: root,
      source: 'default',
      storageKey: initial.storageKey,
    });
    expect(reset.id).not.toBe(initial.id);
    await expect(
      restarted.run(reset.id, (session) =>
        session.documents.operation(operationId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const again = await connect(repo, restarted);
    expect(again.storageKey).toBe(selected.storageKey);
    expect(
      await restarted.run(again.id, (session) =>
        session.documents.operation(operationId),
      ),
    ).toMatchObject({ status: 'succeeded' });
  });

  it('recovers a lost connection response, and rejects reuse or stale replay', async () => {
    const request = {
      operationId: randomUUID(),
      expectedWorkspaceId: (await manager.current()).id,
      path: repo,
    };
    const selected = await manager.connect(request);
    expect(await manager.connect(request)).toEqual(selected);
    expect(await manager.connection(request.operationId)).toEqual(selected);
    manager = await start();
    expect(await manager.connect(request)).toEqual(selected);
    await expect(
      manager.connect({ ...request, path: root }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'OPERATION_REUSED' },
    });
    await connect(null);
    await expect(manager.connect(request)).rejects.toMatchObject({
      status: 409,
      response: { code: 'WORKSPACE_CHANGED' },
    });
    expect((await manager.current()).path).toBe(root);
  });

  it('rejects stale and unscoped writes even when document IDs coincide', async () => {
    const old = await manager.current();
    const current = await connect(repo);
    const create = (
      session: Parameters<Parameters<WorkspaceManager['run']>[1]>[0],
    ) =>
      session.documents.create({
        operationId: randomUUID(),
        title: 'Wrong destination',
      });
    await expect(manager.run(old.id, create, true)).rejects.toMatchObject({
      status: 409,
    });
    await expect(manager.run(undefined, create, true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      manager.run(old.id, (session) => session.git.status()),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await manager.run(current.id, (session) => session.documents.list()))
        .documents,
    ).toEqual([]);
  });

  it('finishes an in-flight operation in the original workspace before switching', async () => {
    const initial = await manager.current();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = manager.run(
      initial.id,
      async (session) => {
        entered();
        await gate;
        return session.documents.create({
          operationId: randomUUID(),
          title: 'Before switch',
        });
      },
      true,
    );
    await started;
    const switching = manager.connect({
      operationId: randomUUID(),
      expectedWorkspaceId: initial.id,
      path: repo,
    });
    release();
    expect((await write).status).toBe('succeeded');
    expect((await switching).path).toBe(repo);
    expect(
      await readFile(join(root, 'requirements/system/SR-001.md'), 'utf8'),
    ).toContain('Before switch');
    expect(await readdir(repo)).toEqual(['.git']);
  });

  it('rejects invalid, non-Git, nested, product, and state-overlapping paths without changing selection', async () => {
    const initial = await manager.current();
    const nested = join(repo, 'nested');
    await mkdir(nested);
    const alias = join(directory, 'product-alias');
    await symlink(productRoot, alias);
    for (const path of [
      'relative',
      join(directory, 'missing'),
      root,
      nested,
      productRoot,
      alias,
      state,
    ]) {
      await expect(connect(path)).rejects.toMatchObject({ status: 400 });
      expect((await manager.current()).id).toBe(initial.id);
    }
    await expect(manager.connection(randomUUID())).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects a linked worktree of the product repository', async () => {
    // Create the fixture commit only inside the disposable product repository.
    const emptyTree = (
      await execute('git', [
        '-C',
        productRoot,
        'hash-object',
        '-w',
        '-t',
        'tree',
        '/dev/null',
      ])
    ).stdout.trim();
    const commit = (
      await execute('git', [
        '-C',
        productRoot,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit-tree',
        emptyTree,
        '-m',
        'Fixture',
      ])
    ).stdout.trim();
    await execute('git', ['-C', productRoot, 'update-ref', 'HEAD', commit]);
    const worktree = join(directory, 'product-worktree');
    await execute('git', [
      '-C',
      productRoot,
      'worktree',
      'add',
      '--detach',
      worktree,
      commit,
    ]);
    await expect(connect(worktree)).rejects.toMatchObject({
      status: 400,
      response: { code: 'PRODUCT_REPOSITORY' },
    });
  });

  it.each(['document', 'git'])(
    'blocks switching while a %s journal outcome is unresolved',
    async (kind) => {
      const initial = await manager.current();
      const id = randomUUID();
      const record =
        kind === 'document'
          ? {
              id,
              workspace: root,
              fingerprint: 'test',
              path: 'SR-001.md',
              beforeVersion: null,
              afterVersion: 'test',
              status: 'pending',
            }
          : {
              id,
              workspace: root,
              repository: root,
              gitDir: join(root, '.git'),
              fingerprint: 'test',
              ref: 'refs/heads/main',
              base: null,
              next: null,
              indexBefore: null,
              indexAfter: null,
              status: 'pending',
            };
      const recordPath = join(
        kind === 'git' ? join(state, 'git') : state,
        id + '.json',
      );
      await writeFile(recordPath, JSON.stringify(record));
      await expect(connect(repo)).rejects.toMatchObject({ status: 409 });
      expect((await manager.current()).id).toBe(initial.id);
      await writeFile(
        recordPath,
        JSON.stringify({ ...record, status: 'needs_review' }),
      );
      expect((await connect(repo)).path).toBe(repo);
    },
  );

  it('falls back visibly if the selected repository is unavailable after restart', async () => {
    const selected = await connect(repo);
    await rm(repo, { recursive: true, force: true });
    const restarted = await start();
    expect(await restarted.current()).toMatchObject({
      path: root,
      source: 'default',
      connectionError: expect.any(String),
    });
    expect((await restarted.current()).id).not.toBe(selected.id);
  });
});
