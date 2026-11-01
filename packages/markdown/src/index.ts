import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import {
  requirementMetadataSchema,
  type RequirementMetadata,
  type RequirementDocument,
} from '@specide/schema';

export function contentVersion(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function parseRequirement(
  source: string,
  path: string,
): RequirementDocument {
  const parsed = matter(source);
  return {
    path,
    version: contentVersion(source),
    metadata: requirementMetadataSchema.parse(parsed.data),
    body: parsed.content,
  };
}

export function serializeRequirement(
  metadata: RequirementMetadata,
  body: string,
  original?: string,
): string {
  const valid = requirementMetadataSchema.parse(metadata);
  if (original !== undefined) {
    const parsed = matter(original);
    if (JSON.stringify(parsed.data) === JSON.stringify(valid)) {
      if (parsed.content === body) return original;
      return original.slice(0, original.length - parsed.content.length) + body;
    }
  }
  return matter.stringify(body, valid);
}
