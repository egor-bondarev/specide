import { describe, expect, it } from 'vitest';
import { parseRequirement, serializeRequirement } from './index';

const source =
  '---\nid: BR-001\ntype: business\ntitle: First\nstatus: draft\npriority: critical\nlinks:\n  system: [SR-001]\n---\n\n# Hello\n\n| Field | Value |\n| --- | --- |\n| a | b |\n';

describe('requirement files', () => {
  it('preserves unknown properties and links after an edit', () => {
    const doc = parseRequirement(source, 'BR-001.md');
    const updated = parseRequirement(
      serializeRequirement(
        { ...doc.metadata, title: 'Changed' },
        doc.body,
        source,
      ),
      doc.path,
    );
    expect(updated.metadata.priority).toBe('critical');
    expect(updated.metadata.links).toEqual({ system: ['SR-001'] });
    expect(updated.body).toContain('| a | b |');
  });
  it('keeps an unchanged file byte-for-byte, including frontmatter formatting', () => {
    const doc = parseRequirement(source, 'BR-001.md');
    expect(serializeRequirement(doc.metadata, doc.body, source)).toBe(source);
  });
  it('rejects inconsistent identity instead of guessing a type', () => {
    expect(() =>
      parseRequirement(source.replace('BR-001', 'SR-001'), 'wrong.md'),
    ).toThrow();
  });
});
