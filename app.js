'use strict';

const CLIENT_ID = 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID';
const SCOPES = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
const APP_FOLDER = 'CloudNotes';
const NOTES_FOLDER = 'notes';
const IMAGES_FOLDER = 'image';
const NOTES_MIME = 'application/json';

const state = {
  token: null,
  authed: false,
  mode: window.innerWidth <= 900 ? 'mobile' : 'desktop',
  notes: [],
  currentId: null,
  dirty: false,
  theme: localStorage.getItem('theme') || 'light',
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

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ');
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

function ensureNoteShape(note) {
  return {
    id: note.id || crypto.randomUUID(),
    title: note.title || 'Untitled',
    content: note.content || '',
    modified: note.modified || Date.now(),
    tags: Array.isArray(note.tags) ? note.tags : [],
    driveFileId: note.driveFileId || '',
    folderId: note.folderId || ''
  };
}

function currentNote() {
  return state.notes.find(n => n.id === state.currentId);
}

function loadLocalCache() {
  try {
    const raw = localStorage.getItem('cloud-notes-cache');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalCache() {
  localStorage.setItem('cloud-notes-cache', JSON.stringify(state.notes));
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
    ? (state.mode === 'mobile' ? '已登入，手機只讀' : '已登入，可編輯')
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

function markDirty() {
  state.dirty = true;
  $('saveState').textContent = '未儲存';
}

function normalizeImageSrc(src) {
  let s = String(src || '').trim();
  if (!s) return s;
  if (s.startsWith('~')) return s;
  return `~/${s.replace(/^\/+/, '')}`;
}

function insertBlock(type) {
  if (state.mode === 'mobile') return toast('手機模式僅可搜尋');
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
}

async function loadGoogleApi() {
  if (!window.gapi) throw new Error('gapi not loaded');
  await gapi.load('client', async () => {
    await gapi.client.init({
      apiKey: '',
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest']
    });
  });
}

async function getToken() {
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error('GIS not loaded'));
    const tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: tokenResponse => {
        if (tokenResponse.error) return reject(tokenResponse);
        state.token = tokenResponse.access_token;
        gapi.client.setToken({ access_token: state.token });
        state.authed = true;
        resolve(tokenResponse.access_token);
      }
    });
    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

async function driveFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${state.token}`);
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) throw new Error(await res.text());
  return res;
}

async function findFolder(name, parentId = 'root') {
  const q = [
    `mimeType='application/vnd.google-apps.folder'`,
    `name='${name.replace(/'/g, "\\'")}'`,
    `'${parentId}' in parents`,
    `trashed=false`
  ].join(' and ');
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
  const data = await r.json();
  return data.files?.[0]?.id || '';
}

async function createFolder(name, parentId = 'root') {
  const body = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: [parentId]
  };
  const r = await driveFetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return await r.json();
}

async function ensureAppStructure() {
  let appId = await findFolder(APP_FOLDER, 'root');
  if (!appId) appId = (await createFolder(APP_FOLDER, 'root')).id;

  let notesId = await findFolder(NOTES_FOLDER, appId);
  if (!notesId) notesId = (await createFolder(NOTES_FOLDER, appId)).id;

  let imagesId = await findFolder(IMAGES_FOLDER, appId);
  if (!imagesId) imagesId = (await createFolder(IMAGES_FOLDER, appId)).id;

  state.driveReady = true;
  return { appId, notesId, imagesId };
}

async function listDriveNotes(notesFolderId) {
  const q = [
    `'${notesFolderId}' in parents`,
    `trashed=false`,
    `mimeType='${NOTES_MIME}'`
  ].join(' and ');
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,createdTime,parents)&pageSize=1000`;
  const r = await driveFetch(url);
  const data = await r.json();
  return data.files || [];
}

async function downloadDriveFile(fileId) {
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
  return await r.text();
}

async function createJsonFile(folderId, name, jsonText) {
  const metadata = new Blob([JSON.stringify({
    name,
    mimeType: NOTES_MIME,
    parents: [folderId]
  })], { type: 'application/json' });

  const file = new Blob([jsonText], { type: 'application/json' });

  const form = new FormData();
  form.append('metadata', metadata);
  form.append('file', file);

  const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
    method: 'POST',
    body: form
  });
  return await r.json();
}

async function updateJsonFile(fileId, jsonText) {
  const r = await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name`, {
    method: 'PATCH',
    body: jsonText,
    headers: { 'Content-Type': 'application/json' }
  });
  return await r.json();
}

async function deleteDriveFile(fileId) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
}

async function renameDriveFile(fileId, newName) {
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
    method: 'PATCH',
    body: JSON.stringify({ name: newName })
  });
  return await r.json();
}

function getImageUrl(path) {
  const s = String(path || '').trim();
  if (s.startsWith('~/image/')) return s;
  if (s.startsWith('~')) return s;
  return `~/${s}`;
}

function renderDriveLinks() {
  // 用前端資料結構處理，不自動偷打 API
}

async function loadFromDrive() {
  const { notesId } = await ensureAppStructure();
  const files = await listDriveNotes(notesId);
  const loaded = [];

  for (const f of files) {
    try {
      const text = await downloadDriveFile(f.id);
      const obj = JSON.parse(text);
      loaded.push(ensureNoteShape({
        id: obj.id || crypto.randomUUID(),
        title: obj.title || f.name.replace(/\.json$/i, ''),
        content: obj.content || '',
        modified: obj.modified || Date.now(),
        tags: obj.tags || [],
        driveFileId: f.id,
        folderId: notesId
      }));
    } catch (e) {
      console.warn('skip file', f.name, e);
    }
  }

  state.notes = loaded.length ? loaded : [ensureNoteShape({ title: 'Welcome', content: '按「新增筆記」開始。', folderId: notesId })];
  state.currentId = state.notes[0].id;
  state.dirty = false;
  saveLocalCache();
  renderList($('search').value);
  renderCurrent();
  toast('已從 Google Drive 載入');
}

async function saveCurrentNote() {
  if (state.mode === 'mobile') return toast('手機模式僅可搜尋');

  const note = currentNote();
  if (!note) return;

  note.title = $('noteTitle').value.trim() || 'Untitled';
  note.content = $('editor').innerHTML;
  note.modified = Date.now();

  saveLocalCache();

  if (!state.authed) {
    toast('未登入，已存本機快取');
    state.dirty = false;
    $('saveState').textContent = '已儲存';
    return;
  }

  const { notesId } = await ensureAppStructure();
  const payload = JSON.stringify({
    id: note.id,
    title: note.title,
    content: note.content,
    modified: note.modified,
    tags: note.tags
  }, null, 2);

  if (note.driveFileId) {
    await updateJsonFile(note.driveFileId, payload);
  } else {
    const created = await createJsonFile(notesId, `${note.title}.json`, payload);
    note.driveFileId = created.id;
  }

  state.dirty = false;
  $('saveState').textContent = '已儲存';
  renderList($('search').value);
  toast('已儲存到 Google Drive');
}

function newNote() {
  if (state.mode === 'mobile') return toast('手機模式僅可搜尋');
  const note = ensureNoteShape({
    title: 'New Note',
    content: '',
    modified: Date.now(),
    tags: []
  });
  state.notes.unshift(note);
  state.currentId = note.id;
  state.dirty = true;
  saveLocalCache();
  renderList($('search').value);
  renderCurrent();
  toast('已新增筆記');
}

function bindEvents() {
  $('btnTheme').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));

  $('btnLogin').addEventListener('click', async () => {
    try {
      await loadGoogleApi();
      await getToken();
      $('status').textContent = state.mode === 'mobile' ? '已登入，手機只讀' : '已登入，可編輯';
      toast('Google 登入成功');
    } catch (e) {
      console.error(e);
      toast('登入失敗');
    }
  });

  $('btnLoad').addEventListener('click', async () => {
    if (!state.authed) return toast('請先登入 Google');
    try {
      await loadFromDrive();
    } catch (e) {
      console.error(e);
      toast('載入失敗');
    }
  });

  $('btnSave').addEventListener('click', async () => {
    try {
      await saveCurrentNote();
    } catch (e) {
      console.error(e);
      toast('儲存失敗');
    }
  });

  $('btnNew').addEventListener('click', newNote);
  $('search').addEventListener('input', e => renderList(e.target.value));

  $('noteTitle').addEventListener('input', () => {
    const note = currentNote();
    if (!note) return;
    note.title = $('noteTitle').value;
    note.modified = Date.now();
    state.dirty = true;
    $('saveState').textContent = '未儲存';
    renderList($('search').value);
  });

  $('editor').addEventListener('input', () => {
    const note = currentNote();
    if (!note) return;
    note.content = $('editor').innerHTML;
    note.modified = Date.now();
    $('wordCount').textContent = `${countWords(stripHtml(note.content))} 字`;
    state.dirty = true;
    $('saveState').textContent = '未儲存';
    renderList($('search').value);
  });

  $('editor').addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertHTML', false, '&nbsp;&nbsp;&nbsp;&nbsp;');
      state.dirty = true;
    }
  });

  $('editor').addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text/plain') || '';
    if (text.startsWith('~/image/')) {
      e.preventDefault();
      document.execCommand('insertHTML', false, `<div class="image-wrap"><img src="${escapeHtml(text)}" alt="image"></div>`);
      state.dirty = true;
    }
  });

  document.querySelectorAll('.tool').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      if (cmd === 'save') return saveCurrentNote();
      if (cmd === 'bold' || cmd === 'italic' || cmd === 'underline') {
        document.execCommand(cmd, false, null);
        state.dirty = true;
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
  state.notes = loadLocalCache().map(ensureNoteShape);
  if (!state.notes.length) {
    state.notes = [ensureNoteShape({ title: 'Welcome', content: '先按 Google 登入，再按載入雲端。' })];
  }
  state.currentId = state.notes[0].id;
  renderList();
  renderCurrent();

  if (window.innerWidth <= 900) {
    state.mode = 'mobile';
    applyModeRules();
    $('status').textContent = '手機模式：read only + 搜尋';
  }
}

init();
