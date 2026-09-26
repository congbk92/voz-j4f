import { describe, it, expect } from 'vitest';
import { tagProblem } from '../scripts/check-tag.mjs';

describe('tagProblem', () => {
  it('accepts a tag that is the manifest version verbatim', () => {
    expect(tagProblem('0.1.0', '0.1.0')).toBeNull();
    expect(tagProblem('0.0.2', '0.0.2')).toBeNull();
  });

  it('rejects a v-prefixed tag, and says so in words', () => {
    // The regression this guards: the manifest briefly said `v0.0.2` while the
    // tag said `v0.0.2`, and stripping the `v` off only the tag produced the
    // self-contradicting "v0.0.2 does not match v0.0.2". Tags carry no `v`, so
    // the comparison is exact and both halves are printed as they really are.
    const problem = tagProblem('v0.1.0', '0.1.0');
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/leading "v"/);
  });

  it('names both versions when they disagree', () => {
    const problem = tagProblem('v0.1.1', '0.1.0');
    expect(problem).toContain('v0.1.1');
    expect(problem).toContain('0.1.0');
  });

  it('treats a differently-shaped tag as a mismatch, not a match', () => {
    // Exact equality, so nothing is normalised away. A looser comparison would
    // let `version-0.1.0` or a pre-release suffix ship an artifact whose name
    // says 0.1.0 while the tag says something else.
    for (const tag of ['version-0.1.0', 'v0.1.0-rc1', '0.1.0-rc1', '0.1.0 ', '01.0.0', '0.1']) {
      expect(tagProblem(tag, '0.1.0')).not.toBeNull();
    }
  });

  it('reports a missing tag rather than matching an empty string', () => {
    expect(tagProblem('', '0.1.0')).toMatch(/no tag/i);
    expect(tagProblem(undefined, '0.1.0')).toMatch(/no tag/i);
  });
});
