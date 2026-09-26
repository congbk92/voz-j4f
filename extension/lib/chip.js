import { FAMILY_COLORS } from './labels.js';
import { DEFAULT_RETRY_POLICY } from './jev.js';

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

/**
 * How much of the headline's share a further label must hold to be worth showing.
 *
 * Deliberately severe. Calibrated against five live classifications, the runner-up
 * landed at 0.33x, 0.32x, 0.32x and 0.08x of the headline in the four that had a
 * runner-up at all (the fifth was unanimous) — this model's second place sits at
 * roughly a third of first, consistently. So 0.7 does not mean "the runner-up is
 * plausible"; it means the distribution is genuinely torn, which is rare and is
 * the only case where a second label is saying something the headline does not.
 *
 * The cost, accepted knowingly: on every sample gathered so far this rule shows
 * one label. It is a knob for a rare signal, not a common one — lower it toward
 * 0.4 to let "also plausible" through.
 */
export const EXTRA_LABEL_RATIO = 0.7;

/**
 * And an absolute floor, because the runner-up test alone cannot catch a member
 * the model simply cannot read: with the mass spread thin, everything sits
 * within 40% of a top that is itself near noise. Absolute rather than a share of
 * `1/n` — a uniform-relative floor collapses at small label sets, where `2/n`
 * would demand an extra score above 1 and hide a genuine `0.55/0.45` split.
 */
export const EXTRA_LABEL_FLOOR = 0.10;

/** Chip height budget. Matters more as the label set grows, not a statistic. */
export const MAX_LABELS = 3;

/**
 * Every label the member plausibly carries, strongest first.
 *
 * The `choice` question returns a probability per label, but it is a distribution
 * over mutually exclusive readings of one member — so these numbers say how the
 * model's belief is spread, not independent per-label facts. A second label earns
 * its place by holding a real share of that belief, judged *against the winner*:
 * after a confident 0.80 a 0.20 runner-up is noise, while in a 0.42/0.38 split it
 * is the whole story, and no fixed cutoff separates those two cases correctly.
 *
 * Sorted and filtered over the keys actually present in the stored map, so the
 * rule never assumes how many labels exist — the set is user-editable, and the
 * stored map is what describes the numbers being read.
 */
export function pickLabels(label, cfg) {
  const defs = new Map((cfg.labels || []).map((l) => [l.key, l]));
  const entry = (key, probability) => {
    const d = defs.get(key);
    // No definition means the user deleted this label after the record was
    // classified. It still renders, by its raw key, exactly as it did before.
    return {
      key,
      label: d ? d.label : key,
      icon: d ? d.icon || '' : '',
      family: d ? d.family : 'neutral',
      probability: typeof probability === 'number' ? probability : null,
    };
  };

  const probs = label.probabilities;
  const ranked = probs && typeof probs === 'object'
    ? Object.entries(probs)
        .filter(([k, p]) => typeof p === 'number' && p > 0 && defs.has(k))
        .sort((a, b) => b[1] - a[1])
    : [];

  const kept = ranked
    .filter(([, p], i) => i === 0 || (p >= ranked[0][1] * EXTRA_LABEL_RATIO && p >= EXTRA_LABEL_FLOOR))
    .slice(0, MAX_LABELS)
    .map(([k, p]) => entry(k, p));

  // `probabilities` is optional in the response, and a deleted label is filtered
  // out above. Either way the member still shows what they were classified as,
  // rather than rendering an empty chip.
  if (kept.length && kept[0].key === label.choice) return kept;
  const own = probs && typeof probs === 'object' ? probs[label.choice] : undefined;
  return [entry(label.choice, own), ...kept.filter((l) => l.key !== label.choice)]
    .slice(0, MAX_LABELS);
}

/**
 * How long a retry marker stays believable. A worker the browser killed mid-queue
 * never gets to clear its own marker, and without this the chip would say
 * "retrying" forever.
 *
 * Sized off the request timeout plus a minute rather than the whole queue: a
 * marker is rewritten at every requeue, so the only gap it has to survive is the
 * wait for a request already in flight plus its turn in the queue.
 */
const RETRY_STALE_SLACK_MS = 60000;

/** The live retry marker, or null when there is none or it has gone stale. */
function liveRetry(member, cfg, now) {
  const r = member.retrying;
  if (!r || typeof r.at !== 'number') return null;
  const timeout = Number(cfg && cfg.requestTimeoutMs) || DEFAULT_RETRY_POLICY.requestTimeoutMs;
  if (now - r.at > timeout + RETRY_STALE_SLACK_MS) return null;
  return { attempt: r.attempt, maxAttempts: r.maxAttempts };
}

/** Turn a member record into the display state the chip renders. */
export function buildChipState(member, cfg, now) {
  const cached = member.posts.length;
  const retrying = liveRetry(member, cfg, now);

  // A label and an error coexist when a re-classification fails: setError keeps
  // the last good label. An error newer than the label must win, or the stale
  // label masks the failure and the error state is unreachable for anyone who
  // has ever been labeled — the member most likely to hit a failed refresh.
  const failedSinceLabel = member.lastError
    && (!member.label || member.lastError.at > member.label.at);

  // A live retry keeps the label in front of the reader: the chip flicking to a
  // spinner and back on every transient blip would lose information the user
  // already had. The marker rides alongside instead.
  if (member.label && (retrying || !failedSinceLabel)) {
    // The headline is `labels[0]` rather than a separate lookup of `choice`, so
    // the chip and the list it draws its runners-up from can never disagree.
    // `pickLabels` always resolves at least one, falling back to the raw key.
    const labels = pickLabels(member.label, cfg);
    const primary = labels[0];
    return {
      state: 'labeled',
      key: primary.key,
      icon: primary.icon,
      label: primary.label,
      family: primary.family,
      probability: primary.probability,
      labels,
      lean: member.label.lean || {},
      cached,
      seen: member.totalPosts,
      expiresAt: cfg.labelTtlMs > 0 ? member.label.at + cfg.labelTtlMs : null,
      ...(retrying ? { retrying } : {}),
    };
  }

  // Ahead of `lastError`, because a retry in flight is the more current fact: the
  // stored error may be an hour old and this member is being tried again now.
  if (retrying) {
    return { state: 'retrying', ...retrying, cached, seen: member.totalPosts };
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
  // Both retry shapes end in an arrow: the bare one has no label to sit beside,
  // so it carries the count too.
  if (chip.state === 'retrying') return `↻ ${chip.attempt}/${chip.maxAttempts}`;
  const head = chip.icon ? `${chip.icon} ${chip.label}` : chip.label;
  return chip.retrying ? `${head} ↻${chip.retrying.attempt}` : head;
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
  // Neither has a probability or an expiry to print — a retrying chip has no
  // label yet, and reading `expiresAt` off it would print a meaningless "0s".
  if (chip.state === 'error' || chip.state === 'retrying') return `${chip.cached} cmt`;

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

/**
 * Every label the member carries, on one line. The popup row has the width to
 * print them inline, where the chip on the page stacks them.
 */
export function chipLabelText(chip) {
  const list = chip.labels && chip.labels.length
    ? chip.labels
    : [{ icon: chip.icon, label: chip.label }];
  return list.map((l) => (l.icon ? `${l.icon} ${l.label}` : l.label)).join(', ');
}
