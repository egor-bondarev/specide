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
