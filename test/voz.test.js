import { describe, it, expect } from 'vitest';
import { extractPosts, MIN_POST_CHARS } from '../extension/lib/voz.js';

const FIXTURE_PAGE = `
<html data-xf="2.3" data-template="thread_view"><body>
  <h1 class="p-title-value">Nỗ lệ của AI</h1>

  <article class="message message--post js-post js-inlineModContainer   is-unread" data-author="kido1412" data-content="post-43808330" id="js-post-43808330">
    <div class="message-inner">
      <div class="message-cell message-cell--user">
        <section class="message-user">
          <div class="message-avatar"><a href="/u/kido1412.821098/" class="avatar avatar--m" data-user-id="821098"><img alt="kido1412"></a></div>
          <div class="message-userDetails">
            <h4 class="message-name"><a href="/u/kido1412.821098/" class="username " dir="auto" data-user-id="821098">kido1412</a></h4>
            <h5 class="userTitle message-userTitle" dir="auto">Đã tốn tiền</h5>
          </div>
        </section>
      </div>
      <div class="message-cell message-cell--main">
        <div class="message-main js-quickEditTarget">
          <div class="message-content js-messageContent"><div class="bbWrapper">
            Đây là một bình luận đủ dài để vượt qua ngưỡng lọc tối thiểu.
            <blockquote class="bbCodeBlock bbCodeBlock--quote js-expandableMessage">
              <div class="bbCodeBlock-title"><a href="/goto/post?id=1">Nguyên văn lời của người khác</a></div>
              <div class="bbCodeBlock-content">Nội dung trích dẫn mà ta không được tính vào bài này.</div>
            </blockquote>
            Phần nội dung tiếp theo của chính kido1412.
          </div></div>
        </div>
      </div>
    </div>
  </article>

  <article class="message message--post js-post js-inlineModContainer" data-author="bob" data-content="post-43808331" id="js-post-43808331">
    <div class="message-inner">
      <div class="message-cell message-cell--user">
        <section class="message-user">
          <div class="message-userDetails">
            <h4 class="message-name"><a href="/u/bob.555/" class="username " data-user-id="555">bob</a></h4>
          </div>
        </section>
      </div>
      <div class="message-cell message-cell--main">
        <div class="message-main"><div class="message-content"><div class="bbWrapper">
          <blockquote class="bbCodeBlock bbCodeBlock--quote">
            <div class="bbCodeBlock-content">Chỉ toàn là trích dẫn, không có chữ nào của bob ở đây cả.</div>
          </blockquote>
        </div></div></div>
      </div>
    </div>
  </article>

  <article class="message message--post js-post js-inlineModContainer" data-author="carol" data-content="post-43808332" id="js-post-43808332">
    <div class="message-inner">
      <div class="message-cell message-cell--user">
        <section class="message-user">
          <div class="message-userDetails">
            <h4 class="message-name"><a href="/u/carol.777/" class="username " data-user-id="777">carol</a></h4>
          </div>
        </section>
      </div>
      <div class="message-cell message-cell--main">
        <div class="message-main"><div class="message-content"><div class="bbWrapper">
          Ngắn
          <blockquote class="bbCodeBlock bbCodeBlock--quote">
            <div class="bbCodeBlock-content">Trích dẫn dài dòng mà carol không hề viết ra.</div>
          </blockquote>
        </div></div></div>
      </div>
    </div>
  </article>

  <article class="message message--post js-post js-inlineModContainer" data-author="dave" data-content="post-43808333" id="js-post-43808333">
    <div class="message-inner">
      <div class="message-cell message-cell--user">
        <section class="message-user">
          <div class="message-userDetails">
            <h4 class="message-name"><a href="/u/dave.888/" class="username " data-user-id="888">dave</a></h4>
          </div>
        </section>
      </div>
      <div class="message-cell message-cell--main">
        <div class="message-main"><div class="message-content"><div class="bbWrapper">
          Mở đầu bài của dave cũng đủ dài để được giữ lại.
          <blockquote class="bbCodeBlock bbCodeBlock--quote">
            <div class="bbCodeBlock-content">
              Trích dẫn lồng nhau của người khác.
              <blockquote class="bbCodeBlock bbCodeBlock--quote">
                <div class="bbCodeBlock-content">Sâu hơn nữa, cũng không phải của dave.</div>
              </blockquote>
            </div>
          </blockquote>
          Kết thúc bài của dave ở đây.
        </div></div></div>
      </div>
    </div>
  </article>
</body></html>`;

// voz's post bit carries no message-userExtras, so join date and post count are
// null on every real thread page. This exercises the defensive path separately.
const FIXTURE_WITH_EXTRAS = `
<html><body>
  <article class="message message--post" data-author="erin" data-content="post-9" id="js-post-9">
    <div class="message-inner">
      <div class="message-cell message-cell--user">
        <section class="message-user">
          <div class="message-userDetails">
            <h4 class="message-name"><a href="/u/erin.999/" class="username" data-user-id="999">erin</a></h4>
            <div class="message-userExtras">
              <dl class="pairs pairs--justified"><dt>Tham gia</dt><dd>Nov 12, 2019</dd></dl>
              <dl class="pairs pairs--justified"><dt>Bài viết</dt><dd>4,213</dd></dl>
            </div>
          </div>
        </section>
      </div>
      <div class="message-cell message-cell--main">
        <div class="message-main"><div class="message-content"><div class="bbWrapper">
          Bình luận của erin đủ dài để vượt qua ngưỡng lọc tối thiểu.
        </div></div></div>
      </div>
    </div>
  </article>
</body></html>`;

const doc = () => new DOMParser().parseFromString(FIXTURE_PAGE, 'text/html');
const docExtras = () => new DOMParser().parseFromString(FIXTURE_WITH_EXTRAS, 'text/html');

// The fixture's real post ids, so the tests read against the markup they came from.
const P = { kido: '43808330', bob: '43808331', carol: '43808332', dave: '43808333' };

describe('extractPosts', () => {
  it('returns one entry per post with usable text, dropping the rest', () => {
    // bob is pure quote, carol is under the floor, so only kido and dave remain.
    expect(extractPosts(doc()).map((p) => p.postId)).toEqual([P.kido, P.dave]);
  });

  it('reads the member id from data-user-id and the name from data-author', () => {
    const first = extractPosts(doc()).find((p) => p.postId === P.kido);
    expect(first.memberId).toBe('821098');
    expect(first.name).toBe('kido1412');
  });

  it('falls back to parsing the id out of a /u/<name>.<id>/ href', () => {
    // voz serves member pages at /u/, not XenForo's default /members/. Strip the
    // attribute so the href is the only remaining source of the id.
    const withoutAttr = FIXTURE_PAGE.replace(/ data-user-id="821098"/g, '');
    const page = new DOMParser().parseFromString(withoutAttr, 'text/html');
    expect(extractPosts(page).find((p) => p.postId === P.kido).memberId).toBe('821098');
  });

  it('strips a quoted block from the middle of a post, keeping both own parts', () => {
    const first = extractPosts(doc()).find((p) => p.postId === P.kido);
    expect(first.text).not.toContain('Nội dung trích dẫn mà ta không được tính');
    expect(first.text).toContain('Đây là một bình luận đủ dài');
    expect(first.text).toContain('Phần nội dung tiếp theo của chính kido1412');
  });

  it('strips nested quoted blocks', () => {
    const dave = extractPosts(doc()).find((p) => p.postId === P.dave);
    expect(dave.text).not.toContain('Trích dẫn lồng nhau');
    expect(dave.text).not.toContain('Sâu hơn nữa');
    expect(dave.text).toContain('Mở đầu bài của dave');
    expect(dave.text).toContain('Kết thúc bài của dave');
  });

  it('drops a post that is nothing but a quote', () => {
    expect(extractPosts(doc()).find((p) => p.postId === P.bob)).toBeUndefined();
  });

  it('drops a post whose stripped text is under the floor', () => {
    // carol's own words are 'Ngắn' — 4 characters; the rest was someone else's.
    expect(extractPosts(doc()).find((p) => p.postId === P.carol)).toBeUndefined();
    expect(MIN_POST_CHARS).toBe(15);
  });

  it('collapses whitespace', () => {
    const first = extractPosts(doc()).find((p) => p.postId === P.kido);
    expect(first.text).not.toMatch(/\s{2,}/);
    expect(first.text).not.toMatch(/^\s|\s$/);
  });

  it('carries thread title when present', () => {
    expect(extractPosts(doc()).find((p) => p.postId === P.kido).thread).toBe('Nỗ lệ của AI');
  });

  it('finds no join date or post count on voz markup, which has no message-userExtras', () => {
    // Verified by probe: voz's post bit carries only message-name and userTitle.
    for (const p of extractPosts(doc())) {
      expect(p.joined).toBeNull();
      expect(p.postCount).toBeNull();
    }
  });

  it('parses join date and post count when a layout does expose them', () => {
    // Defensive path: standard XenForo, not what voz serves today.
    const erin = extractPosts(docExtras())[0];
    expect(erin.name).toBe('erin');
    expect(erin.joined).toBe('Nov 12, 2019');
    expect(erin.postCount).toBe('4,213');
  });

  it('returns an empty array on a page with no posts', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(extractPosts(empty)).toEqual([]);
  });
});
