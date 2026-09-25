import { describe, it, expect, beforeAll } from 'vitest';
import { analyze } from '../scripts/probe.js';

beforeAll(() => {
  // jsdom does not implement matchMedia; the probe reports it for the theme check.
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
});

// Provisional XenForo 2.x markup. Task 3's checkpoint replaces this with real
// voz HTML captured from the browser; the assertions below should still hold.
const FIXTURE = `
<html data-variation="alternate">
<body>
  <ul class="p-breadcrumbs">
    <li><a href="/">Diễn đàn</a></li>
    <li><a href="/f/chuyen-tro-linh-tinh.17/">Chuyện trò linh tinh</a></li>
  </ul>
  <h1 class="p-title-value">Thread tiêu đề</h1>
  <article class="message message--post js-post" data-author="alice" data-content="post-111" id="js-post-111">
    <div class="message-cell message-cell--user">
      <h4 class="message-name"><a href="/members/alice.4242/" class="username">alice</a></h4>
      <div class="message-userExtras">
        <dl class="pairs"><dt>Tham gia</dt><dd>Nov 12, 2019</dd></dl>
        <dl class="pairs"><dt>Bài viết</dt><dd>4,213</dd></dl>
      </div>
    </div>
    <div class="message-cell message-cell--main">
      <div class="message-content">
        <div class="bbWrapper">Nội dung bình luận đủ dài để vượt ngưỡng mười lăm ký tự.</div>
      </div>
    </div>
  </article>
  <div class="pageNav">
    <a class="pageNav-page" href="/t/x.1/page-2">2</a>
    <a class="pageNav-page" href="/t/x.1/page-50">50</a>
  </div>
</body>
</html>`;

describe('analyze', () => {
  it('counts candidate selectors', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.candidates['article.message']).toBe(1);
    expect(report.candidates['[data-content^="post-"]']).toBe(1);
    expect(report.candidates['.bbWrapper']).toBe(1);
    expect(report.candidates['[data-author]']).toBe(1);
  });

  it('describes the first post element', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.firstPost.tag).toBe('article');
    expect(report.firstPost.attributes['data-author']).toBe('alice');
    expect(report.firstPost.attributes['data-content']).toBe('post-111');
    expect(report.firstPost.classes).toContain('message--post');
    expect(typeof report.firstPost.outerHTML).toBe('string');
    expect(report.firstPost.outerHTML.length).toBeLessThanOrEqual(1500);
  });

  it('reports member id extraction from the profile link', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.members.name).toBe('alice');
    expect(report.members.id).toBe('4242');
    expect(report.members.joined).toBe('Nov 12, 2019');
    expect(report.members.postCount).toBe('4,213');
  });

  it('reports pagination and the last page number', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.pagination.pageNavFound).toBe(true);
    expect(report.pagination.lastPage).toBe(50);
  });

  it('reports the theme mechanism', () => {
    const report = analyze(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.theme.htmlAttributes['data-variation']).toBe('alternate');
    expect(report.theme.prefersDark).toBe(false);
  });

  it('returns zero counts and nulls on a page with no posts', () => {
    const report = analyze(new DOMParser().parseFromString('<html><body></body></html>', 'text/html'));
    expect(report.candidates['article.message']).toBe(0);
    expect(report.firstPost).toBeNull();
    expect(report.members).toBeNull();
  });

  it('is self-contained, so toString() can serialize it', () => {
    // The real check: rebuild from source alone, with no module scope available.
    const rebuilt = new Function(`return (${analyze.toString()})`)();
    const report = rebuilt(new DOMParser().parseFromString(FIXTURE, 'text/html'));
    expect(report.candidates['article.message']).toBe(1);
  });
});
