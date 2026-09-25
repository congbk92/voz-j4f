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
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url && tab.url.startsWith('https://voz.vn/')) {
    chrome.tabs.sendMessage(tab.id, { type: 'rerender' }).catch(() => {});
  }
  await render();
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Xoá toàn bộ bình luận và nhãn đã thu thập? Không hoàn tác được.')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
