'use strict';
const $ = (s) => document.querySelector(s);
const send = (msg) => chrome.runtime.sendMessage(msg);

const PLATFORMS = [
  ['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['deepseek', 'DeepSeek'], ['doubao', '豆包'],
  ['yuanbao', '元宝'], ['kimi', 'Kimi'], ['qianwen', '千问'], ['google-ai-mode', 'Google AI Mode'],
  ['grok', 'Grok'], ['hark', 'Hark'],
];
const NAME = Object.fromEntries(PLATFORMS);

function pill(el, text, cls) { el.textContent = text; el.className = `pill ${cls || ''}`; }

// 品牌图标（本地 SVG，来自桌面端 brand/sources）；dark：深色模式改用 -dark 反白版（CSS 控制显隐）
const LOGO = {
  chatgpt: ['chatgpt', true], claude: ['claude'], gemini: ['gemini'], deepseek: ['deepseek'], doubao: ['doubao'],
  yuanbao: ['yuanbao'], kimi: ['kimi', true], qianwen: ['qwen'], 'google-ai-mode': ['google'],
  grok: ['grok', true], hark: ['hark'],
};
function logo(id) {
  const wrap = document.createElement('span');
  wrap.className = 'slogo';
  const [file, dark] = LOGO[id] || [];
  if (!file) return wrap;
  const mk = (src, c) => { const i = document.createElement('img'); i.src = src; i.alt = ''; i.draggable = false; if (c) i.className = c; return i; };
  if (dark) wrap.append(mk(`brand/${file}.svg`, 'lt'), mk(`brand/${file}-dark.svg`, 'dk'));
  else wrap.append(mk(`brand/${file}.svg`));
  return wrap;
}
const GLOBE = document.querySelector('#page-av svg').cloneNode(true);
const nf = new Intl.NumberFormat('zh-CN');

async function render() {
  let s;
  try { s = await send({ type: 'status' }); } catch { s = null; }
  if (!s || !s.bridge) { pill($('#conn-state'), '后台未就绪', 'bad'); setTimeout(render, 800); return; }
  const b = s.bridge;
  const st = $('#conn-state');
  if (b.state === 'connected') pill(st, '已连接', 'ok');
  else if (b.state === 'need_pair') pill(st, '未配对', 'warn');
  else if (b.state === 'connecting') pill(st, '连接中', '');
  else pill(st, '未连接', 'bad');
  $('#conn-detail').textContent = b.state === 'connected'
    ? `桌面端 ${b.desktopVersion || ''}`
    : b.state === 'need_pair' ? (b.lastError || '首次使用需要和桌面端配对') : (b.lastError || '请打开 mem0 桌面端，对话会先存在插件里');
  $('#pair-form').classList.toggle('hidden', b.state !== 'need_pair');
  $('#unpair').classList.toggle('hidden', b.state === 'need_pair');
  $('#st-queued').textContent = nf.format(s.queued || 0);
  $('#queued').textContent = s.queued ? `${s.queued} 个对话等待同步` : (s.stats.lastSavedAt ? `上次保存 ${new Date(s.stats.lastSavedAt).toLocaleTimeString('zh-CN')}` : '');

  $('#paused').checked = s.paused;
  const box = $('#platforms');
  box.replaceChildren(...PLATFORMS.map(([id, name]) => {
    const label = document.createElement('label');
    label.className = 'chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !s.disabledPlatforms.includes(id);
    cb.addEventListener('change', async () => {
      const { disabledPlatforms = [] } = await chrome.storage.local.get('disabledPlatforms');
      const set = new Set(disabledPlatforms);
      cb.checked ? set.delete(id) : set.add(id);
      await chrome.storage.local.set({ disabledPlatforms: [...set] });
    });
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    label.title = name;
    label.append(cb, logo(id), nm);
    return label;
  }));

  // 当前标签页
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let page = null;
  try { page = tab && await chrome.tabs.sendMessage(tab.id, { type: 'pageStatus' }); } catch { /* 不是支持的网站 */ }
  const ps = $('#page-state');
  $('#page-av').replaceChildren(page && LOGO[page.platform] ? logo(page.platform) : GLOBE.cloneNode(true));
  $('#st-page').textContent = !page ? '–' : nf.format(page.conversation ? (page.messages || 0) : 0);
  $('#st-page').classList.toggle('none', !page);
  if (!page) { pill(ps, '不支持', ''); $('#page-detail').textContent = '在支持的 AI 网站打开对话即可自动备份'; }
  else if (!page.enabled) { pill(ps, '已暂停', 'warn'); $('#page-detail').textContent = NAME[page.platform]; }
  else if (!page.conversation) { pill(ps, '等待对话', ''); $('#page-detail').textContent = `${NAME[page.platform]} · 发出第一条消息后开始备份`; }
  else { pill(ps, '正在备份', 'ok'); $('#page-detail').textContent = `${NAME[page.platform]} · ${page.messages} 条消息${page.title ? ' · ' + page.title : ''}`; }
}

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#code').value.trim();
  const msg = $('#pair-msg');
  if (!/^\d{6}$/.test(code)) { msg.textContent = '请输入 6 位数字'; msg.className = 'small err'; return; }
  msg.textContent = '配对中…'; msg.className = 'small muted';
  const r = await send({ type: 'pair', code });
  msg.textContent = r.ok ? '配对成功' : r.error; msg.className = `small ${r.ok ? 'okc' : 'err'}`;
  render();
});
$('#paused').addEventListener('change', (e) => chrome.storage.local.set({ paused: e.target.checked }).then(render));
$('#unpair').addEventListener('click', () => send({ type: 'unpair' }).then(render));

render();
send({ type: 'reconnect' }).then(() => setTimeout(render, 600));
