import { describe, it, expect } from 'vitest';
import { chipText, formatDuration, chipColors, buildChipState } from '../extension/lib/chip.js';
import { normalize } from '../extension/lib/config.js';

const CFG = normalize({ verbose: false });
const VERBOSE = normalize({ verbose: true });
const NOW = 1_700_000_000_000;
const DAY = 86400000;

const labeled = (over = {}) => ({
  id: '1', name: 'alice', totalPosts: 13,
  posts: Array.from({ length: 13 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
  threads: [], profile: {}, lastError: null,
  label: { choice: 'troll', probabilities: { troll: 0.62 }, lean: {}, at: NOW, evidenceCount: 13, labelSetHash: 'h' },
  ...over,
});

describe('formatDuration', () => {
  it('renders days, hours, minutes, and seconds', () => {
    expect(formatDuration(4 * DAY)).toBe('4d');
    expect(formatDuration(3 * 3600000)).toBe('3h');
    expect(formatDuration(2 * 60000)).toBe('2ph');
    expect(formatDuration(45 * 1000)).toBe('45s');
  });

  it('rounds down, so it never claims more time than remains', () => {
    expect(formatDuration(4.9 * DAY)).toBe('4d');
    expect(formatDuration(59 * 60000)).toBe('59ph');
  });

  it('shows 0s for a non-positive duration', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('chipColors', () => {
  it('returns the light variant when not dark', () => {
    expect(chipColors('negative', false)).toEqual({ bg: '#fee2e2', fg: '#991b1b' });
  });
  it('returns the dark variant when dark', () => {
    expect(chipColors('negative', true)).toEqual({ bg: '#7f1d1d', fg: '#fecaca' });
  });
  it('falls back to neutral for an unknown family', () => {
    // Literals, not chipColors('neutral', …): comparing the function against
    // itself passes even if it returns undefined for both arguments.
    expect(chipColors('nonsense', false)).toEqual({ bg: '#e2e8f0', fg: '#334155' });
    expect(chipColors('nonsense', true)).toEqual({ bg: '#334155', fg: '#e2e8f0' });
  });

  it('falls back for inherited Object keys, which are truthy but carry no variants', () => {
    // `FAMILY_COLORS[family] || FAMILY_COLORS.neutral` returns Object itself for
    // these, so the fallback never fires and callers reading .bg would throw.
    expect(chipColors('constructor', false)).toEqual(chipColors('neutral', false));
    expect(chipColors('toString', true)).toEqual(chipColors('neutral', true));
  });
});

describe('chipText', () => {
  it('shows label and rounded probability when verbose is off', () => {
    expect(chipText(buildChipState(labeled(), CFG, NOW), CFG)).toBe('Troll 62%');
  });

  it('omits the percentage when probabilities are missing', () => {
    const m = labeled({ label: { ...labeled().label, probabilities: null } });
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('Troll');
  });

  it('appends cached count and remaining TTL when verbose', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 3 * DAY } });
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('Troll 62% · 13 cmt · còn 4d');
  });

  it('shows cached over seen only once past the cap', () => {
    const m = labeled({
      totalPosts: 23,
      posts: Array.from({ length: 20 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
      label: { ...labeled().label, at: NOW },
    });
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('Troll 62% · 20/23 cmt · còn 7d');
  });

  it('shows the infinity mark when the TTL is disabled', () => {
    const cfg = normalize({ verbose: true, labelTtlMs: 0 });
    expect(chipText(buildChipState(labeled(), cfg, NOW), cfg)).toBe('Troll 62% · 13 cmt · ∞');
  });

  it('shows progress and threshold when collecting', () => {
    const m = { id: '1', name: 'bob', totalPosts: 7, posts: Array(7).fill({ postId: 'x', text: 'y'.repeat(30) }), threads: [], profile: {}, label: null, lastError: null };
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('7/10');
  });

  it('never appends a suffix to a collecting chip, even in verbose', () => {
    const m = { id: '1', name: 'bob', totalPosts: 7, posts: Array(7).fill({ postId: 'x', text: 'y'.repeat(30) }), threads: [], profile: {}, label: null, lastError: null };
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE)).toBe('7/10');
  });

  it('shows a bang and the cached count for an errored member', () => {
    const m = labeled({ label: null, lastError: { code: 401, message: 'API key sai hoặc hết hạn', at: NOW } });
    expect(chipText(buildChipState(m, CFG, NOW), CFG)).toBe('!');
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE)).toBe('! · 13 cmt');
  });
});

describe('buildChipState', () => {
  it('marks an expired label as still labeled, with an expiresAt in the past', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 8 * DAY } });
    const s = buildChipState(m, CFG, NOW);
    expect(s.state).toBe('labeled');
    expect(s.expiresAt).toBeLessThan(NOW);
  });

  it('reports expiresAt as null when the TTL is disabled', () => {
    const s = buildChipState(labeled(), normalize({ labelTtlMs: 0 }), NOW);
    expect(s.expiresAt).toBeNull();
  });

  it('carries the lean probabilities through for the tooltip', () => {
    const m = labeled({ label: { ...labeled().label, lean: { proGov: 0.81, proUS: 0.12 } } });
    expect(buildChipState(m, CFG, NOW).lean).toEqual({ proGov: 0.81, proUS: 0.12 });
  });

  it('defaults lean to an empty object when the label predates lean', () => {
    const m = labeled({ label: { ...labeled().label, lean: undefined } });
    expect(buildChipState(m, CFG, NOW).lean).toEqual({});
  });

  it('lets a newer error win over the stale label it failed to refresh', () => {
    const m = labeled({
      label: { ...labeled().label, at: NOW - 8 * DAY },
      lastError: { code: 401, message: 'API key sai hoặc hết hạn', at: NOW },
    });
    const s = buildChipState(m, CFG, NOW);
    expect(s.state).toBe('error');
    expect(s.message).toBe('API key sai hoặc hết hạn');
  });

  it('keeps the label when the last error predates it', () => {
    const m = labeled({
      label: { ...labeled().label, at: NOW },
      lastError: { code: 429, message: 'slow down', at: NOW - 2 * DAY },
    });
    expect(buildChipState(m, CFG, NOW).state).toBe('labeled');
  });
});
