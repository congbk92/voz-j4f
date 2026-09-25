import { createConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { buildChipState, chipText } from './lib/chip.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
const store = createStore(chrome.storage.local);

async function render() {
  const cfg = await cfgStore.get();
  $('enabled').checked = cfg.enabled;
  $('verbose').checked = cfg.verbose;
  $('warn').textContent = cfg.apiKey ? '' : 'Chưa cấu hình API key — chưa thể phân loại.';

  const members = await store.listMembers();
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
  await cfgStore.set({ verbose: e.target.checked });
  // Sent unconditionally, with no URL guard. `tabs.Tab.url` is populated only
  // when the extension has host permission for that tab's URL, and this extension
  // deliberately declares none for voz — it relies on `content_scripts.matches`
  // alone. Whether that alone populates `tab.url` is not something to build a
  // feature on, and guarding on it would silently skip the re-render. A tab with
  // no content script simply rejects, which the catch swallows.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'rerender' }).catch(() => {});
  await render();
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ bình luận và nhãn đã thu thập? Không hoàn tác được.')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
