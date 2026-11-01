import { z } from 'zod';

export const requirementKindSchema = z.enum([
  'business',
  'system',
  'test_case',
]);
export const requirementStatusSchema = z.enum([
  'draft',
  'review',
  'approved',
  'deprecated',
]);
const prefixes = { business: 'BR', system: 'SR', test_case: 'TC' } as const;

export const requirementMetadataSchema = z
  .object({
    id: z.string().regex(/^(BR|SR|TC)-\d{3,}$/),
    type: requirementKindSchema,
    title: z.string().trim().min(1).max(200),
    status: requirementStatusSchema,
    owner: z.string().max(160).optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (!value.id.startsWith(prefixes[value.type] + '-')) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'ID does not match document type',
      });
    }
  });

export const saveDocumentSchema = z.object({
  operationId: z.uuid(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: requirementMetadataSchema,
  body: z.string().max(1_000_000),
});

export const createDocumentSchema = z
  .object({
    operationId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    owner: z.string().trim().max(160).optional(),
  })
  .strict();

export type RequirementKind = z.infer<typeof requirementKindSchema>;
export type RequirementStatus = z.infer<typeof requirementStatusSchema>;
export type RequirementMetadata = z.infer<typeof requirementMetadataSchema>;
export type SaveDocumentRequest = z.infer<typeof saveDocumentSchema>;
export type CreateDocumentRequest = z.infer<typeof createDocumentSchema>;

export interface RequirementDocument {
  path: string;
  version: string;
  metadata: RequirementMetadata;
  body: string;
}

export type DocumentSummary = Pick<
  RequirementDocument,
  'path' | 'metadata' | 'version'
>;
export interface DocumentIssue {
  path: string;
  message: string;
}
export interface DocumentList {
  documents: DocumentSummary[];
  issues: DocumentIssue[];
}
export interface WorkspaceInfo {
  name: string;
  mode: 'local';
  documentCount: number;
}
export interface WorkspaceConnection extends WorkspaceInfo {
  id: string;
  storageKey: string;
  path: string;
  source: 'default' | 'repository';
  connectionError?: string;
}
export const connectWorkspaceSchema = z
  .object({
    operationId: z.uuid(),
    expectedWorkspaceId: z.string().regex(/^[a-f0-9]{64}$/),
    path: z.string().trim().min(1).max(4096).nullable(),
  })
  .strict();
export type ConnectWorkspaceRequest = z.infer<typeof connectWorkspaceSchema>;
export interface ApiError {
  code: string;
  message: string;
}
export interface DocumentOperation {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  document?: RequirementDocument;
  error?: ApiError;
}

export interface GitChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted';
  snapshotToken: string;
  blockedReason?: string;
}
export interface GitStatus {
  available: boolean;
  reason?: string;
  repository?: string;
  branch?: string | null;
  head?: string | null;
  hasStagedChanges: boolean;
  recoveryRequired?: boolean;
  changes: GitChange[];
  push?: GitPushTarget;
}
export interface GitPushTarget {
  available: boolean;
  reason?: string;
  remote?: string;
  branch?: string;
  token?: string;
}
export const gitPushRequestSchema = z
  .object({
    expectedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    targetToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;
export interface GitPushResult {
  remote: string;
  branch: string;
  head: string;
}
export interface GitDiff {
  path: string;
  patch: string;
  snapshotToken: string | null;
  blockedReason?: string;
}
export interface GitCommitFile {
  path: string;
  kind: GitChange['kind'];
}
export interface GitCommit {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: GitCommitFile[];
}
export interface GitHistory {
  commits: GitCommit[];
  hasMore: boolean;
  nextOffset: number;
}
export const gitCommitRequestSchema = z
  .object({
    operationId: z.uuid(),
    message: z.string().trim().min(1).max(2000),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            snapshotToken: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
export interface GitOperation {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'needs_review';
  commit?: GitCommit;
  error?: ApiError;
}
