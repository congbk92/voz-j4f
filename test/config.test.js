import { describe, it, expect } from 'vitest';
import { DEFAULTS, RETRY_AFTER_MS, normalize, createConfig } from '../extension/lib/config.js';

function fakeStorage(initial = {}) {
  let data = { ...initial };
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      if (typeof keys === 'string') return keys in data ? { [keys]: data[keys] } : {};
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { data = { ...data, ...obj }; },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    _dump: () => data,
  };
}

describe('DEFAULTS', () => {
  it('matches the spec', () => {
    expect(DEFAULTS).toMatchObject({
      enabled: true,
      verbose: false,
      apiKey: '',
      modelId: 'typesafe-ai/jev',
      threshold: 10,
      reclassifyEvery: 10,
      maxPostsPerMember: 20,
      maxMembers: 300,
      labelTtlMs: 604800000,
    });
    expect(DEFAULTS.labels).toHaveLength(16);
    expect(RETRY_AFTER_MS).toBe(3600000);
  });
});

describe('normalize', () => {
  it('fills in every missing key from DEFAULTS', () => {
    const cfg = normalize({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.modelId).toBe('typesafe-ai/jev');
    expect(cfg.labels).toHaveLength(16);
  });

  it('clamps threshold down to maxPostsPerMember', () => {
    const cfg = normalize({ threshold: 50, maxPostsPerMember: 20 });
    expect(cfg.threshold).toBe(20);
  });

  it('clamps threshold up to at least 1', () => {
    expect(normalize({ threshold: 0 }).threshold).toBe(1);
    expect(normalize({ threshold: -5 }).threshold).toBe(1);
  });

  it('clamps maxPostsPerMember to its bound of 1 instead of treating 0 as missing', () => {
    expect(normalize({ maxPostsPerMember: 0 }).maxPostsPerMember).toBe(1);
    expect(normalize({ maxPostsPerMember: -5 }).maxPostsPerMember).toBe(1);
  });

  it('keeps an explicit maxPostsPerMember above the bound, defaulting only when absent', () => {
    expect(normalize({ maxPostsPerMember: 50 }).maxPostsPerMember).toBe(50);
    expect(normalize({}).maxPostsPerMember).toBe(20);
  });

  it('clamps maxMembers to at least 1, since 0 would evict every stored member', () => {
    expect(normalize({ maxMembers: 0 }).maxMembers).toBe(1);
    expect(normalize({ maxMembers: -5 }).maxMembers).toBe(1);
    expect(normalize({ maxMembers: 50 }).maxMembers).toBe(50);
  });

  it('clamps reclassifyEvery to at least 1, since 0 would make every label permanently stale', () => {
    expect(normalize({ reclassifyEvery: 0 }).reclassifyEvery).toBe(1);
    expect(normalize({ reclassifyEvery: -5 }).reclassifyEvery).toBe(1);
    expect(normalize({ reclassifyEvery: 25 }).reclassifyEvery).toBe(25);
  });

  it('preserves unknown keys so a future version does not wipe them', () => {
    expect(normalize({ somethingNew: 'keep me' }).somethingNew).toBe('keep me');
  });

  it('treats labelTtlMs 0 as a real value, not missing', () => {
    expect(normalize({ labelTtlMs: 0 }).labelTtlMs).toBe(0);
  });
});

describe('createConfig', () => {
  it('returns defaults when storage is empty', async () => {
    const cfg = createConfig(fakeStorage());
    const got = await cfg.get();
    expect(got.enabled).toBe(true);
    expect(got.labels).toHaveLength(16);
  });

  it('merges a patch without dropping other keys', async () => {
    const storage = fakeStorage();
    const cfg = createConfig(storage);
    await cfg.set({ apiKey: 'sk-test' });
    await cfg.set({ verbose: true });
    const got = await cfg.get();
    expect(got.apiKey).toBe('sk-test');
    expect(got.verbose).toBe(true);
    expect(got.modelId).toBe('typesafe-ai/jev');
  });

  it('normalizes on write, so a bad threshold never reaches storage', async () => {
    const storage = fakeStorage();
    const cfg = createConfig(storage);
    await cfg.set({ threshold: 99, maxPostsPerMember: 20 });
    expect((await cfg.get()).threshold).toBe(20);
  });
});
