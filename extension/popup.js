import { createConfig } from './lib/config.js';

const $ = (id) => document.getElementById(id);

const cfg = createConfig(chrome.storage.local);

async function render() {
  const c = await cfg.get();
  $('enabled').checked = c.enabled;
  $('verbose').checked = c.verbose;
  $('warn').textContent = c.apiKey ? '' : 'Chưa cấu hình API key — chưa thể phân loại.';
  $('status').textContent = c.enabled ? 'Đang bật' : 'Đang tắt';
}

$('enabled').addEventListener('change', async (e) => {
  await cfg.set({ enabled: e.target.checked });
  await render();
});

$('verbose').addEventListener('change', async (e) => {
  await cfg.set({ verbose: e.target.checked });
  await render();
});

$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

render();
