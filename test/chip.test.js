import { describe, it, expect } from 'vitest';
import {
  chipText, chipHead, chipTail, chipLabelText, pickLabels, formatDuration,
  chipColors, buildChipState, MAX_LABELS,
} from '../extension/lib/chip.js';
import { normalize } from '../extension/lib/config.js';
import { DEFAULT_LABELS } from '../extension/lib/labels.js';

// Pinned, not inherited: the collecting cases assert the rendered `7/10`, and
// taking 10 from a default that is free to move would make them assert the
// default rather than the renderer.
const CFG = normalize({ verbose: false, threshold: 10 });
const VERBOSE = normalize({ ...CFG, verbose: true });
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

const collecting = () => ({
  id: '1', name: 'bob', totalPosts: 7,
  posts: Array(7).fill({ postId: 'x', text: 'y'.repeat(30) }),
  threads: [], profile: {}, label: null, lastError: null,
});

const errored = () => labeled({
  label: null,
  lastError: { code: 401, message: 'API key sai hoặc hết hạn', at: NOW },
});

describe('pickLabels', () => {
  const withProbs = (probabilities, choice) => labeled({
    label: { ...labeled().label, choice, probabilities },
  });
  const keysOf = (m, cfg = CFG) => pickLabels(m.label, cfg).map((l) => l.key);

  it('shows only the winner when it has a clear lead', () => {
    const m = withProbs({ troll: 0.80, thanh: 0.05, ca_khia: 0.04 }, 'troll');
    expect(keysOf(m)).toEqual(['troll']);
  });

  it('shows the runner-up when the belief is genuinely split', () => {
    // The case the feature exists for: 0.38 is not a rival reading of one slot,
    // it is a large share of the evidence pointing somewhere else.
    const m = withProbs({ troll: 0.42, bo_do: 0.38, ca_khia: 0.11 }, 'troll');
    expect(keysOf(m)).toEqual(['troll', 'bo_do']);
  });

  it('shows only the winner when every score is near noise', () => {
    // Mass spread thin by a member the model cannot read. The ratio alone keeps
    // all three — every one is within 40% of the top — so the floor is what stops
    // three guesses being printed as three findings.
    const m = withProbs({ troll: 0.09, thanh: 0.08, ca_khia: 0.07 }, 'troll');
    expect(keysOf(m)).toEqual(['troll']);
  });

  it('always shows the winner, however small its share', () => {
    const m = withProbs({ troll: 0.02, thanh: 0.01 }, 'troll');
    expect(keysOf(m)).toEqual(['troll']);
  });

  // The distributions actually observed from the gateway, which the ratio is
  // calibrated against. Every one of these shows a single label — that is the
  // point of the setting, not a failure of it.
  it.each([
    ['a clear winner', { troll: 0.75, thanh_chui: 0.25 }],
    ['a moderate lead', { tu_nhuc: 0.63, ca_khia: 0.20, sinh_ngoai: 0.09 }],
    ['a narrow-ish lead', { nghiem_tuc: 0.53, tu_nhuc: 0.17, sinh_ngoai: 0.10 }],
    ['a confident read', { thanh: 0.93, nghiem_tuc: 0.07 }],
  ])('shows only the headline for %s, as observed live', (_name, probabilities) => {
    const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    expect(keysOf(withProbs(probabilities, choice))).toEqual([choice]);
  });

  it('hides a runner-up holding half the headline, which a looser bar would show', () => {
    // The boundary that separates this setting from a permissive one: at ratio
    // 0.4 this 0.30 would clear the bar and appear. "Also plausible" is not
    // enough — the two have to be close enough that the headline is in doubt.
    const m = withProbs({ troll: 0.60, bo_do: 0.30 }, 'troll');
    expect(keysOf(m)).toEqual(['troll']);
  });

  it('shows a second label only when the two are near-tied', () => {
    const m = withProbs({ troll: 0.45, bo_do: 0.40 }, 'troll');
    expect(keysOf(m)).toEqual(['troll', 'bo_do']);
  });

  it('ranks strongest first', () => {
    const m = withProbs({ bo_do: 0.38, troll: 0.42 }, 'troll');
    expect(keysOf(m)).toEqual(['troll', 'bo_do']);
  });

  it('falls back to a single label when the response carried no distribution', () => {
    // `probabilities` is optional, so this is a real gateway response, not a
    // malformed one — the member still shows what they were classified as.
    const m = labeled({ label: { ...labeled().label, probabilities: null } });
    expect(keysOf(m)).toEqual(['troll']);
    expect(pickLabels(m.label, CFG)[0].probability).toBeNull();
  });

  it('drops a key the label set no longer contains', () => {
    const m = withProbs({ troll: 0.60, da_xoa: 0.55 }, 'troll');
    expect(keysOf(m)).toEqual(['troll']);
  });

  it('keeps the winner even when the label set no longer contains it', () => {
    const cfg = normalize({
      labels: [{ key: 'other', label: 'Other', family: 'neutral', description: 'x' }],
    });
    const m = withProbs({ other: 0.70, troll: 0.65 }, 'troll');
    expect(keysOf(m, cfg)).toEqual(['troll', 'other']);
  });

  it('handles a two-label set, where a split is the whole story', () => {
    // The case a uniform-relative floor would break: at n=2 it would demand an
    // extra score above 1.0 and hide this runner-up entirely.
    const cfg = normalize({
      labels: [
        { key: 'troll', label: 'Troll', family: 'negative', description: 'x' },
        { key: 'thanh', label: 'Thánh', family: 'positive', description: 'y' },
      ],
    });
    const m = withProbs({ troll: 0.55, thanh: 0.45 }, 'troll');
    expect(keysOf(m, cfg)).toEqual(['troll', 'thanh']);
  });

  it('does not assume any particular label count', () => {
    // Ten labels, five of them past the ratio bar. The cap decides the count, not
    // the size of the set — the number of labels is the user's to change.
    const many = Array.from({ length: 10 }, (_, i) => ({
      key: `l${i}`, label: `L${i}`, family: 'neutral', description: `d${i}`,
    }));
    const cfg = normalize({ labels: many });
    const probabilities = Object.fromEntries(
      many.map((l, i) => [l.key, i === 0 ? 0.5 : Math.max(0, 0.44 - i * 0.01)]),
    );
    const m = withProbs(probabilities, 'l0');
    const keys = pickLabels(m.label, cfg).map((l) => l.key);
    expect(keys).toHaveLength(MAX_LABELS);
    expect(keys).toEqual(['l0', 'l1', 'l2']);
  });

  it('carries icon, label and family through for each entry', () => {
    const m = withProbs({ troll: 0.42, bo_do: 0.38 }, 'troll');
    expect(pickLabels(m.label, CFG)).toEqual([
      { key: 'troll', label: 'Troll', icon: '👹', family: 'negative', probability: 0.42 },
      { key: 'bo_do', label: 'Bò đỏ', icon: '🐂', family: 'political', probability: 0.38 },
    ]);
  });
});

describe('chipLabelText', () => {
  it('joins every label the member carries, for the popup row', () => {
    const m = labeled({ label: { ...labeled().label, probabilities: { troll: 0.42, bo_do: 0.38 } } });
    expect(chipLabelText(buildChipState(m, CFG, NOW))).toBe('👹 Troll, 🐂 Bò đỏ');
  });

  it('is the single label when there is only one', () => {
    expect(chipLabelText(buildChipState(labeled(), CFG, NOW))).toBe('👹 Troll');
  });
});

describe('chipHead', () => {
  it('leads with the label icon, so a chip is scannable before it is readable', () => {
    expect(chipHead(buildChipState(labeled(), CFG, NOW))).toBe('👹 Troll');
  });

  it('leaves out the space when a label carries no icon', () => {
    const cfg = normalize({ labels: DEFAULT_LABELS.map((l) => ({ ...l, icon: '' })) });
    expect(chipHead(buildChipState(labeled(), cfg, NOW))).toBe('Troll');
  });

  it('falls back to the bare key, with no icon, for a label outside the set', () => {
    // A label set edited on the options page no longer contains troll, but a
    // member cached under the old set can still be rendered before reclassify.
    const cfg = normalize({
      labels: [{ key: 'other', icon: '⭐', label: 'Other', family: 'neutral', description: 'x' }],
    });
    const s = buildChipState(labeled(), cfg, NOW);
    expect(s.icon).toBe('');
    expect(chipHead(s)).toBe('troll');
  });

  it('shows progress and threshold when collecting', () => {
    expect(chipHead(buildChipState(collecting(), CFG, NOW))).toBe('7/10');
  });

  it('shows a bang for an errored member', () => {
    expect(chipHead(buildChipState(errored(), CFG, NOW))).toBe('!');
  });
});

describe('chipTail', () => {
  it('is null when verbose is off — the default chip is the label alone', () => {
    expect(chipTail(buildChipState(labeled(), CFG, NOW), CFG, NOW)).toBeNull();
  });

  it('carries probability, cached count and remaining TTL when verbose', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 3 * DAY } });
    expect(chipTail(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('62% · 13 cmt · còn 4d');
  });

  it('omits the probability when jev returned none, keeping the rest', () => {
    const m = labeled({
      label: { ...labeled().label, probabilities: null, at: NOW - 3 * DAY },
    });
    expect(chipTail(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('13 cmt · còn 4d');
  });

  it('shows cached over seen only once past the cap', () => {
    const m = labeled({
      totalPosts: 23,
      posts: Array.from({ length: 20 }, (_, i) => ({ postId: String(i), text: 'x'.repeat(30), ts: 0 })),
      label: { ...labeled().label, at: NOW },
    });
    expect(chipTail(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('62% · 20/23 cmt · còn 7d');
  });

  it('shows the infinity mark when the TTL is disabled', () => {
    const cfg = normalize({ verbose: true, labelTtlMs: 0 });
    expect(chipTail(buildChipState(labeled(), cfg, NOW), cfg, NOW))
      .toBe('62% · 13 cmt · ∞');
  });

  it('stays null for a collecting chip, even in verbose', () => {
    // posts.length is already the numerator, so there is nothing to add.
    expect(chipTail(buildChipState(collecting(), VERBOSE, NOW), VERBOSE, NOW)).toBeNull();
  });

  it('shows the cached count for an errored member', () => {
    expect(chipTail(buildChipState(errored(), VERBOSE, NOW), VERBOSE, NOW)).toBe('13 cmt');
  });
});

describe('chipText', () => {
  it('joins head and tail, for single-line surfaces such as a popup row', () => {
    const m = labeled({ label: { ...labeled().label, at: NOW - 3 * DAY } });
    expect(chipText(buildChipState(m, VERBOSE, NOW), VERBOSE, NOW))
      .toBe('👹 Troll · 62% · 13 cmt · còn 4d');
  });

  it('is the head alone when there is no tail', () => {
    expect(chipText(buildChipState(labeled(), CFG, NOW), CFG)).toBe('👹 Troll');
    expect(chipText(buildChipState(collecting(), VERBOSE, NOW), VERBOSE)).toBe('7/10');
  });

  it('is the bang plus the cached count for an errored member', () => {
    expect(chipText(buildChipState(errored(), CFG, NOW), CFG)).toBe('!');
    expect(chipText(buildChipState(errored(), VERBOSE, NOW), VERBOSE)).toBe('! · 13 cmt');
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

describe('retrying', () => {
  const retry = (over = {}) => ({ attempt: 2, maxAttempts: 4, at: NOW, ...over });
  const retryingMember = (over = {}) => labeled({ label: null, retrying: retry(), ...over });

  it('shows the attempt in flight for a member with no label yet', () => {
    const s = buildChipState(retryingMember(), CFG, NOW);
    expect(s.state).toBe('retrying');
    expect(s.attempt).toBe(2);
    expect(s.maxAttempts).toBe(4);
    expect(chipHead(s)).toBe('↻ 2/4');
  });

  it('keeps the label and rides the retry alongside it', () => {
    // The chip flicking to a spinner and back on every transient blip would lose
    // information the reader already had.
    const s = buildChipState(labeled({ retrying: retry() }), CFG, NOW);
    expect(s.state).toBe('labeled');
    expect(s.labels[0].key).toBe('troll');
    expect(chipHead(s)).toBe('👹 Troll ↻2');
  });

  it('outranks a stored error, which may be an hour old', () => {
    const m = retryingMember({ lastError: { code: 429, message: 'slow down', at: NOW - DAY } });
    expect(buildChipState(m, CFG, NOW).state).toBe('retrying');
  });

  it('outranks an error newer than the label too, since the retry is now', () => {
    const m = labeled({
      label: { ...labeled().label, at: NOW - 8 * DAY },
      lastError: { code: 429, message: 'slow down', at: NOW },
      retrying: retry(),
    });
    expect(buildChipState(m, CFG, NOW).state).toBe('labeled');
  });

  it('ignores a marker left behind by a worker the browser killed', () => {
    // Nothing clears the marker when the worker dies mid-backoff, so a stale one
    // would otherwise pin the chip on "retrying" forever.
    const stale = { attempt: 2, maxAttempts: 4, at: NOW - 200000 };
    expect(buildChipState(retryingMember({ retrying: stale }), CFG, NOW).state).toBe('collecting');
    expect(buildChipState(labeled({ retrying: stale }), CFG, NOW).retrying).toBeUndefined();
  });

  it('keeps a marker written while the request was still in flight', () => {
    // A marker is rewritten at every requeue, so the gap it has to survive is the
    // wait for the request already running, not the whole queue.
    const fresh = { attempt: 2, maxAttempts: 4, at: NOW - 45000 };
    expect(buildChipState(retryingMember({ retrying: fresh }), CFG, NOW).state).toBe('retrying');
  });

  it('reports no spinner and no NaN expiry under a retrying chip', () => {
    // `chipTail` used to read `expiresAt` unconditionally, which a retrying chip
    // has never had.
    const s = buildChipState(retryingMember(), CFG, NOW);
    expect(chipTail(s, CFG, NOW)).toBeNull();
    expect(chipTail(s, VERBOSE, NOW)).toBe('13 cmt');
  });
});
