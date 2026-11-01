import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { DocumentsService } from './documents';
import { GitService } from './git';

const exec = promisify(execFile);
const source = (id: string, body = 'Original') =>
  '---\nid: ' +
  id +
  '\ntype: system\ntitle: ' +
  id +
  '\nstatus: draft\n---\n\n' +
  body +
  '\n';
let directory: string, repository: string, root: string, state: string;
let documents: DocumentsService, service: GitService;
const path = 'requirements/system/SR-001.md';

async function git(...args: string[]) {
  return (
    await exec('git', ['-C', repository, ...args], {
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
  ).stdout.trim();
}
async function selection(paths = [path]) {
  return Promise.all(
    paths.map(async (path) => {
      const diff = await service.diff(path);
      return { path, snapshotToken: diff.snapshotToken! };
    }),
  );
}
async function request(paths = [path]) {
  return {
    operationId: randomUUID(),
    message: 'Update requirements',
    files: await selection(paths),
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'specide-git-test-'));
  repository = join(directory, 'repository');
  root = join(repository, 'workspace');
  state = join(directory, 'state');
  await mkdir(join(root, 'requirements/system'), { recursive: true });
  await writeFile(join(root, path), source('SR-001'));
  await writeFile(join(repository, 'README.md'), 'Application source\n');
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'specIDE test');
  await git('config', 'user.email', 'specide@example.test');
  await git('config', 'commit.gpgsign', 'false');
  await git('config', 'core.hooksPath', join(directory, 'no-hooks'));
  await git('add', '--', '.');
  await git('commit', '-m', 'Initial fixture');
  documents = new DocumentsService({ root, state });
  await documents.onModuleInit();
  service = new GitService({ root, state }, documents);
  await service.onModuleInit();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('Git requirements workflow', () => {
  it('creates the first version in a repository without HEAD', async () => {
    repository = join(directory, 'unborn');
    root = join(repository, 'workspace');
    state = join(directory, 'unborn-state');
    await mkdir(join(root, 'requirements/system'), { recursive: true });
    await writeFile(join(root, path), source('SR-001', 'First version'));
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'specIDE test');
    await git('config', 'user.email', 'specide@example.test');
    await git('config', 'commit.gpgsign', 'false');
    documents = new DocumentsService({ root, state });
    await documents.onModuleInit();
    service = new GitService({ root, state }, documents);
    await service.onModuleInit();
    expect((await service.status()).head).toBeNull();
    expect((await service.diff(path)).patch).toContain('+First version');
    const result = await service.commit(await request());
    expect(result.status).toBe('succeeded');
    expect(result.commit?.files).toEqual([{ path, kind: 'added' }]);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(await git('diff', '--cached', '--name-only')).toBe('');
  });

  it('rejects a preview after HEAD changes even if the working document stays the same', async () => {
    await writeFile(join(root, path), source('SR-001', 'Previewed'));
    const input = await request();
    await writeFile(join(repository, 'README.md'), 'Other commit\n');
    await git('add', '--', 'README.md');
    await git('commit', '-m', 'Other change');
    const head = await git('rev-parse', 'HEAD');
    await expect(service.commit(input)).rejects.toMatchObject({ status: 409 });
    expect(await git('rev-parse', 'HEAD')).toBe(head);
    expect(await git('diff', '--cached', '--name-only')).toBe('');
  });

  it('treats intent-to-add entries as pre-existing staged work', async () => {
    await writeFile(join(root, path), source('SR-001', 'Changed'));
    await writeFile(join(repository, 'unrelated.ts'), 'export {};\n');
    await git('add', '-N', '--', 'unrelated.ts');
    const index = await readFile(join(repository, '.git/index'));
    expect((await service.status()).hasStagedChanges).toBe(true);
    await expect(service.commit(await request())).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(join(repository, '.git/index'))).toEqual(index);
  });
  it('scopes status and history to system requirements inside a parent repository', async () => {
    await writeFile(join(root, path), source('SR-001', 'Changed'));
    await writeFile(
      join(root, 'requirements/system/SR-002.md'),
      source('SR-002', 'New'),
    );
    await writeFile(
      join(root, 'BR-001.md'),
      source('BR-001').replace('type: system', 'type: business'),
    );
    await writeFile(join(repository, 'README.md'), 'Unrelated source edit\n');
    const status = await service.status();
    expect(status.branch).toBe('main');
    expect(status.changes.map((file) => [file.path, file.kind])).toEqual([
      [path, 'modified'],
      ['requirements/system/SR-002.md', 'added'],
    ]);
    const history = await service.history();
    expect(history.commits).toHaveLength(1);
    expect(history.commits[0].files).toEqual([{ path, kind: 'added' }]);
    const diff = await service.diff('requirements/system/SR-002.md');
    expect(diff.patch).toContain('+New');
  });

  it('commits only the selected reviewed content and leaves unrelated edits unstaged', async () => {
    await writeFile(join(root, path), source('SR-001', 'Selected'));
    const other = 'requirements/system/SR-002.md';
    await writeFile(join(root, other), source('SR-002', 'Not selected'));
    await writeFile(join(repository, 'README.md'), 'Unrelated source edit\n');
    const result = await service.commit(await request());
    expect(result.status).toBe('succeeded');
    expect(result.commit?.files).toEqual([{ path, kind: 'modified' }]);
    expect(await git('show', 'HEAD:workspace/' + path)).toContain('Selected');
    expect(await git('show', 'HEAD:README.md')).toBe('Application source');
    expect(await git('diff', '--cached', '--name-only')).toBe('');
    expect(await git('diff', '--', 'README.md')).toContain(
      '+Unrelated source edit',
    );
    expect((await service.status()).changes.map((file) => file.path)).toEqual([
      other,
    ]);
  });

  it('rejects a stale preview without changing HEAD or the index', async () => {
    await writeFile(join(root, path), source('SR-001', 'Previewed'));
    const input = await request();
    const before = await git('rev-parse', 'HEAD');
    const index = await readFile(join(repository, '.git/index'));
    await writeFile(join(root, path), source('SR-001', 'Not previewed'));
    await expect(service.commit(input)).rejects.toMatchObject({ status: 409 });
    expect(await git('rev-parse', 'HEAD')).toBe(before);
    expect(await readFile(join(repository, '.git/index'))).toEqual(index);
  });

  it('does not touch pre-existing staged changes or a foreign index lock', async () => {
    await writeFile(join(root, path), source('SR-001', 'Changed'));
    await writeFile(join(repository, 'README.md'), 'Already staged\n');
    await git('add', '--', 'README.md');
    const index = await readFile(join(repository, '.git/index'));
    await expect(service.commit(await request())).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(join(repository, '.git/index'))).toEqual(index);
    await git('restore', '--staged', '--', 'README.md');
    await writeFile(join(repository, '.git/index.lock'), 'foreign lock');
    await expect(service.commit(await request())).rejects.toMatchObject({
      status: 423,
    });
    expect(await readFile(join(repository, '.git/index.lock'), 'utf8')).toBe(
      'foreign lock',
    );
    await unlink(join(repository, '.git/index.lock'));
  });

  it('returns the same commit after a retry and restart', async () => {
    await writeFile(join(root, path), source('SR-001', 'Commit once'));
    const input = await request();
    const first = await service.commit(input);
    const restarted = new GitService({ root, state }, documents);
    await restarted.onModuleInit();
    expect(await restarted.commit(input)).toEqual(first);
    expect(await git('rev-list', '--count', 'HEAD')).toBe('2');
    await expect(
      restarted.commit({ ...input, message: 'Different' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([false, true])(
    'recovers an interruption at HEAD publication (published: %s)',
    async (published) => {
      class InterruptedGit extends GitService {
        protected override async publishHead(
          ref: string,
          next: string,
          previous: string | null,
        ) {
          if (published) await super.publishHead(ref, next, previous);
          throw new Error('Simulated process interruption');
        }
      }
      await writeFile(join(root, path), source('SR-001', 'Recovery'));
      const input = await request();
      const interrupted = new InterruptedGit({ root, state }, documents);
      await interrupted.onModuleInit();
      await expect(interrupted.commit(input)).rejects.toMatchObject({
        status: 503,
      });
      const restarted = new GitService({ root, state }, documents);
      await restarted.onModuleInit();
      const result = await restarted.operation(input.operationId);
      expect(result.status).toBe(published ? 'succeeded' : 'failed');
      await expect(
        readFile(join(repository, '.git/index.lock')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await git('diff', '--cached', '--name-only')).toBe('');
      if (published) {
        expect(await git('show', 'HEAD:workspace/' + path)).toContain(
          'Recovery',
        );
        expect((await restarted.commit(input)).commit?.hash).toBe(
          result.commit?.hash,
        );
      } else {
        const second = await restarted.commit({
          ...input,
          operationId: randomUUID(),
        });
        expect(second.status).toBe('succeeded');
      }
    },
  );

  it('supports a deletion with its historical diff', async () => {
    await unlink(join(root, path));
    const diff = await service.diff(path);
    expect(diff.patch).toContain('-Original');
    const result = await service.commit(await request());
    expect(result.commit?.files).toEqual([{ path, kind: 'deleted' }]);
    expect((await service.diff(path, result.commit!.hash)).patch).toContain(
      '-Original',
    );
  });

  it('does not initialize a non-Git workspace implicitly', async () => {
    const outside = join(directory, 'plain');
    await mkdir(outside);
    const outsideState = join(directory, 'plain-state');
    const docs = new DocumentsService({ root: outside, state: outsideState });
    await docs.onModuleInit();
    const plain = new GitService({ root: outside, state: outsideState }, docs);
    await plain.onModuleInit();
    expect((await plain.status()).available).toBe(false);
    await expect(readFile(join(outside, '.git'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function remoteRepository(name = 'origin', folder = 'remote.git') {
  const remote = join(directory, folder);
  await exec('git', ['init', '--bare', '-q', remote]);
  await git('remote', 'add', name, remote);
  return remote;
}
async function pushRequest() {
  const status = await service.status();
  expect(status.push?.available).toBe(true);
  return { expectedHead: status.head!, targetToken: status.push!.token! };
}
async function remoteRefs(remote: string) {
  return (
    await exec('git', [
      '--git-dir',
      remote,
      'for-each-ref',
      '--format=%(refname)',
    ])
  ).stdout
    .trim()
    .split('\n')
    .filter(Boolean);
}

describe('Git push', () => {
  it('shows a reason when no remote is configured or HEAD is detached', async () => {
    expect((await service.status()).push).toMatchObject({
      available: false,
      reason: expect.any(String),
    });
    await remoteRepository();
    await git('checkout', '--detach');
    expect((await service.status()).push).toMatchObject({
      available: false,
      reason: expect.stringContaining('именованную ветку'),
    });
  });

  it('pushes only the confirmed commit to origin/main, preserves local edits, and safely repeats', async () => {
    const remote = await remoteRepository();
    await git('tag', '-a', 'unrequested-tag', '-m', 'Do not push');
    await git('branch', 'other');
    await git('config', 'push.followTags', 'true');
    await git('config', 'remote.origin.mirror', 'true');
    await git(
      'config',
      'remote.origin.push',
      'refs/heads/main:refs/heads/unwanted',
    );
    await writeFile(
      join(repository, 'README.md'),
      'Staged but not committed\n',
    );
    await git('add', 'README.md');
    await writeFile(join(root, path), source('SR-001', 'Unsaved in Git'));
    const index = await readFile(join(repository, '.git/index'));
    const input = await pushRequest();
    const result = await service.push(input);
    expect(result).toEqual({
      remote: 'origin',
      branch: 'main',
      head: input.expectedHead,
    });
    expect(await service.push(input)).toEqual(result);
    expect(await remoteRefs(remote)).toEqual(['refs/heads/main']);
    expect(
      (
        await exec('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])
      ).stdout.trim(),
    ).toBe(input.expectedHead);
    expect(
      (await exec('git', ['--git-dir', remote, 'show', 'main:README.md']))
        .stdout,
    ).toBe('Application source\n');
    expect(await readFile(join(repository, '.git/index'))).toEqual(index);
    expect(await readFile(join(root, path), 'utf8')).toContain(
      'Unsaved in Git',
    );
    expect(await git('rev-parse', 'HEAD')).toBe(input.expectedHead);
  });

  it('uses the upstream remote and branch rather than origin or a matching local name', async () => {
    const origin = await remoteRepository();
    const remote = await remoteRepository('team', 'team.git');
    await git('push', '-u', 'team', 'main:review');
    await writeFile(join(root, path), source('SR-001', 'Next version'));
    await service.commit(await request());
    expect((await service.status()).push).toMatchObject({
      available: true,
      remote: 'team',
      branch: 'review',
    });
    const input = await pushRequest();
    expect(await service.push(input)).toMatchObject({
      remote: 'team',
      branch: 'review',
    });
    expect(await remoteRefs(origin)).toEqual([]);
    expect(
      (
        await exec('git', [
          '--git-dir',
          remote,
          'rev-parse',
          'refs/heads/review',
        ])
      ).stdout.trim(),
    ).toBe(input.expectedHead);
  });

  it('rejects changed HEAD or a replaced push URL before sending anything', async () => {
    const originalRemote = await remoteRepository();
    const input = await pushRequest();
    await git('commit', '--allow-empty', '-m', 'Later commit');
    await expect(service.push(input)).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUSH_STATE_CHANGED' },
    });
    const nextInput = await pushRequest();
    const otherRemote = join(directory, 'other.git');
    await exec('git', ['init', '--bare', '-q', otherRemote]);
    await git('remote', 'set-url', '--push', 'origin', otherRemote);
    await expect(service.push(nextInput)).rejects.toMatchObject({
      status: 409,
    });
    expect(await remoteRefs(originalRemote)).toEqual([]);
    expect(await remoteRefs(otherRemote)).toEqual([]);
  });

  it('rejects non-fast-forward updates without rewriting the remote branch', async () => {
    const remote = await remoteRepository();
    const base = await git('rev-parse', 'HEAD');
    await service.push(await pushRequest());
    const tree = await git('rev-parse', 'HEAD^{tree}');
    const remoteHead = await git(
      'commit-tree',
      tree,
      '-p',
      base,
      '-m',
      'Remote change',
    );
    await exec('git', ['--git-dir', remote, 'fetch', repository, remoteHead]);
    await exec('git', [
      '--git-dir',
      remote,
      'update-ref',
      'refs/heads/main',
      remoteHead,
      base,
    ]);
    await writeFile(
      join(root, path),
      source('SR-001', 'Diverging local change'),
    );
    await service.commit(await request());
    await expect(service.push(await pushRequest())).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUSH_REJECTED' },
    });
    expect(
      (
        await exec('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])
      ).stdout.trim(),
    ).toBe(remoteHead);
  });

  it('does not expose remote hook output or credential-bearing addresses in errors', async () => {
    const remote = await remoteRepository();
    await writeFile(
      join(remote, 'hooks/pre-receive'),
      '#!/bin/sh\nprintf "sensitive-token" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await expect(service.push(await pushRequest())).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'PUSH_REJECTED',
        message: expect.not.stringContaining('sensitive-token'),
      },
    });
    await writeFile(
      join(remote, 'hooks/pre-receive'),
      '#!/bin/sh\nprintf "sensitive-token: The requested URL returned error: 403" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    await expect(service.push(await pushRequest())).rejects.toMatchObject({
      status: 401,
      response: {
        code: 'PUSH_AUTH_REQUIRED',
        message: expect.not.stringContaining('sensitive-token'),
      },
    });
    await git(
      'remote',
      'set-url',
      '--push',
      'origin',
      join(directory, 'sensitive-token-missing.git'),
    );
    const status = await service.status();
    expect(JSON.stringify(status)).not.toContain('sensitive-token');
    await expect(service.push(await pushRequest())).rejects.toMatchObject({
      status: 502,
      response: { message: expect.not.stringContaining('sensitive-token') },
    });
  });

  it('rejects force options and ambiguous remote destinations', async () => {
    const remote = await remoteRepository();
    const input = await pushRequest();
    await expect(service.push({ ...input, force: true })).rejects.toMatchObject(
      { status: 400 },
    );
    await git('remote', 'set-url', '--add', '--push', 'origin', remote);
    await git(
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      join(directory, 'another.git'),
    );
    expect((await service.status()).push).toMatchObject({
      available: false,
      reason: expect.stringContaining('ровно один'),
    });
    await expect(service.push(input)).rejects.toMatchObject({ status: 400 });
    expect(await remoteRefs(remote)).toEqual([]);
  });
});
