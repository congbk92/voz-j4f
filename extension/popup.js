import { createConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { buildChipState, chipText } from './lib/chip.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
const store = createStore(chrome.storage.local);

async function render() {
  const cfg = await cfgStore.get();
  const members = await store.listMembers();

  $('enabled').checked = cfg.enabled;
  $('verbose').checked = cfg.verbose;

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

  const labeled = members.filter((m) => m.label).length;
  $('status').textContent =
    `${members.length} thành viên · ${labeled} đã phân loại`;

  const box = $('members');
  box.textContent = '';
  if (!members.length) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = 'Chưa thu thập dữ liệu.';
    box.appendChild(empty);
    return;
  }

  for (const m of members) {
    const chip = buildChipState(m, cfg, Date.now());
    const row = document.createElement('div');
    row.className = 'row';

    const left = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = m.name;
    left.appendChild(name);
    if (chip.state === 'labeled') {
      const tag = document.createElement('span');
      tag.textContent = ` · ${chipText(chip, cfg)}`;
      left.appendChild(tag);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = chip.state === 'collecting'
      ? `chưa phân loại · ${chip.count}/${chip.threshold}`
      : `${chip.cached} cmt`;

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
