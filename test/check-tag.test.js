import { describe, it, expect } from 'vitest';
import { tagProblem } from '../scripts/check-tag.mjs';

describe('tagProblem', () => {
  it('accepts a v-prefixed tag for the manifest version', () => {
    expect(tagProblem('v0.1.0', '0.1.0')).toBeNull();
  });

  it('accepts a bare tag too, so a hand-cut tag is not spurious red', () => {
    expect(tagProblem('0.1.0', '0.1.0')).toBeNull();
  });

  it('names both versions when they disagree', () => {
    const problem = tagProblem('v0.1.1', '0.1.0');
    expect(problem).toContain('v0.1.1');
    expect(problem).toContain('0.1.0');
  });

  it('treats a differently-shaped tag as a mismatch, not a match', () => {
    // The guard strips one leading `v`. If it stripped every `v`, or used a
    // looser comparison, `version-0.1.0` would pass and ship an artifact whose
    // name says 0.1.0 while the tag says something else.
    expect(tagProblem('version-0.1.0', '0.1.0')).not.toBeNull();
    expect(tagProblem('v0.1.0-rc1', '0.1.0')).not.toBeNull();
  });

  it('reports a missing tag rather than matching an empty string', () => {
    expect(tagProblem('', '0.1.0')).toMatch(/no tag/i);
    expect(tagProblem(undefined, '0.1.0')).toMatch(/no tag/i);
  });
});
