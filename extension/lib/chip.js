import { FAMILY_COLORS } from './labels.js';

const UNITS = [
  ['d', 86400000],
  ['h', 3600000],
  ['ph', 60000],
  ['s', 1000],
];

/** Coarse remaining duration. Rounds down so it never overstates. */
export function formatDuration(ms) {
  if (!(ms > 0)) return '0s';
  for (const [suffix, size] of UNITS) {
    if (ms >= size) return `${Math.floor(ms / size)}${suffix}`;
  }
  return '0s';
}

export function chipColors(family, dark) {
  // hasOwn, not a truthiness test: an inherited key like 'constructor' is truthy
  // but carries no light/dark, which would return undefined instead of a colour.
  const entry = Object.hasOwn(FAMILY_COLORS, family) ? FAMILY_COLORS[family] : FAMILY_COLORS.neutral;
  return dark ? entry.dark : entry.light;
}

/** Turn a member record into the display state the chip renders. */
export function buildChipState(member, cfg, now) {
  const cached = member.posts.length;

  if (member.label) {
    const label = (cfg.labels || []).find((l) => l.key === member.label.choice) || null;
    const prob = member.label.probabilities
      ? member.label.probabilities[member.label.choice]
      : undefined;
    return {
      state: 'labeled',
      key: member.label.choice,
      label: label ? label.label : member.label.choice,
      family: label ? label.family : 'neutral',
      probability: typeof prob === 'number' ? prob : null,
      lean: member.label.lean || {},
      cached,
      seen: member.totalPosts,
      expiresAt: cfg.labelTtlMs > 0 ? member.label.at + cfg.labelTtlMs : null,
    };
  }

  if (member.lastError) {
    return { state: 'error', message: member.lastError.message, cached, seen: member.totalPosts };
  }

  return { state: 'collecting', count: cached, threshold: cfg.threshold };
}

export function chipText(chip, cfg, now = Date.now()) {
  const pct = (p) => `${Math.round(p * 100)}%`;

  if (chip.state === 'collecting') {
    // posts.length is already the numerator here, so verbose adds nothing.
    return `${chip.count}/${chip.threshold}`;
  }

  if (chip.state === 'error') {
    return cfg.verbose ? `! · ${chip.cached} cmt` : '!';
  }

  let text = chip.probability == null ? chip.label : `${chip.label} ${pct(chip.probability)}`;
  if (!cfg.verbose) return text;

  text += chip.seen > chip.cached ? ` · ${chip.cached}/${chip.seen} cmt` : ` · ${chip.cached} cmt`;
  if (chip.expiresAt === null) return `${text} · ∞`;
  return `${text} · còn ${formatDuration(chip.expiresAt - now)}`;
}
