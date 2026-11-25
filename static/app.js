'use strict';

const $ = (sel, el = document) => el.querySelector(sel);

const UPCOMING_BACK = 7;   // days in the past still shown under "Coming up"
const UPCOMING_AHEAD = 30; // days ahead shown under "Coming up"

const state = {
  items: [],
  view: 'all',      // all | pinned | upcoming | archive | tag
  tag: null,
  q: '',
  selectedId: null,
  editing: false,
};

const ICON_PIN = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 3a1 1 0 0 1 .7 1.7L15.4 6l2.6 5.2 1.3-1.3a1 1 0 1 1 1.4 1.4l-3.5 3.5L21 18.6a1 1 0 0 1-1.4 1.4l-3.8-3.8-3.5 3.5a1 1 0 0 1-1.4-1.4l1.3-1.3L7 14.4l-1.3 1.3a1 1 0 0 1-1.4-1.4l9-9A1 1 0 0 1 16 3Z"/></svg>';

/* ---------- API ---------- */

async function api(method, path, body, opts = {}) {
  const init = { method, headers: {}, keepalive: !!opts.keepalive };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) { /* not json */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- Helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function daysFromToday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())) / 86400000);
}

function isUpcoming(it) {
  if (!it.date) return false;
  const n = daysFromToday(it.date);
  return n >= -UPCOMING_BACK && n <= UPCOMING_AHEAD;
}

function dateLabel(iso, long = false) {
  const n = daysFromToday(iso);
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const full = dt.toLocaleDateString(undefined, {
    weekday: long ? 'short' : undefined,
    month: 'short',
    day: 'numeric',
    year: dt.getFullYear() !== new Date().getFullYear() || long ? 'numeric' : undefined,
  });
  let rel = '';
  if (n === 0) rel = 'Today';
  else if (n === 1) rel = 'Tomorrow';
  else if (n === -1) rel = 'Yesterday';
  else if (n > 1 && n < 14) rel = `In ${n} days`;
  else if (n < -1 && n > -14) rel = `${-n} days ago`;
  if (long) return rel ? `${full} (${rel.toLowerCase()})` : full;
  return rel || full;
}

function dateClass(iso) {
  const n = daysFromToday(iso);
  if (n < 0) return 'past';
  if (n <= 3) return 'soon';
  return '';
}

function dateBadge(iso, long = false) {
  return `<span class="date ${dateClass(iso)}" title="${esc(iso)}">${esc(dateLabel(iso, long))}</span>`;
}

function relTime(ts) {
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function parseTags(text) {
  const out = [];
  for (const raw of text.split(',')) {
    const t = raw.trim().replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function current() {
  return state.items.find(i => i.id === state.selectedId) || null;
}

function replaceItem(item) {
  const i = state.items.findIndex(x => x.id === item.id);
  if (i >= 0) state.items[i] = item; else state.items.unshift(item);
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- Search ---------- */

function searchTerms() {
  return state.q.toLowerCase().split(/\s+/).filter(Boolean);
}

// -1 means "doesn't match". Every term has to show up somewhere.
function matchScore(it, terms) {
  const title = it.title.toLowerCase();
  const body = it.body.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (t.startsWith('#')) {
      const tag = t.slice(1);
      if (!tag) continue;
      if (!it.tags.some(x => x.startsWith(tag))) return -1;
      score += 2;
      continue;
    }
    let s = 0;
    if (title.includes(t)) s += title.startsWith(t) ? 6 : 4;
    if (it.tags.some(x => x.includes(t))) s += 3;
    if (body.includes(t)) s += 1;
    if (!s) return -1;
    score += s;
  }
  return score;
}

function visibleItems() {
  const terms = searchTerms();
  let list = state.items.filter(it => (state.view === 'archive' ? it.archived : !it.archived));
  if (state.view === 'pinned') list = list.filter(i => i.pinned);
  else if (state.view === 'upcoming') list = list.filter(isUpcoming);
  else if (state.view === 'tag') list = list.filter(i => i.tags.includes(state.tag));

  const scored = list
    .map(it => ({ it, s: terms.length ? matchScore(it, terms) : 0 }))
    .filter(x => x.s >= 0);

  scored.sort((a, b) => {
    if (state.view === 'upcoming') return a.it.date.localeCompare(b.it.date);
    if (a.it.pinned !== b.it.pinned) return a.it.pinned ? -1 : 1;
    if (b.s !== a.s) return b.s - a.s;
    return b.it.updated.localeCompare(a.it.updated);
  });
  return scored.map(x => x.it);
}

function highlight(raw, terms) {
  terms = terms.filter(t => !t.startsWith('#'));
  if (!terms.length) return esc(raw);
  const lower = raw.toLowerCase();
  const hit = new Array(raw.length).fill(false);
  for (const t of terms) {
    let i = lower.indexOf(t);
    while (i !== -1) {
      for (let k = i; k < i + t.length; k++) hit[k] = true;
      i = lower.indexOf(t, i + t.length);
    }
  }
  let out = '';
  let open = false;
  for (let k = 0; k < raw.length; k++) {
    if (hit[k] && !open) { out += '<mark>'; open = true; }
    if (!hit[k] && open) { out += '</mark>'; open = false; }
    out += esc(raw[k]);
  }
  return open ? out + '</mark>' : out;
}

function plainText(src) {
  return src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*(#{1,6}|>|[-*]|\d+[.)])\s+/gm, '')
    .replace(/[*`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(it, terms) {
  const plain = plainText(it.body);
  const words = terms.filter(t => !t.startsWith('#'));
  let text = plain.slice(0, 160);
  if (words.length) {
    const lower = plain.toLowerCase();
    const idx = Math.min(...words.map(t => lower.indexOf(t)).filter(i => i >= 0));
    if (isFinite(idx) && idx > 60) text = '…' + plain.slice(idx - 40, idx + 120);
  }
  return highlight(text, words);
}

/* ---------- Markdown (small and safe: escapes first, then formats) ---------- */

function inline(raw) {
  const codes = [];
  let s = esc(raw).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code title="Click to copy">${codes[i]}</code>`);
}

function md(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>` + list.items.map(x => `<li${x.cls ? ` class="${x.cls}"` : ''}>${x.html}</li>`).join('') + `</${list.type}>`);
    list = null;
  };
  const addLi = (type, html, cls) => {
    flushPara();
    if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
    list.items.push({ html, cls });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); i++; continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = m[1].length + 1;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i++; continue;
    }
    if ((m = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))) { addLi('ul', inline(m[2]), m[1] === ' ' ? 'check' : 'check done'); i++; continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { addLi('ul', inline(m[1])); i++; continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { addLi('ol', inline(m[1])); i++; continue; }
    if (/^>\s?/.test(line)) {
      flushPara(); flushList();
      const buf = [];
      while (i < lines.length && (m = lines[i].match(/^>\s?(.*)$/))) { buf.push(m[1]); i++; }
      out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
      continue;
    }
    flushList();
    para.push(line);
    i++;
  }
  flushPara(); flushList();
  return out.join('');
}

/* ---------- Rendering ---------- */

const VIEW_NAMES = { all: 'Everything', pinned: 'Pinned', upcoming: 'Coming up', archive: 'Archive' };

function renderSidebar() {
  const active = state.items.filter(i => !i.archived);
  const views = [
    ['all', active.length],
    ['pinned', active.filter(i => i.pinned).length],
    ['upcoming', active.filter(isUpcoming).length],
    ['archive', state.items.filter(i => i.archived).length],
  ];
  $('#views').innerHTML = views.map(([v, n]) =>
    `<button class="nav ${state.view === v ? 'on' : ''}" data-view="${v}"><span>${VIEW_NAMES[v]}</span><span class="count">${n || ''}</span></button>`
  ).join('');

  const counts = new Map();
  active.forEach(i => i.tags.forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  const tags = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
  $('#tags').innerHTML = tags.length
    ? tags.map(([t, n]) =>
        `<button class="nav ${state.view === 'tag' && state.tag === t ? 'on' : ''}" data-tag="${esc(t)}"><span>#${esc(t)}</span><span class="count">${n}</span></button>`
      ).join('')
    : '<div class="side-empty">Tags you add will show up here.</div>';
}

function viewTitle() {
  return state.view === 'tag' ? `#${state.tag}` : VIEW_NAMES[state.view];
}

function renderList() {
  const items = visibleItems();
  const terms = searchTerms();
  const where = viewTitle();

  let head = state.q
    ? `<span>${items.length} ${items.length === 1 ? 'match' : 'matches'} in ${esc(where)}</span>`
    : `<span>${esc(where)}</span><span>${items.length}</span>`;
  if (state.q && state.view !== 'all') head += '<button class="link" data-act="search-all">Search everything</button>';
  $('#listHead').innerHTML = head;

  if (!items.length) {
    let msg;
    if (state.q) msg = 'Nothing matches that. Try fewer words.';
    else if (state.view === 'pinned') msg = 'Nothing pinned yet. Pin the things you look up the most.';
    else if (state.view === 'upcoming') msg = 'Nothing dated in the next month.';
    else if (state.view === 'archive') msg = 'The archive is empty.';
    else msg = 'Nothing here yet. Press <kbd>N</kbd> to add the first thing you don\'t want to forget.';
    $('#list').innerHTML = `<li class="empty">${msg}</li>`;
    return;
  }

  $('#list').innerHTML = items.map(it => {
    const title = it.title.trim();
    return `<li class="item ${it.id === state.selectedId ? 'sel' : ''}" data-id="${it.id}">
      <div class="row1">
        ${it.pinned ? `<span class="pin" title="Pinned">${ICON_PIN}</span>` : ''}
        <span class="title ${title ? '' : 'untitled'}">${title ? highlight(title, terms) : 'Untitled'}</span>
        ${it.date ? dateBadge(it.date) : ''}
      </div>
      ${it.body.trim() ? `<div class="snippet">${snippet(it, terms)}</div>` : ''}
      <div class="row3">
        ${it.tags.map(t => `<span class="tag">#${highlight(t, terms)}</span>`).join('')}
        <span class="when">${relTime(it.updated)}</span>
      </div>
    </li>`;
  }).join('');
}

function renderHome() {
  const active = state.items.filter(i => !i.archived);
  const soon = active.filter(i => i.date && daysFromToday(i.date) >= 0).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5);
  const pinned = active.filter(i => i.pinned).slice(0, 6);
  const rows = list => '<ul class="upnext">' + list.map(i =>
    `<li data-open="${i.id}"><span class="t">${esc(i.title || 'Untitled')}</span>${i.date ? dateBadge(i.date) : ''}</li>`
  ).join('') + '</ul>';
  const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl';

  return `<div class="scroll"><div class="home">
    <h2>${active.length ? 'What are you looking for?' : 'Welcome to FocusMe'}</h2>
    <p>${active.length
      ? `You're keeping track of ${active.length} ${active.length === 1 ? 'thing' : 'things'}. Search, pick one from the list, or add something new.`
      : 'This is where the stuff you keep needing to remember goes. Account numbers, how-tos, who to call about what, that thing your boss said in March. Write it down once and find it again in a second.'}</p>
    ${soon.length ? `<h3>Coming up</h3>${rows(soon)}` : ''}
    ${pinned.length ? `<h3>Pinned</h3>${rows(pinned)}` : ''}
    <h3>Shortcuts</h3>
    <div class="keys">
      <span><kbd>/</kbd> or <kbd>${mod}</kbd> <kbd>K</kbd></span><span>Search</span>
      <span><kbd>N</kbd></span><span>New item</span>
      <span><kbd>J</kbd> <kbd>K</kbd> or arrows</span><span>Move through the list</span>
      <span><kbd>E</kbd> or <kbd>Enter</kbd></span><span>Edit the selected item</span>
      <span><kbd>P</kbd></span><span>Pin or unpin</span>
      <span><kbd>Esc</kbd></span><span>Done editing, clear search</span>
      <span><kbd>#tag</kbd> in search</span><span>Only match that tag</span>
    </div>
  </div></div>`;
}

function renderDetail() {
  const it = current();
  const el = $('#detail');
  document.body.classList.toggle('has-selection', !!it);
  if (!it) { el.innerHTML = renderHome(); return; }
  if (state.editing) { renderEditor(it); return; }

  el.innerHTML = `
    <div class="detail-bar">
      <button class="back" data-act="back">‹ Back</button>
      <div class="spacer"></div>
      <button data-act="pin">${it.pinned ? 'Unpin' : 'Pin'}</button>
      <button data-act="archive">${it.archived ? 'Restore' : 'Archive'}</button>
      <button data-act="delete" class="danger">Delete</button>
      <button data-act="edit" class="primary">Edit</button>
    </div>
    <div class="scroll"><article class="doc">
      <h1>${esc(it.title.trim() || 'Untitled')}</h1>
      <div class="meta">
        ${it.date ? dateBadge(it.date, true) : ''}
        ${it.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
        <span class="sep">Updated ${esc(relTime(it.updated))}</span>
      </div>
      <div class="md">${it.body.trim() ? md(it.body) : '<p class="muted">No details yet. Press E to add some.</p>'}</div>
    </article></div>`;
}

function renderEditor(it) {
  const el = $('#detail');
  el.innerHTML = `
    <div class="detail-bar">
      <button class="back" data-act="back">‹ Back</button>
      <span class="status" id="saveStatus">Changes save as you type</span>
      <div class="spacer"></div>
      <button data-act="done" class="primary">Done</button>
    </div>
    <div class="editor">
      <input class="ed-title" id="edTitle" placeholder="What do you need to remember?" autocomplete="off">
      <div class="ed-row">
        <label class="grow">Tags, separated by commas<input id="edTags" placeholder="work, family, car" autocomplete="off"></label>
        <label>Date it matters (optional)
          <span class="date-wrap"><input type="date" id="edDate"><button class="small" data-act="clear-date" type="button">Clear</button></span>
        </label>
      </div>
      <textarea id="edBody" placeholder="The details. Links, numbers, steps, names, whatever future you will need.&#10;&#10;Markdown works: **bold**, - lists, \`code\`, [links](https://example.com)"></textarea>
      <div class="hint">Esc or ${/Mac/.test(navigator.platform) ? '⌘' : 'Ctrl'}+Enter when you're done.</div>
    </div>`;
  $('#edTitle').value = it.title;
  $('#edTags').value = it.tags.join(', ');
  $('#edDate').value = it.date || '';
  $('#edBody').value = it.body;

  $('#edTitle').addEventListener('input', e => queueSave({ title: e.target.value }));
  $('#edBody').addEventListener('input', e => queueSave({ body: e.target.value }));
  $('#edTags').addEventListener('input', e => queueSave({ tags: parseTags(e.target.value) }));
  $('#edDate').addEventListener('change', e => queueSave({ date: e.target.value || null }, 0));
  $('#edTitle').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); $('#edBody').focus(); }
  });
}

function renderAll() {
  renderSidebar();
  renderList();
  renderDetail();
}

/* ---------- Saving ---------- */

let saveTimer = null;
let pending = null; // { id, fields }

function setStatus(text) {
  const el = $('#saveStatus');
  if (el) el.textContent = text;
}

function queueSave(fields, delay = 450) {
  const id = state.selectedId;
  if (pending && pending.id !== id) flushSave();
  pending = pending || { id, fields: {} };
  Object.assign(pending.fields, fields);
  // Keep local state in step so the list updates while typing.
  const it = current();
  if (it) Object.assign(it, fields);
  setStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}

async function flushSave(opts = {}) {
  clearTimeout(saveTimer);
  if (!pending) return;
  const { id, fields } = pending;
  pending = null;
  try {
    const saved = await api('PATCH', `/api/items/${id}`, fields, opts);
    // Don't clobber text typed while the request was in flight.
    const local = state.items.find(i => i.id === id);
    if (local && pending && pending.id === id) Object.assign(saved, pending.fields);
    if (local) replaceItem(saved);
    setStatus('Saved');
    renderSidebar();
    renderList();
  } catch (err) {
    setStatus('Couldn\'t save: ' + err.message);
    toast('Save failed. Is FocusMe still running?');
  }
}

/* ---------- Actions ---------- */

async function finishEditing() {
  if (!state.editing) return;
  await flushSave();
  state.editing = false;
  const it = current();
  if (it && !it.title.trim() && !it.body.trim()) {
    // Nothing was written, so don't leave an empty item behind.
    await api('DELETE', `/api/items/${it.id}`).catch(() => {});
    state.items = state.items.filter(i => i.id !== it.id);
    state.selectedId = null;
  }
  renderAll();
}

async function select(id) {
  if (id === state.selectedId && !state.editing) return;
  await finishEditing();
  state.selectedId = id;
  renderList();
  renderDetail();
  const li = $(`.item[data-id="${id}"]`);
  if (li) li.scrollIntoView({ block: 'nearest' });
}

function move(delta) {
  const items = visibleItems();
  if (!items.length) return;
  const idx = items.findIndex(i => i.id === state.selectedId);
  const next = idx === -1 ? (delta > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, idx + delta));
  select(items[next].id);
}

async function newItem() {
  await finishEditing();
  if (state.view === 'upcoming' || state.view === 'archive') state.view = 'all';
  const body = { title: '' };
  if (state.view === 'tag') body.tags = [state.tag];
  if (state.view === 'pinned') body.pinned = true;
  state.q = '';
  $('#search').value = '';
  try {
    const it = await api('POST', '/api/items', body);
    state.items.unshift(it);
    state.selectedId = it.id;
    state.editing = true;
    renderAll();
    $('#edTitle').focus();
  } catch (err) {
    toast('Couldn\'t create it: ' + err.message);
  }
}

function startEditing(focus = 'edBody') {
  if (!current()) return;
  state.editing = true;
  renderDetail();
  const el = document.getElementById(focus);
  el.focus();
  if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length);
}

async function patchCurrent(fields, message) {
  const it = current();
  if (!it) return;
  try {
    replaceItem(await api('PATCH', `/api/items/${it.id}`, fields));
    if (message) toast(message);
    renderAll();
  } catch (err) {
    toast('Couldn\'t update it: ' + err.message);
  }
}

async function deleteCurrent() {
  const it = current();
  if (!it) return;
  if (!confirm(`Delete "${it.title.trim() || 'Untitled'}"? This can't be undone.\n\nTip: Archive hides it but keeps it searchable.`)) return;
  const items = visibleItems();
  const idx = items.findIndex(i => i.id === it.id);
  try {
    await api('DELETE', `/api/items/${it.id}`);
  } catch (err) {
    toast('Couldn\'t delete it: ' + err.message);
    return;
  }
  state.items = state.items.filter(i => i.id !== it.id);
  const rest = items.filter(i => i.id !== it.id);
  state.selectedId = rest.length && window.innerWidth > 760 ? rest[Math.min(idx, rest.length - 1)].id : null;
  state.editing = false;
  renderAll();
  toast('Deleted');
}

function setView(view, tag = null) {
  finishEditing().then(() => {
    state.view = view;
    state.tag = tag;
    if (current() && !visibleItems().some(i => i.id === state.selectedId)) state.selectedId = null;
    renderAll();
  });
}

function focusSearch() {
  const s = $('#search');
  s.focus();
  s.select();
}

async function reload() {
  try {
    state.items = await api('GET', '/api/items');
  } catch (err) {
    toast('Couldn\'t reach FocusMe. Is it still running?');
    return;
  }
  if (state.selectedId && !current()) { state.selectedId = null; state.editing = false; }
  renderSidebar();
  renderList();
  if (!state.editing) renderDetail();
}

/* ---------- Events ---------- */

$('#views').addEventListener('click', e => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

$('#tags').addEventListener('click', e => {
  const b = e.target.closest('[data-tag]');
  if (b) setView('tag', b.dataset.tag);
});

$('#list').addEventListener('click', e => {
  const li = e.target.closest('.item');
  if (li) select(Number(li.dataset.id));
});

$('#listHead').addEventListener('click', e => {
  if (e.target.closest('[data-act="search-all"]')) setView('all');
});

$('#search').addEventListener('input', e => {
  state.q = e.target.value.trim();
  renderList();
});

$('#newBtn').addEventListener('click', newItem);

$('#detail').addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open) { select(Number(open.dataset.open)); return; }

  const code = e.target.closest('.md code');
  if (code && !code.closest('pre')) {
    navigator.clipboard.writeText(code.textContent).then(() => toast('Copied'), () => {});
    return;
  }

  const b = e.target.closest('[data-act]');
  if (!b) return;
  const it = current();
  switch (b.dataset.act) {
    case 'edit': startEditing(); break;
    case 'done': finishEditing(); break;
    case 'pin': patchCurrent({ pinned: !it.pinned }, it.pinned ? 'Unpinned' : 'Pinned'); break;
    case 'archive': patchCurrent({ archived: !it.archived }, it.archived ? 'Restored' : 'Archived. It\'s still in search under Archive.'); break;
    case 'delete': deleteCurrent(); break;
    case 'clear-date': $('#edDate').value = ''; queueSave({ date: null }, 0); break;
    case 'back': finishEditing().then(() => { state.selectedId = null; renderAll(); }); break;
  }
});

$('#detail').addEventListener('dblclick', e => {
  if (!state.editing && e.target.closest('.doc') && !e.target.closest('a, code')) startEditing();
});

document.addEventListener('keydown', e => {
  const t = e.target;
  const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
  if (mod && (e.key === 'Enter' || e.key.toLowerCase() === 's')) {
    e.preventDefault();
    if (state.editing) finishEditing();
    return;
  }
  if (e.key === 'Escape') {
    if (state.editing) { e.preventDefault(); finishEditing(); return; }
    if (t.id === 'search') {
      if (t.value) { t.value = ''; state.q = ''; renderList(); } else t.blur();
      return;
    }
    if (state.selectedId && window.innerWidth <= 760) { state.selectedId = null; renderAll(); }
    return;
  }
  if (typing) {
    if (t.id === 'search' && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault();
      const first = visibleItems()[0];
      if (first) { t.blur(); select(first.id); }
    }
    return;
  }
  if (mod || e.altKey) return;

  switch (e.key) {
    case '/': e.preventDefault(); focusSearch(); break;
    case 'n': case 'N': e.preventDefault(); newItem(); break;
    case 'e': case 'E': case 'Enter': if (current()) { e.preventDefault(); startEditing(); } break;
    case 'p': case 'P': if (current()) patchCurrent({ pinned: !current().pinned }, current().pinned ? 'Unpinned' : 'Pinned'); break;
    case 'j': case 'ArrowDown': e.preventDefault(); move(1); break;
    case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break;
  }
});

// Save anything half-typed if the tab is closed or hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushSave({ keepalive: true });
});
window.addEventListener('beforeunload', () => flushSave({ keepalive: true }));

// Pick up changes made in another tab when you come back to this one.
window.addEventListener('focus', () => { if (!state.editing) reload(); });

$('#exportBtn').addEventListener('click', () => { window.location.href = '/api/export'; });
$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const res = await api('POST', '/api/import', { items: Array.isArray(data) ? data : data.items });
    await reload();
    toast(res.added ? `Imported ${res.added} ${res.added === 1 ? 'item' : 'items'}` : 'Nothing new in that file');
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
});

/* ---------- Start ---------- */

(async function start() {
  const mac = /Mac/.test(navigator.platform);
  $('#search').placeholder = `Search everything   ( / or ${mac ? '⌘' : 'Ctrl+'}K )`;
  await reload();
  api('GET', '/api/info').then(info => {
    $('#dataPath').textContent = info.data;
    $('#dataPath').title = 'Where your data is saved';
  }).catch(() => {});
})();
