/** The only module that knows voz.vn markup. Verified against the Task 3 probe. */
export const SELECTORS = {
  post: 'article.message',
  content: '.bbWrapper',
  quote: 'blockquote',
  // voz serves member pages at /u/<name>.<id>/, NOT XenForo's default /members/,
  // so this must not filter on a path prefix. The probe's /members/ guess matched
  // nothing on a live thread. The id comes from data-user-id instead.
  memberLink: '.message-name a, a.username',
  memberIdAttr: '[data-user-id]',
  // Absent on voz — verified by probe: its post bit shows no join date or post
  // count, only message-name and userTitle. Kept because it is standard XenForo
  // and other layouts do expose it; this path is defensive, not exercised by voz.
  extras: '.message-userExtras',
  threadTitle: '.p-title-value, h1.p-title-value',
};

/** A post shorter than this after quote-stripping is not evidence of anything. */
export const MIN_POST_CHARS = 15;

/** Collapse runs of whitespace and trim. */
export function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

/** Post body text with every nested quote removed. */
export function postTextFrom(el) {
  const content = el.querySelector(SELECTORS.content) || el;
  const clone = content.cloneNode(true);
  for (const q of clone.querySelectorAll(SELECTORS.quote)) q.remove();
  return cleanText(clone.textContent);
}

/**
 * Exported so content.js reuses it rather than re-deriving the same lookup.
 *
 * voz puts the member id in `data-user-id` on both the avatar and username links
 * and serves member pages at `/u/<name>.<id>/`. The href parse is the fallback
 * for a layout that omits the attribute.
 */
export function memberIdOf(el) {
  const tagged = el.querySelector(SELECTORS.memberIdAttr);
  const attr = tagged && tagged.getAttribute('data-user-id');
  if (attr) return attr;

  const link = el.querySelector(SELECTORS.memberLink);
  const href = link && link.getAttribute('href');
  const m = href && href.match(/\.(\d+)\/?$/);
  return m ? m[1] : null;
}

function profileFrom(el) {
  const extras = el.querySelector(SELECTORS.extras);
  const text = extras ? cleanText(extras.textContent) : '';
  const joined = text.match(/(?:Tham gia|Joined)\s*:?\s*([^\s]+(?:\s+[^\s]+){0,2}?)(?=\s*(?:Bài viết|Messages|Trophy|Điểm|$))/i);
  const postCount = text.match(/(?:Bài viết|Messages)\s*:?\s*([\d.,]+)/i);
  return {
    joined: joined ? joined[1].trim() : null,
    postCount: postCount ? postCount[1].trim() : null,
  };
}

export function postIdOf(el) {
  const content = el.getAttribute('data-content');
  if (content) {
    const m = content.match(/post-(\d+)/);
    if (m) return m[1];
  }
  const id = el.getAttribute('id');
  if (id) {
    const m = id.match(/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

/** Extract every usable post on a page (or a parsed document). */
export function extractPosts(root) {
  const titleEl = root.querySelector(SELECTORS.threadTitle);
  const thread = titleEl ? cleanText(titleEl.textContent) : null;
  const out = [];

  for (const el of root.querySelectorAll(SELECTORS.post)) {
    const postId = postIdOf(el);
    const memberId = memberIdOf(el);
    if (!postId || !memberId) continue;

    const text = postTextFrom(el);
    if (text.length < MIN_POST_CHARS) continue;

    const profile = profileFrom(el);
    out.push({
      postId,
      memberId,
      name: el.getAttribute('data-author') || (el.querySelector(SELECTORS.memberLink)?.textContent || '').trim(),
      text,
      thread,
      joined: profile.joined,
      postCount: profile.postCount,
    });
  }
  return out;
}
