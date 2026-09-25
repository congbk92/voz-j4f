(async () => {
  const [{ extractPosts, memberIdOf }, { chipHead, chipTail, chipColors }, { createConfig }] = await Promise.all([
    import(chrome.runtime.getURL('lib/voz.js')),
    import(chrome.runtime.getURL('lib/chip.js')),
    import(chrome.runtime.getURL('lib/config.js')),
  ]);

  const cfgStore = createConfig(chrome.storage.local);

  let enabled = true;
  let verbose = false;

  const chips = new Map();   // memberId -> chipState
  const sent = new Set();    // postIds already reported; keeps collect idempotent

  const POST_SEL = 'article.message, [data-content^="post-"]';

  const isDark = () =>
    document.documentElement.getAttribute('data-variation') === 'alternate'
    || window.matchMedia('(prefers-color-scheme: dark)').matches;

  const chipHost = (el) =>
    el.querySelector('.message-name') || el.querySelector('.message-cell--user');

  const span = (cls) => {
    const el = document.createElement('span');
    el.className = cls;
    return el;
  };

  function renderChip(host, chip, memberId) {
    let node = host.querySelector('.jev-chip');
    if (!node) {
      node = document.createElement('span');
      node.className = 'jev-chip';
      node.append(span('jev-chip-head'), span('jev-chip-tail'));
      host.appendChild(node);
    }

    // Two elements, not one text node: verbose stacks its numbers *under* the
    // label rather than trailing it, so the label is what you scan and the
    // detail is what you read when you stop on a chip.
    const now = Date.now();
    const tail = chipTail(chip, { verbose }, now);
    node.querySelector('.jev-chip-head').textContent = chipHead(chip);
    const tailEl = node.querySelector('.jev-chip-tail');

    // Runners-up stack between the headline and the verbose detail. Reconciled in
    // place rather than rebuilt: `paint()` re-runs on every MutationObserver tick,
    // and rebuilding would churn the very DOM that observer is watching.
    const extras = (chip.labels || []).slice(1)
      .map((l) => (l.icon ? `${l.icon} ${l.label}` : l.label));
    const stale = [...node.querySelectorAll('.jev-chip-extra')];
    extras.forEach((text, i) => {
      let el = stale[i];
      if (!el) {
        el = span('jev-chip-extra');
        node.insertBefore(el, tailEl);
      }
      if (el.textContent !== text) el.textContent = text;
    });
    for (let i = extras.length; i < stale.length; i++) stale[i].remove();

    tailEl.textContent = tail || '';
    tailEl.hidden = !tail;
    // Squares off for runners-up as well as for verbose numbers — a 999px pill
    // around two or three lines reads as a lozenge.
    node.classList.toggle('jev-chip--stacked', !!tail || extras.length > 0);

    node.dataset.state = chip.state;
    node.dataset.member = memberId;

    const themed = chip.state === 'labeled';
    const { bg, fg } = chipColors(chip.family || 'neutral', isDark());
    node.style.background = themed ? bg : 'transparent';
    node.style.color = themed ? fg : 'inherit';
    node.classList.toggle('jev-chip--muted', !themed);

    const lean = Object.entries(chip.lean || {})
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${Math.round(v * 100)}%`)
      .join(', ');

    node.title = chip.state === 'labeled'
      ? [
          `${chip.label}${chip.probability != null ? ` ${Math.round(chip.probability * 100)}%` : ''}`,
          `${chip.cached}/${chip.seen} cmt đã lưu`,
          chip.expiresAt !== null
            ? `hết hạn ${new Date(chip.expiresAt).toLocaleString('vi-VN')}`
            : 'không hết hạn',
          lean || null,
        ].filter(Boolean).join(' · ')
      : chip.state === 'error'
        ? chip.message
        : `Đã thu thập ${chip.count}/${chip.threshold} bình luận — bấm để phân loại ngay`;
  }

  /** Spec §9: with the toggle off, members show nothing. */
  function clearChips() {
    for (const node of document.querySelectorAll('.jev-chip')) node.remove();
  }

  /** Idempotent: repaints every post whose member has a state. */
  function paint() {
    for (const el of document.querySelectorAll(POST_SEL)) {
      const memberId = memberIdOf(el);
      const chip = memberId ? chips.get(memberId) : null;
      if (!chip) continue;
      const host = chipHost(el);
      if (host) renderChip(host, chip, memberId);
    }
  }

  async function sendAndPaint(posts) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'collect', members: posts });
      if (!reply || !reply.labels) return;
      for (const [memberId, chip] of Object.entries(reply.labels)) chips.set(memberId, chip);
      paint();
    } catch (e) {
      console.warn('[jev] collect failed', e);
    }
  }

  function scan() {
    if (!enabled) return;
    const posts = extractPosts(document);
    if (!posts.length) return;
    const fresh = posts.filter((p) => !sent.has(p.postId));
    if (!fresh.length) return;
    for (const p of fresh) sent.add(p.postId);
    void sendAndPaint(fresh);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'labels') {
      for (const [memberId, chip] of Object.entries(msg.labels)) chips.set(memberId, chip);
      paint();
      return;
    }
    if (msg.type === 'rerender') {
      // A display-only setting changed. Re-read it and repaint; nothing is refetched.
      void cfgStore.get().then((c) => {
        enabled = c.enabled;
        verbose = c.verbose;
        paint();
      });
    }
  });

  // Config can change from the popup OR the options page, and neither knows which
  // tabs are open. Reacting to storage covers both, and covers threshold and label
  // edits, which a popup→tab message never did.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.cfg) return;
    const next = changes.cfg.newValue || {};
    enabled = next.enabled !== false;
    verbose = !!next.verbose;
    if (!enabled) clearChips(); else paint();
  });

  document.addEventListener('click', (e) => {
    const node = e.target.closest('.jev-chip');
    // Labeled chips are informational; only collecting and error chips act on click.
    if (!node || node.dataset.state === 'labeled') return;
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'force', memberId: node.dataset.member })
      .catch((err) => console.warn('[jev] force failed', err));
  }, true);

  const cfg = await cfgStore.get();
  enabled = cfg.enabled;
  verbose = cfg.verbose;
  scan();

  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 400);
  }).observe(document.body, { childList: true, subtree: true });

  // Colors are applied inline, so a theme switch needs a repaint.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paint);
})();
