import { createConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { buildChipState, chipLabelText, chipTail } from './lib/chip.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
const store = createStore(chrome.storage.local);

async function render() {
  const cfg = await cfgStore.get();
  const members = await store.listMembers();

  $('enabled').checked = cfg.enabled;
  $('verbose').checked = cfg.verbose;

  // With the master toggle off the page shows no chips at all, so the detail
  // toggle has nothing to act on. Disable it instead of leaving it settable.
  $('verbose').disabled = !cfg.enabled;
  $('verboseRow').classList.toggle('off', !cfg.enabled);

  // §9 promises a warning row when the key is missing *or rejected*, and §8's
  // table gives 401/403 that exact string. Without this the only signal a bad or
  // expired key produced was a `!` chip behind a tooltip on the page. `lastError`
  // is already on every member record, so it rides the list we render below.
  const rejected = members.some(
    (m) => m.lastError && (m.lastError.code === 401 || m.lastError.code === 403),
  );
  $('warn').textContent = !cfg.apiKey
    ? 'Chưa cấu hình API key — chưa thể phân loại.'
    : rejected ? 'API key sai hoặc hết hạn' : '';

  // Built once, and counted from the same state the rows render, so the status
  // line cannot contradict them. `members.filter((m) => m.label)` counted a member
  // whose `lastError` is newer than its label as labeled while its row rendered an
  // error chip — `buildChipState` already implements the newer-error-wins
  // precedence, so the count must read it rather than second-guess it.
  const rows = members.map((m) => ({ m, chip: buildChipState(m, cfg, Date.now()) }));
  const labeled = rows.filter(({ chip }) => chip.state === 'labeled').length;
  $('status').textContent =
    `${members.length} thành viên · ${labeled} đã phân loại`;

  const box = $('members');
  box.textContent = '';
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = 'Chưa thu thập dữ liệu.';
    box.appendChild(empty);
    return;
  }

  for (const { m, chip } of rows) {
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = m.name;
    left.appendChild(name);
    if (chip.state === 'labeled') {
      const tag = document.createElement('span');
      // The row has the width to print every label the member carries, where the
      // chip on the page has to stack them.
      tag.textContent = ` · ${chipLabelText(chip)}`;
      left.appendChild(tag);
    }

    // Identity on the left, numbers on the right. Verbose *replaces* the bare
    // count rather than appending to it, so a row never prints "13 cmt" twice.
    const meta = document.createElement('span');
    meta.className = 'meta';
    const detail = chipTail(chip, cfg);
    meta.textContent = detail || (chip.state === 'collecting'
      ? `chưa phân loại · ${chip.count}/${chip.threshold}`
      : `${chip.cached} cmt`);

    row.append(left, meta);
    box.appendChild(row);
  }
}

$('enabled').addEventListener('change', async (e) => {
  await cfgStore.set({ enabled: e.target.checked });
  await render();
});

$('verbose').addEventListener('change', async (e) => {
  // No message to the tab: content.js now watches `cfg` in chrome.storage, which
  // covers this and every other tab at once — and the `enabled` toggle too.
  await cfgStore.set({ verbose: e.target.checked });
  await render();
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ bình luận và nhãn đã thu thập? Không hoàn tác được.')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
