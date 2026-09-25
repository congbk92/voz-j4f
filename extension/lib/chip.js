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
  // hasOwn, not `||`: inherited keys such as 'constructor' and '__proto__' are
  // truthy but carry no .light/.dark, so the fallback would not fire and callers
  // reading .bg would throw.
  const entry = Object.hasOwn(FAMILY_COLORS, family) ? FAMILY_COLORS[family] : FAMILY_COLORS.neutral;
  return dark ? entry.dark : entry.light;
}

/** Turn a member record into the display state the chip renders. */
export function buildChipState(member, cfg, now) {
  const cached = member.posts.length;

  // A label and an error coexist when a re-classification fails: setError keeps
  // the last good label. An error newer than the label must win, or the stale
  // label masks the failure and the error state is unreachable for anyone who
  // has ever been labeled — the member most likely to hit a failed refresh.
  const failedSinceLabel = member.lastError
    && (!member.label || member.lastError.at > member.label.at);

  if (member.label && !failedSinceLabel) {
    const label = (cfg.labels || []).find((l) => l.key === member.label.choice) || null;
    const prob = member.label.probabilities
      ? member.label.probabilities[member.label.choice]
      : undefined;
    return {
      state: 'labeled',
      key: member.label.choice,
      icon: label ? label.icon || '' : '',
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

/**
 * The chip's main line: icon and label for a labeled member, the progress count
 * while collecting, a bang on error. Everything numeric lives in `chipTail`, so
 * the default view is just the label — the numbers are opt-in, not the identity.
 */
export function chipHead(chip) {
  if (chip.state === 'collecting') return `${chip.count}/${chip.threshold}`;
  if (chip.state === 'error') return '!';
  return chip.icon ? `${chip.icon} ${chip.label}` : chip.label;
}

/**
 * The verbose second line, and the reason verbose exists. Null whenever there is
 * nothing to add: with verbose off, and for a collecting chip at any setting —
 * `posts.length` is already its numerator, so repeating it would be noise.
 *
 * `20/23` — cached over seen — appears only past the cap for the same reason:
 * below it the two numbers are always equal.
 */
export function chipTail(chip, cfg, now = Date.now()) {
  if (!cfg.verbose || chip.state === 'collecting') return null;
  if (chip.state === 'error') return `${chip.cached} cmt`;

  const parts = [];
  if (chip.probability != null) parts.push(`${Math.round(chip.probability * 100)}%`);
  parts.push(chip.seen > chip.cached ? `${chip.cached}/${chip.seen} cmt` : `${chip.cached} cmt`);
  parts.push(chip.expiresAt === null ? '∞' : `còn ${formatDuration(chip.expiresAt - now)}`);
  return parts.join(' · ');
}

/** Head and tail joined, for single-line surfaces such as a popup row. */
export function chipText(chip, cfg, now = Date.now()) {
  const tail = chipTail(chip, cfg, now);
  return tail ? `${chipHead(chip)} · ${tail}` : chipHead(chip);
}
