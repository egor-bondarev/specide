import 'reflect-metadata';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contentVersion,
  parseRequirement,
  serializeRequirement,
} from '@specide/markdown';
import { DocumentsService } from './documents';

const original =
  '---\nid: SR-001\ntype: system\ntitle: First\nstatus: draft\npriority: critical\n---\n\n# Original\n';
let directory: string;
let root: string;
let state: string;
let service: DocumentsService;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'specide-test-'));
  root = join(directory, 'workspace');
  state = join(directory, 'state');
  await mkdir(root);
  await writeFile(join(root, 'SR-001.md'), original);
  service = new DocumentsService({ root, state });
  await service.onModuleInit();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function request(body: string) {
  const doc = await service.get('SR-001');
  return {
    operationId: randomUUID(),
    expectedVersion: doc.version,
    metadata: doc.metadata,
    body,
  };
}

describe('document persistence', () => {
  it.each([
    ['business', 'BR-001'],
    ['test_case', 'TC-001'],
  ] as const)(
    'keeps %s models readable but excludes their files from the active workspace',
    async (kind, id) => {
      const source = original
        .replace('SR-001', id)
        .replace('type: system', 'type: ' + kind);
      const path = id + '.md';
      await writeFile(join(root, path), source);
      const hidden = parseRequirement(source, path);
      expect(hidden.metadata.type).toBe(kind);
      const listing = await service.list();
      expect(listing.documents.map((doc) => doc.metadata.id)).toEqual([
        'SR-001',
      ]);
      expect(listing.issues).toEqual([]);
      expect((await service.workspace()).documentCount).toBe(1);
      await expect(service.get(id)).rejects.toMatchObject({ status: 404 });
      await expect(
        service.save(id, {
          operationId: randomUUID(),
          expectedVersion: hidden.version,
          metadata: hidden.metadata,
          body: '# Not allowed\n',
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await readFile(join(root, path), 'utf8')).toBe(source);
    },
  );
  it.each([
    ['unchanged', 'failed'],
    ['external', 'needs_review'],
  ] as const)(
    'recovers an interrupted write with %s content without overwriting it',
    async (kind, status) => {
      const input = await request('# Intended target\n');
      const target = serializeRequirement(input.metadata, input.body, original);
      const workspace = await import('node:fs/promises').then((fs) =>
        fs.realpath(root),
      );
      const existing =
        kind === 'unchanged'
          ? original
          : original.replace('# Original', '# External after interruption');
      await writeFile(
        join(state, input.operationId + '.json'),
        JSON.stringify({
          id: input.operationId,
          workspace,
          fingerprint: 'test',
          path: 'SR-001.md',
          beforeVersion: contentVersion(original),
          afterVersion: contentVersion(target),
          status: 'pending',
        }),
      );
      await writeFile(join(root, 'SR-001.md'), existing);
      const restarted = new DocumentsService({ root, state });
      await restarted.onModuleInit();
      expect((await restarted.operation(input.operationId)).status).toBe(
        status,
      );
      expect(await readFile(join(root, 'SR-001.md'), 'utf8')).toBe(existing);
    },
  );
  it('rejects a competing save without overwriting the first result', async () => {
    const one = await request('# One\n');
    const two = { ...one, operationId: randomUUID(), body: '# Two\n' };
    const outcomes = await Promise.allSettled([
      service.save('SR-001', one),
      service.save('SR-001', two),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected']);
    expect((await service.get('SR-001')).body).toBe('# One\n');
  });
  it('returns the original result for a retried operation, even after restart', async () => {
    const input = await request('# Saved\n');
    const first = await service.save('SR-001', input);
    const restarted = new DocumentsService({ root, state });
    await restarted.onModuleInit();
    expect(await restarted.save('SR-001', input)).toEqual(first);
    expect((await restarted.operation(input.operationId)).status).toBe(
      'succeeded',
    );
    await expect(
      restarted.save('SR-001', { ...input, body: '# Different' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('detects external edits made before saving', async () => {
    const input = await request('# Local\n');
    await writeFile(
      join(root, 'SR-001.md'),
      original.replace('# Original', '# External'),
    );
    await expect(service.save('SR-001', input)).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(join(root, 'SR-001.md'), 'utf8')).toContain(
      '# External',
    );
  });
  it('recovers a completed write whose journal still says pending', async () => {
    const input = await request('# Completed\n');
    const target = serializeRequirement(input.metadata, input.body, original);
    const workspace = await import('node:fs/promises').then((fs) =>
      fs.realpath(root),
    );
    await writeFile(
      join(state, input.operationId + '.json'),
      JSON.stringify({
        id: input.operationId,
        workspace,
        fingerprint: 'test',
        path: 'SR-001.md',
        beforeVersion: contentVersion(original),
        afterVersion: contentVersion(target),
        status: 'pending',
      }),
    );
    await writeFile(join(root, 'SR-001.md'), target);
    const restarted = new DocumentsService({ root, state });
    await restarted.onModuleInit();
    expect((await restarted.operation(input.operationId)).document?.body).toBe(
      '# Completed\n',
    );
  });
  it('diagnoses invalid documents and duplicate identities without hiding valid ones', async () => {
    await writeFile(
      join(root, 'invalid.md'),
      '---\ntitle: Missing identity\n---\n',
    );
    expect((await service.list()).issues).toHaveLength(1);
    await writeFile(join(root, 'duplicate.md'), original);
    const list = await service.list();
    expect(list.documents).toHaveLength(0);
    expect(list.issues).toHaveLength(3);
  });
  it('does not follow symlinks outside the workspace', async () => {
    await writeFile(
      join(directory, 'outside.md'),
      original.replace('SR-001', 'SR-002'),
    );
    await symlink(join(directory, 'outside.md'), join(root, 'escape.md'));
    expect((await service.list()).documents).toHaveLength(1);
    await expect(service.get('SR-002')).rejects.toMatchObject({ status: 404 });
  });
});
