'use strict';

const state = {
  authed: false,
  mode: window.innerWidth <= 900 ? 'mobile' : 'desktop',
  notes: [],
  currentId: null,
  dirty: false,
  theme: localStorage.getItem('theme') || 'light',
  dbKey: 'cloud-notes-local-cache',
  driveReady: false
};

const $ = id => document.getElementById(id);

function toast(msg, ms = 1800) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setTheme(theme) {
  state.theme = theme;
  document.body.dataset.theme = theme;
  localStorage.setItem('theme', theme);
}

function loadLocalCache() {
  try {
    const raw = localStorage.getItem(state.dbKey);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalCache() {
  localStorage.setItem(state.dbKey, JSON.stringify(state.notes));
}

function ensureNoteShape(note) {
  return {
    id: note.id || crypto.randomUUID(),
    title: note.title || 'Untitled',
    content: note.content || '',
    modified: note.modified || Date.now(),
    tags: Array.isArray(note.tags) ? note.tags : [],
    imageRoot: note.imageRoot || '~/image'
  };
}

function initLocalNotes() {
  const cached = loadLocalCache();
  state.notes = cached.length ? cached.map(ensureNoteShape) : [ensureNoteShape({ title: 'Welcome', content: '這是一個可部署到 GitHub 的雲端筆記骨架。' })];
  state.currentId = state.notes[0].id;
  renderList();
  renderCurrent();
}

function currentNote() {
  return state.notes.find(n => n.id === state.currentId);
}

function renderList(filter = '') {
  const box = $('noteList');
  const q = filter.trim().toLowerCase();
  box.innerHTML = '';

  state.notes
    .filter(n => !q || n.title.toLowerCase().includes(q) || stripHtml(n.content).toLowerCase().includes(q))
    .sort((a, b) => (b.modified || 0) - (a.modified || 0))
    .forEach(n => {
      const item = document.createElement('div');
      item.className = 'note-item' + (n.id === state.currentId ? ' active' : '');
      item.innerHTML = `
        <div class="name">${escapeHtml(n.title)}</div>
        <div class="subtext">${new Date(n.modified).toLocaleString('zh-TW')}</div>
      `;
      item.addEventListener('click', () => {
        state.currentId = n.id;
        renderList($('search').value);
        renderCurrent();
      });
      box.appendChild(item);
    });
}

function renderCurrent() {
  const note = currentNote();
  if (!note) return;

  $('noteTitle').value = note.title;
  $('editor').innerHTML = note.content;
  $('wordCount').textContent = `${countWords(stripHtml(note.content))} 字`;
  $('saveState').textContent = state.dirty ? '未儲存' : '已載入';
  $('status').textContent = state.authed
    ? (state.mode === 'mobile' ? '已登入，手機預設只讀' : '已登入，可編輯')
    : '尚未登入';
  applyModeRules();
}

function applyModeRules() {
  const readOnly = state.mode === 'mobile';
  $('editor').contentEditable = readOnly ? 'false' : 'true';
  $('noteTitle').readOnly = readOnly;
  document.querySelectorAll('.tool').forEach(btn => btn.disabled = readOnly);
  $('btnSave').disabled = readOnly;
  $('btnNew').disabled = readOnly;
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function markDirty() {
  state.dirty = true;
  $('saveState').textContent = '未儲存';
}

function serializeNotes() {
  return JSON.stringify({
    updatedAt: Date.now(),
    notes: state.notes
  }, null, 2);
}

async function manualSave() {
  if (!state.authed) {
    saveLocalCache();
    toast('已存到本機快取');
    state.dirty = false;
    $('saveState').textContent = '已儲存';
    return;
  }

  const note = currentNote();
  if (!note) return;

  note.title = $('noteTitle').value.trim() || 'Untitled';
  note.content = $('editor').innerHTML;
  note.modified = Date.now();

  saveLocalCache();

  if (!state.driveReady) {
    toast('雲端未連線，已先存本機');
    state.dirty = false;
    $('saveState').textContent = '已儲存';
    return;
  }

  // 這裡只在按下儲存時才呼叫 Drive API
  // 實作方式可接 OAuth token 後呼叫 Google Drive Files API
  // 目前保留架構，不自動請求任何 API
  toast('已儲存');
  state.dirty = false;
  $('saveState').textContent = '已儲存';
  renderList($('search').value);
}

function newNote() {
  if (state.mode === 'mobile') return toast('手機模式僅可搜尋');
  const note = ensureNoteShape({
    title: 'New Note',
    content: ''
  });
  state.notes.unshift(note);
  state.currentId = note.id;
  state.dirty = true;
  saveLocalCache();
  renderList($('search').value);
  renderCurrent();
  toast('已新增筆記');
}

function insertBlock(type) {
  if (state.mode === 'mobile') return;
  const ed = $('editor');
  ed.focus();

  if (type === 'hr') {
    document.execCommand('insertHTML', false, '<hr>');
    markDirty();
    return;
  }

  if (type === 'todo') {
    document.execCommand('insertHTML', false, '<div class="todo"><input type="checkbox"> <span>待辦事項</span></div>');
    markDirty();
    return;
  }

  if (type === 'img') {
    const src = prompt('圖片相對路徑，例如 ~/image/a.png');
    if (!src) return;
    const path = normalizeImageSrc(src);
    document.execCommand('insertHTML', false, `<div class="image-wrap"><img src="${escapeHtml(path)}" alt="image"></div>`);
    markDirty();
    return;
  }

  if (type === 'link') {
    const url = prompt('URL');
    const text = prompt('顯示文字') || url;
    if (!url) return;
    document.execCommand('insertHTML', false, `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(text)}</a>`);
    markDirty();
    return;
  }

  if (type === 'quote') {
    document.execCommand('insertHTML', false, '<blockquote>引用文字</blockquote>');
    markDirty();
    return;
  }

  if (type === 'code') {
    document.execCommand('insertHTML', false, '<code>code</code>');
    markDirty();
    return;
  }

  if (type === 'h1' || type === 'h2' || type === 'h3') {
    document.execCommand('insertHTML', false, `<${type}>標題</${type}>`);
    markDirty();
    return;
  }

  document.execCommand('insertText', false, '');
}

function normalizeImageSrc(src) {
  let s = String(src || '').trim();
  if (s.startsWith('~')) return s;
  return `~/${s.replace(/^\/+/, '')}`;
}

function countLinksInHtml(html) {
  const m = String(html || '').match(/\[\[([^\]]+)\]\]/g);
  return m ? m.length : 0;
}

function updateSidebarStats() {
  const q = $('search').value.trim().toLowerCase();
  renderList(q);
}

function htmlToTextForSearch(html) {
  return stripHtml(html).replace(/\s+/g, ' ').trim();
}

function bindEvents() {
  $('btnTheme').addEventListener('click', () => {
    setTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  $('btnLogin').addEventListener('click', async () => {
    state.authed = true;
    state.driveReady = true;
    $('status').textContent = state.mode === 'mobile' ? '已登入，手機只讀' : '已登入，可編輯';
    toast('已完成登入（示意架構）');
  });

  $('btnLoad').addEventListener('click', async () => {
    // 只在明確按下時才載入
    state.notes = loadLocalCache().map(ensureNoteShape);
    if (!state.notes.length) initLocalNotes();
    renderList($('search').value);
    renderCurrent();
    toast('已載入資料');
  });

  $('btnSave').addEventListener('click', manualSave);
  $('btnNew').addEventListener('click', newNote);

  $('search').addEventListener('input', e => renderList(e.target.value));

  $('noteTitle').addEventListener('input', () => {
    const note = currentNote();
    if (!note) return;
    note.title = $('noteTitle').value;
    note.modified = Date.now();
    markDirty();
    renderList($('search').value);
  });

  $('editor').addEventListener('input', () => {
    const note = currentNote();
    if (!note) return;
    note.content = $('editor').innerHTML;
    note.modified = Date.now();
    $('wordCount').textContent = `${countWords(stripHtml(note.content))} 字`;
    $('saveState').textContent = '未儲存';
    state.dirty = true;
    renderList($('search').value);
  });

  $('editor').addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text/plain');
    if (text && text.includes('~/image/')) {
      e.preventDefault();
      document.execCommand('insertHTML', false, escapeHtml(text));
      markDirty();
    }
  });

  $('editor').addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
      markDirty();
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 保留原本筆記功能，但不自動觸發任何 API
      setTimeout(() => {
        $('wordCount').textContent = `${countWords(stripHtml($('editor').innerHTML))} 字`;
      }, 0);
    }
  });

  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'save') return manualSave();
      if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline') {
        document.execCommand(cmd, false, null);
        markDirty();
        return;
      }
      insertBlock(cmd);
    });
  });

  window.addEventListener('beforeunload', () => {
    if (state.dirty) saveLocalCache();
  });
}

function init() {
  setTheme(state.theme);
  bindEvents();
  initLocalNotes();

  if (window.innerWidth <= 900) {
    state.mode = 'mobile';
    applyModeRules();
    $('status').textContent = '手機模式：read only + 搜尋';
  } else {
    state.mode = 'desktop';
    applyModeRules();
  }
}
