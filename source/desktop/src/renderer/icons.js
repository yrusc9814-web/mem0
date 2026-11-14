'use strict';
// 线性图标（自绘，24x24 viewBox）
window.ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  link: '<circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v5m0 0-5.5 5.5M12 12l5.5 5.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8m0-4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16m0 4v-4h-4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.9.7c0 1.7-2.5 2.2-2.5 3.7"/><path d="M12 17h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  arrowDown: '<path d="M12 4.5v14m0 0 5.5-5.5M12 18.5 6.5 13"/>',
  arrowUpRight: '<path d="M7.5 16.5 16.5 7.5M9 7.5h7.5V15"/>',
  power: '<path d="M12 3.5v8"/><path d="M6.6 6.9a7.5 7.5 0 1 0 10.8 0"/>',
};
window.icon = (name, cls) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = window.ICONS[name] || '';
  return svg;
};

/* ============ mem0 自身品牌：唯一替换入口 ============
 * Logo 是 brand/mem0-mark.png（256×256，自带紫色圆角底，不要再在外面加底色/圆角/边框）；
 * 托盘用 tray.png + tray@2x.png，安装包图标是 build/icon.png。所有展示位置（顶栏、#mcp-flow 中枢、插件胶囊、连接页插件行）都从这里取。 */
window.MEM0_BRAND = { name: 'mem0', mark: 'brand/mem0-mark.png' };
window.brandMark = (cls = '') => {
  const img = document.createElement('img');
  img.className = `brand-mark ${cls}`.trim();
  img.src = window.MEM0_BRAND.mark;
  img.alt = window.MEM0_BRAND.name;
  img.draggable = false;
  return img;
};

/* ============ AI 来源品牌图标（本地 SVG 文件，见 brand/sources/LICENSES.md） ============
 * file：brand/sources/<file>.svg；dark：深色主题下改用 <file>-dark.svg（单色标志反白） */
window.SOURCE_ICONS = {
  'claude-code': { file: 'claude-code' }, codex: { file: 'codex', dark: true }, 'deepseek-harness': { file: 'deepseek' },
  antigravity: { file: 'antigravity' }, zcode: { file: 'zcode' }, dimcode: { file: 'dimcode' }, workbuddy: { file: 'workbuddy' },
  'chatgpt-web': { file: 'chatgpt', dark: true }, 'claude-web': { file: 'claude' }, 'gemini-web': { file: 'gemini' },
  'deepseek-web': { file: 'deepseek' }, 'doubao-web': { file: 'doubao' }, 'yuanbao-web': { file: 'yuanbao' },
  'kimi-web': { file: 'kimi', dark: true }, 'qianwen-web': { file: 'qwen' }, 'google-ai-mode-web': { file: 'google' },
  'grok-web': { file: 'grok', dark: true }, 'hark-web': { file: 'hark' },
};
/** 来源 Logo 图片（无框）。深色主题自动切换反白版本（CSS 控制显隐） */
window.sourceLogo = (id, cls = '') => {
  const meta = window.SOURCE_ICONS[id];
  const wrap = document.createElement('span');
  wrap.className = `slogo ${cls}`.trim();
  if (!meta) { wrap.classList.add('unknown'); wrap.append(window.icon('chat')); return wrap; }
  const mk = (src, c) => { const i = document.createElement('img'); i.src = src; i.alt = ''; i.draggable = false; if (c) i.className = c; return i; };
  if (meta.dark) wrap.append(mk(`brand/sources/${meta.file}.svg`, 'lt'), mk(`brand/sources/${meta.file}-dark.svg`, 'dk'));
  else wrap.append(mk(`brand/sources/${meta.file}.svg`));
  return wrap;
};

document.querySelectorAll('[data-icon]').forEach((el) => el.prepend(window.icon(el.dataset.icon)));
document.querySelectorAll('[data-brand]').forEach((el) => el.replaceChildren(window.brandMark()));
