/**
 * Exploratory DOM structure report for a voz thread page.
 *
 * Deliberately exploratory rather than confirmatory: it dumps what is there
 * rather than testing a fixed list of guesses, so it survives whatever
 * XenForo version or template customization voz is running.
 *
 * MUST stay self-contained — no module-scope references — because
 * scripts/probe-print.mjs serializes this function with .toString().
 */
export function analyze(root) {
  const CANDIDATES = [
    'article.message',
    '[data-content^="post-"]',
    '[data-author]',
    '.message',
    '.bbWrapper',
    '.message-content',
    '.message-userExtras',
    '.message-name',
    '.message-attribution',
    'li.message',
    'table[id^="post"]',
    '.pageNav',
    '.p-title-value',
    '.p-breadcrumbs',
  ];

  const candidates = {};
  for (const sel of CANDIDATES) {
    let n = 0;
    try { n = root.querySelectorAll(sel).length; } catch { n = -1; }
    candidates[sel] = n;
  }

  const first = root.querySelector('article.message')
    || root.querySelector('[data-content^="post-"]')
    || root.querySelector('li.message')
    || root.querySelector('table[id^="post"]')
    || null;

  let firstPost = null;
  if (first) {
    const attributes = {};
    for (const a of first.attributes) attributes[a.name] = a.value;
    firstPost = {
      tag: first.tagName.toLowerCase(),
      classes: [...first.classList],
      attributes,
      outerHTML: first.outerHTML.slice(0, 1500),
    };
  }

  let members = null;
  if (first) {
    const link = first.querySelector('.message-name a[href*="/members/"], a.username[href*="/members/"]');
    const href = link ? link.getAttribute('href') : null;
    const m = href ? href.match(/\.(\d+)\/?$/) : null;
    // Collapse whitespace first: <dt>/<dd> markup concatenates without spaces.
    const extrasText = (first.querySelector('.message-userExtras')?.textContent || '')
      .replace(/\s+/g, ' ').trim();
    const joined = extrasText.match(/(?:Tham gia|Joined)\s*:?\s*(.+?)(?=\s*(?:Bài viết|Messages|Trophy|Điểm|$))/i);
    const postCount = extrasText.match(/(?:Bài viết|Messages)\s*:?\s*([\d.,]+)/i);
    members = {
      name: link ? link.textContent.trim() : (first.getAttribute('data-author') || null),
      id: m ? m[1] : null,
      joined: joined ? joined[1].trim() : null,
      postCount: postCount ? postCount[1].trim() : null,
      extrasSample: extrasText.slice(0, 300),
      href,
    };
  }

  const pageLinks = [...root.querySelectorAll('.pageNav-page, .pageNav a')];
  let lastPage = null;
  for (const a of pageLinks) {
    const n = parseInt(a.textContent.trim(), 10);
    if (!Number.isNaN(n) && (lastPage === null || n > lastPage)) lastPage = n;
  }
  const pagination = {
    pageNavFound: root.querySelectorAll('.pageNav').length > 0,
    linkCount: pageLinks.length,
    lastPage,
    sample: pageLinks.slice(0, 6).map((a) => a.getAttribute('href')),
  };

  const html = root.documentElement || root.querySelector('html');
  const htmlAttributes = {};
  if (html) for (const a of html.attributes) htmlAttributes[a.name] = a.value;
  const theme = {
    htmlAttributes,
    htmlClasses: html ? [...html.classList] : [],
    bodyClasses: root.body ? [...root.body.classList] : [],
    prefersDark: typeof matchMedia === 'function'
      ? matchMedia('(prefers-color-scheme: dark)').matches
      : null,
  };

  return { candidates, firstPost, members, pagination, theme };
}
