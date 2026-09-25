import { createConfig, DEFAULTS } from './lib/config.js';
import {
  FAMILY_COLORS, DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS,
} from './lib/labels.js';
import { buildState, buildQuestions, callJev, parseAnswer } from './lib/jev.js';

const $ = (id) => document.getElementById(id);
const cfgStore = createConfig(chrome.storage.local);
let labels = [];

/**
 * Read a numeric field, falling back to the default when the field is empty or
 * non-numeric. `Number('')` is 0, not NaN, so a cleared field would otherwise
 * reach `normalize` as a real 0 and be clamped to the field's minimum — silently
 * meaning "the least possible" rather than "unchanged".
 */
const num = (id, fallback) => {
  const raw = $(id).value.trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

function renderLabels() {
  const table = $('labels');
  table.textContent = '';
  labels.forEach((l, i) => {
    const tr = document.createElement('tr');

    const icon = document.createElement('td');
    icon.className = 'icon';
    const iconInput = document.createElement('input');
    iconInput.type = 'text';
    iconInput.value = l.icon || '';
    iconInput.maxLength = 8;
    iconInput.title = 'Biểu tượng hiện trên nhãn (emoji hoặc ký tự)';
    iconInput.addEventListener('input', () => { labels[i].icon = iconInput.value.trim(); });
    icon.appendChild(iconInput);

    const key = document.createElement('td');
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.value = l.key;
    keyInput.pattern = '[a-z0-9_]+';
    keyInput.addEventListener('input', () => { labels[i].key = keyInput.value.trim(); });
    key.appendChild(keyInput);

    const name = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = l.label;
    nameInput.addEventListener('input', () => { labels[i].label = nameInput.value; });
    name.appendChild(nameInput);

    const desc = document.createElement('td');
    desc.className = 'desc';
    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = l.description;
    descInput.addEventListener('input', () => { labels[i].description = descInput.value; });
    desc.appendChild(descInput);

    const fam = document.createElement('td');
    const famSelect = document.createElement('select');
    for (const f of Object.keys(FAMILY_COLORS)) {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      if (f === l.family) opt.selected = true;
      famSelect.appendChild(opt);
    }
    famSelect.addEventListener('change', () => { labels[i].family = famSelect.value; });
    fam.appendChild(famSelect);

    const del = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.textContent = '×';
    delBtn.title = 'Xoá nhãn';
    delBtn.addEventListener('click', () => {
      if (labels.length <= 1) { alert('Phải còn ít nhất một nhãn.'); return; }
      labels.splice(i, 1);
      renderLabels();
    });
    del.appendChild(delBtn);

    tr.append(icon, key, name, desc, fam, del);
    table.appendChild(tr);
  });
}

async function load() {
  const cfg = await cfgStore.get();
  $('apiKey').value = cfg.apiKey;
  $('modelId').value = cfg.modelId;
  $('threshold').value = cfg.threshold;
  $('reclassifyEvery').value = cfg.reclassifyEvery;
  $('ttlDays').value = Math.round(cfg.labelTtlMs / 86400000);
  $('maxPostsPerMember').value = cfg.maxPostsPerMember;
  $('maxMembers').value = cfg.maxMembers;
  labels = cfg.labels.map((l) => ({ ...l }));
  renderLabels();
}

$('addLabel').addEventListener('click', () => {
  labels.push({ key: 'nhan_moi', icon: '🏷️', label: 'Nhãn mới', family: 'neutral', description: '' });
  renderLabels();
});

$('save').addEventListener('click', async () => {
  const keys = labels.map((l) => l.key);
  if (new Set(keys).size !== keys.length) { alert('Key nhãn bị trùng.'); return; }
  if (keys.some((k) => !/^[a-z0-9_]+$/.test(k))) {
    alert('Key nhãn chỉ được gồm a-z, 0-9 và dấu gạch dưới.');
    return;
  }
  if (labels.some((l) => !l.description.trim())) { alert('Mô tả nhãn không được để trống.'); return; }

  await cfgStore.set({
    apiKey: $('apiKey').value.trim(),
    modelId: $('modelId').value.trim() || 'typesafe-ai/jev',
    threshold: num('threshold', DEFAULTS.threshold),
    reclassifyEvery: num('reclassifyEvery', DEFAULTS.reclassifyEvery),
    labelTtlMs: Math.max(0, num('ttlDays', DEFAULTS.labelTtlMs / 86400000)) * 86400000,
    maxPostsPerMember: num('maxPostsPerMember', DEFAULTS.maxPostsPerMember),
    maxMembers: num('maxMembers', DEFAULTS.maxMembers),
    labels: labels.map((l) => ({ ...l })),
  });
  $('saveResult').textContent = '✓ Đã lưu';
  $('saveResult').className = 'ok';
  await load();
});

$('test').addEventListener('click', async () => {
  const out = $('testResult');
  const cfg = await cfgStore.get();
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { out.textContent = 'Chưa nhập key.'; out.className = 'bad'; return; }
  out.textContent = 'Đang kiểm tra…';
  out.className = '';

  const sample = {
    name: 'test', totalPosts: 2, threads: ['Kiểm tra'],
    posts: [
      { text: 'Theo tôi vấn đề này cần nhìn vào số liệu cụ thể, bác nào có nguồn thì dẫn ra cùng bàn.' },
      { text: 'Nói mãi cũng chỉ có mấy câu đó, chả có dẫn chứng gì cả.' },
    ],
    profile: {},
  };

  try {
    const answers = await callJev({
      apiKey,
      modelId: $('modelId').value.trim() || 'typesafe-ai/jev',
      state: buildState(sample),
      questions: buildQuestions(labels.length ? labels : DEFAULT_LABELS, LEAN_QUESTIONS, ARCHETYPE_INSTRUCTIONS),
    });
    const parsed = parseAnswer(answers, labels.length ? labels : DEFAULT_LABELS);
    out.textContent = `✓ ${parsed.choice} (${Object.entries(parsed.lean).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(', ') || 'no lean'})`;
    out.className = 'ok';
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.className = 'bad';
  }
});

load();
