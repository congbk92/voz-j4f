import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LABELS, FAMILY_COLORS, LEAN_QUESTIONS, labelSetHash,
} from '../extension/lib/labels.js';

describe('DEFAULT_LABELS', () => {
  it('has 16 labels with unique slug keys', () => {
    expect(DEFAULT_LABELS).toHaveLength(16);
    const keys = DEFAULT_LABELS.map((l) => l.key);
    expect(new Set(keys).size).toBe(16);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/);
  });

  it('gives every label a family that exists in FAMILY_COLORS', () => {
    for (const l of DEFAULT_LABELS) {
      expect(FAMILY_COLORS[l.family]).toBeDefined();
    }
  });

  it('gives every label a non-empty description, since it becomes jev criteria', () => {
    for (const l of DEFAULT_LABELS) {
      expect(typeof l.description).toBe('string');
      expect(l.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('gives every label an icon, which is what makes a chip scannable', () => {
    for (const l of DEFAULT_LABELS) {
      expect(typeof l.icon).toBe('string');
      expect(l.icon.trim().length).toBeGreaterThan(0);
    }
  });

  it('does not repeat an icon across families, which would defeat the point', () => {
    const icons = DEFAULT_LABELS.map((l) => l.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('includes the merged forum-slang labels', () => {
    const keys = DEFAULT_LABELS.map((l) => l.key);
    for (const k of ['bo_do', 'ro_tau', 'ro_meo', 'ba_que', 'giao_su_mom',
                     'thanh_chui', 'troll', 'trau', 'ech_xanh', 'tu_nhuc',
                     'sinh_ngoai', 'thanh', 'nghiem_tuc', 'ca_khia', 'wumao', 'spam']) {
      expect(keys).toContain(k);
    }
  });
});

describe('LEAN_QUESTIONS', () => {
  it('has the six political axes', () => {
    expect(Object.keys(LEAN_QUESTIONS).sort()).toEqual(
      ['antiGov', 'proChina', 'proGov', 'proUS', 'selfDeprecating', 'xenophile'],
    );
  });
});

describe('labelSetHash', () => {
  it('is stable for the same input', () => {
    expect(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS))
      .toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('changes when a description changes', () => {
    const changed = DEFAULT_LABELS.map((l) =>
      l.key === 'troll' ? { ...l, description: 'something else' } : l);
    expect(labelSetHash(changed, LEAN_QUESTIONS))
      .not.toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('ignores icons, which change nothing about what jev is asked', () => {
    // Otherwise recolouring a label on the options page would mark every cached
    // label incomparable and trigger a full, paid re-classification.
    const reiconed = DEFAULT_LABELS.map((l) => ({ ...l, icon: '🦆' }));
    expect(labelSetHash(reiconed, LEAN_QUESTIONS))
      .toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('changes when a lean question changes', () => {
    const changed = { ...LEAN_QUESTIONS, proGov: 'different text' };
    expect(labelSetHash(DEFAULT_LABELS, changed))
      .not.toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });

  it('does not depend on label order', () => {
    const reversed = [...DEFAULT_LABELS].reverse();
    expect(labelSetHash(reversed, LEAN_QUESTIONS))
      .toBe(labelSetHash(DEFAULT_LABELS, LEAN_QUESTIONS));
  });
});
