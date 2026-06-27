'use strict';

const database = {};
const fileMeta = {};
const fileHandleMap = {};
const tagIndex = {};
let dirHandle = null;
let currentFileId = null;
let draggedIndex = null;
let saveTimer = null;
let noteTree = [];

const $ = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');
const uid = () => 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, duration = 2200) {
  const t = $('toast');
  t.textContent = msg;
  show(t);
  clearTimeout(t._timer);
  t._timer = setTimeout(() => hide(t), duration);
}

function escHtml(s='') {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function getName(id) {
  return (id || '').split('/').pop().replace(/\.json$/i, '');
}

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^~\/?/, '').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function relImagePath(p) {
  p = String(p || '').trim();
  if (!p) return p;
  if (p.startsWith('~')) return p;
  return `~/${normalizePath(p)}`;
}

function parseImagePath(path) {
  path = String(path || '').trim();
  if (path.startsWith('~/')) return path.slice(2);
  if (path.startsWith('~')) return path.slice(1).replace(/^\/+/, '');
  return path;
}

window.addEventListener('DOMContentLoaded', init);

async function init() {
  bindEvents();
  loadTheme();
  await tryRestoreHandle();
  renderEmptyUI();
}

function bindEvents() {
  $('btnOpenFolder').addEventListener('click', selectWorkspace);
  $('btnSave').addEventListener('click', saveCurrentNote);
  $('btnNewNote').addEventListener('click', createNewNotePrompt);
  $('btnNewNoteMobile').addEventListener('click', createNewNotePrompt);
  $('btnNewFolder').addEventListener('click', createNewFolderPrompt);
  $('btnRefresh').addEventListener('click', smartRefresh);
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnCommand').addEventListener('click', openCmdPalette);
  $('btnGraph').addEventListener('click', openGraphModal);
  $('btnDelete').addEventListener('click', deleteCurrentNote);
  $('btnExport').addEventListener('click', openExportModal);
  $('btnAddTag').addEventListener('click', promptAddTag);
  $('closeGraph').addEventListener('click', () => hide($('graphModal')));
  $('closeExport').addEventListener('click', () => hide($('exportModal')));
  $('cmdPalette').addEventListener('click', e => { if (e.target === $('cmdPalette')) closeCmdPalette(); });
  $('graphModal').addEventListener('click', e => { if (e.target === $('graphModal')) hide($('graphModal')); });
  $('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) hide($('exportModal')); });
  $('topSearch').addEventListener('input', e => handleSearch(e.target.value));
  $('topSearch').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value=''; handleSearch(''); }});
  $('cmdInput').addEventListener('input', filterCmdResults);
  $('cmdInput').addEventListener('keydown', handleCmdKeydown);
  $('cmdResults').addEventListener('click', e => {
    const item = e.target.closest('.cmd-item');
    if (item) runCmdAction(item.dataset.action);
  });
  document.addEventListener('keydown', handleGlobalShortcut);
  document.querySelectorAll('.panel-tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.panel-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const panelId = 'panel' + btn.dataset.panel.charAt(0).toUpperCase() + btn.dataset.panel.slice(1);
    document.querySelectorAll('.panel-content').forEach(p => p.classList.remove('active'));
    $(panelId)?.classList.add('active');
  }));
  document.querySelectorAll('.toolbar-btn').forEach(btn => btn.addEventListener('mousedown', e => {
    e.preventDefault();
    if (btn.dataset.format) document.execCommand(btn.dataset.format, false, null);
    else if (btn.dataset.cmd) applyBlockCommand(btn.dataset.cmd);
  }));
  $('exportMd').addEventListener('click', () => doExport('md'));
  $('exportJson').addEventListener('click', () => doExport('json'));
  $('exportTxt').addEventListener('click', () => doExport('txt'));
  $('exportCopy').addEventListener('click', () => doExport('copy'));
  $('btnSidebarToggle').addEventListener('click', () => toggleMobileDrawer(true));
  $('closeDrawer').addEventListener('click', () => toggleMobileDrawer(false));
  $('drawerMask').addEventListener('click', () => toggleMobileDrawer(false));
  $('searchResults').addEventListener('click', e => {
    const item = e.target.closest('.search-result-item');
    if (!item) return;
    switchNote(item.dataset.fileId);
    $('topSearch').value = '';
    handleSearch('');
  });
}

function handleGlobalShortcut(e) {
  const tag = document.activeElement?.tagName?.toLowerCase?.() || '';
  const inEditor = tag === 'div' && document.activeElement?.contentEditable === 'true';

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); openCmdPalette(); return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault(); saveCurrentNote(); return;
  }
  if (e.key === 'Escape') {
    closeCmdPalette(); hide($('graphModal')); hide($('exportModal')); toggleMobileDrawer(false); return;
  }
  if (!inEditor && !e.ctrlKey && !e.metaKey && e.key === '/') {
    e.preventDefault(); $('topSearch').focus(); return;
  }
}

function openCmdPalette() {
  show($('cmdPalette'));
  $('cmdInput').value = '';
  filterCmdResults();
  $('cmdInput').focus();
}
function closeCmdPalette() { hide($('cmdPalette')); $('cmdInput').value = ''; }

function filterCmdResults() {
  const q = $('cmdInput').value.trim().toLowerCase();
  document.querySelectorAll('.cmd-item').forEach(item => {
    if (!item.dataset.action) return;
    item.style.display = !q || item.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
  let notesSection = $('cmdNotes');
  if (!notesSection) {
    notesSection = document.createElement('div');
    notesSection.id = 'cmdNotes';
    $('cmdResults').appendChild(notesSection);
  }
  notesSection.innerHTML = '';
  if (!q) return;
  const matches = Object.keys(database).filter(fid => getName(fid).toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) return;
  const label = document.createElement('div');
  label.className = 'cmd-section-label';
  label.textContent = '筆記';
  notesSection.appendChild(label);
  matches.forEach(fid => {
    const item = document.createElement('div');
    item.className = 'cmd-item';
    item.dataset.action = '';
    item.innerHTML = `<span class="cmd-item-icon">📄</span>${getName(fid)}`;
    item.addEventListener('click', () => { closeCmdPalette(); switchNote(fid); });
    notesSection.appendChild(item);
  });
}

function handleCmdKeydown(e) {
  if (e.key === 'Escape') return closeCmdPalette();
  if (e.key === 'Enter') {
    const q = $('cmdInput').value.trim().toLowerCase();
    runCmdAction(q);
  }
}

function runCmdAction(action) {
  closeCmdPalette();
  if (action === 'new' || action === 'n') return createNewNotePrompt();
  if (action === 'open' || action === 'o') return selectWorkspace();
  if (action === 'save' || action === 's') return saveCurrentNote();
  if (action === 'theme' || action === 't') return toggleTheme();
  if (action === 'search') return $('topSearch').focus();
  if (action === 'graph' || action === 'g') return openGraphModal();
}

function loadTheme() {
  const saved = localStorage.getItem('rhizome-theme');
  if (saved) document.body.dataset.theme = saved;
}

function toggleTheme() {
  document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('rhizome-theme', document.body.dataset.theme);
}

async function selectWorkspace() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await storeHandle(dirHandle);
    await scanAndBuild();
    toast('工作區已連結');
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message || '無法開啟工作區');
  }
}

async function storeHandle(handle) {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve();
    const req = indexedDB.open('RhizomeNotesCloud', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('data');
    req.onsuccess = () => {
      const tx = req.result.transaction('data', 'readwrite');
      tx.objectStore('data').put(handle, 'rootHandle');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

async function tryRestoreHandle() {
  return new Promise(resolve => {
    if (!window.indexedDB) return resolve();
    const req = indexedDB.open('RhizomeNotesCloud', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('data');
    req.onsuccess = () => {
      const tx = req.result.transaction('data', 'readonly');
      const get = tx.objectStore('data').get('rootHandle');
      get.onsuccess = async () => {
        const h = get.result;
        if (!h) return resolve();
        try {
          if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') {
            dirHandle = h;
            await scanAndBuild();
          }
        } catch {}
        resolve();
      };
      get.onerror = () => resolve();
    };
    req.onerror = () => resolve();
  });
}

async function scanAndBuild() {
  if (!dirHandle) return renderEmptyUI();
  Object.keys(database).forEach(k => delete database[k]);
  Object.keys(fileMeta).forEach(k => delete fileMeta[k]);
  Object.keys(fileHandleMap).forEach(k => delete fileHandleMap[k]);
  Object.keys(tagIndex).forEach(k => delete tagIndex[k]);
  noteTree = await buildTree(dirHandle, '');
  renderTreeUI();
  $('syncStatus').textContent = '已連結';
  $('sidebarActions').classList.remove('hidden');
  $('drawerActions').style.display = '';
  const ids = Object.keys(database);
  if (ids.length) await switchNote(ids[0]);
  else renderEmptyUI();
}

async function buildTree(dirH, relPath) {
  const nodes = [];
  const SKIP = new Set(['.git','node_modules','.obsidian','.trash']);
  for await (const entry of dirH.values()) {
    if (entry.kind === 'directory') {
      if (SKIP.has(entry.name)) continue;
      nodes.push({ kind:'directory', name:entry.name, path:[relPath, entry.name].filter(Boolean).join('/'), children: await buildTree(entry, [relPath, entry.name].filter(Boolean).join('/')) });
    } else if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.json')) {
      try {
        const text = await (await entry.getFile()).text();
        const data = text ? JSON.parse(text) : {};
        const fileId = [relPath, entry.name].filter(Boolean).join('/');
        const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data) ? data : [{ id: uid(), content: '', indent: 0 }];
        const meta = data.meta || {};
        database[fileId] = blocks;
        fileMeta[fileId] = {
          created: meta.created || (await entry.getFile()).lastModified,
          modified: meta.modified || (await entry.getFile()).lastModified,
          tags: meta.tags || [],
          wordCount: 0
        };
        fileHandleMap[fileId] = entry;
        (meta.tags || []).forEach(tag => {
          tagIndex[tag] ||= new Set();
          tagIndex[tag].add(fileId);
        });
        nodes.push({ kind:'file', name:entry.name, fileId });
      } catch (e) {
        console.warn('read failed', entry.name, e);
      }
    }
  }
  nodes.sort((a,b) => a.kind === b.kind ? a.name.localeCompare(b.name,'zh-TW') : a.kind === 'directory' ? -1 : 1);
  return nodes;
}

function renderTreeUI() {
  const root = $('noteTree');
  const mobile = $('noteTreeMobile');
  root.innerHTML = mobile.innerHTML = '';
  if (!Object.keys(database).length) {
    const empty = `<li class="tree-empty"><div class="tree-empty-icon">📂</div><div>目前沒有筆記</div></li>`;
    root.innerHTML = mobile.innerHTML = empty;
    return;
  }
  const build = (nodes, parentEl, isMobile=false) => {
    nodes.forEach(n => {
      const li = document.createElement('li');
      if (n.kind === 'directory') {
        li.className = 'tree-folder';
        const dir = document.createElement('div');
        dir.className = 'tree-dir';
        dir.innerHTML = `📁 ${n.name}`;
        const ul = document.createElement('ul');
        ul.style.listStyle = 'none'; ul.style.paddingLeft = '14px';
        let collapsed = false;
        dir.addEventListener('click', () => { collapsed = !collapsed; ul.style.display = collapsed ? 'none' : ''; });
        li.appendChild(dir); li.appendChild(ul); parentEl.appendChild(li);
        build(n.children, ul, isMobile);
      } else {
        li.className = 'tree-item';
        const btn = document.createElement('button');
        btn.className = 'tree-file-btn' + (n.fileId === currentFileId ? ' active' : '');
        btn.textContent = getName(n.fileId);
        btn.addEventListener('click', () => {
          if (isMobile) toggleMobileDrawer(false);
          switchNote(n.fileId);
        });
        li.appendChild(btn);
        parentEl.appendChild(li);
      }
    });
  };
  build(noteTree, root, false);
  build(noteTree, mobile, true);
}

function renderEmptyUI() {
  hide($('blocksContainer'));
  hide($('noteHeader'));
  hide($('editorToolbar'));
  $('searchResults').classList.add('hidden');
}

async function switchNote(fileId) {
  currentFileId = fileId;
  $('noteTitle').textContent = getName(fileId);
  $('noteTitle').contentEditable = true;
  $('noteMeta').textContent = fileId;
  show($('blocksContainer'));
  show($('noteHeader'));
  show($('editorToolbar'));
  hide($('searchResults'));
  renderBlocks(database[fileId] || []);
  updateStats();
  updateOutline();
  updatePropsPanel();
  renderTags();
  computeAndShowBacklinks(fileId);
  renderTreeUI();
}

function renderBlocks(blocks) {
  const c = $('blocksContainer');
  c.innerHTML = '';
  if (!blocks || !blocks.length) blocks = database[currentFileId] = [{ id: uid(), content: '', indent: 0 }];
  blocks.forEach((block, index) => renderBlock(block, index, blocks, c));
}

function renderBlock(block, index, blocks, c) {
  const row = document.createElement('div');
  row.className = 'block-row';
  row.style.marginLeft = (block.indent || 0) + 'px';

  const drag = document.createElement('div');
  drag.className = 'block-drag';
  drag.textContent = '⠿';
  drag.draggable = true;
  drag.addEventListener('dragstart', e => { draggedIndex = index; e.dataTransfer.effectAllowed = 'move'; });
  drag.addEventListener('dragend', () => draggedIndex = null);

  const fold = document.createElement('div');
  fold.className = 'block-fold-toggle';
  fold.textContent = block.collapsed ? '▶' : '▼';
  fold.addEventListener('click', () => { block.collapsed = !block.collapsed; renderBlocks(blocks); saveCurrentNote(false); });

  const bullet = document.createElement('div');
  bullet.className = 'block-bullet';
  bullet.textContent = block.todo !== undefined ? '☐' : '•';
  bullet.addEventListener('click', () => {
    if (block.todo !== undefined) { block.todo = !block.todo; renderBlocks(blocks); saveCurrentNote(false); }
  });

  const editor = document.createElement('div');
  editor.className = 'block-editor';
  editor.contentEditable = true;
  editor.dataset.placeholder = index === 0 ? '開始輸入筆記...' : '輸入內容...';
  if (block.type === 'image') {
    editor.contentEditable = false;
    renderImageBlock(block, editor, blocks, index);
  } else if (block.todo !== undefined) {
    editor.contentEditable = false;
    renderTodoBlock(block, editor, blocks, index);
  } else {
    editor.innerHTML = inlineFormat(block.content || '');
    editor.addEventListener('input', () => {
      block.content = editor.innerHTML;
    });
    editor.addEventListener('keydown', e => handleBlockKeydown(e, block, index, blocks, c));
    editor.addEventListener('blur', () => saveCurrentNote(false));
    editor.addEventListener('paste', e => handlePaste(e, block, index, blocks));
  }

  row.appendChild(drag);
  row.appendChild(fold);
  row.appendChild(bullet);
  row.appendChild(editor);
  c.appendChild(row);
}

function inlineFormat(text) {
  if (!text) return '';
  let s = escHtml(text);
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<span class="wiki-link" data-target="$1">[[$1]]</span>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  return s.replace(/\n/g, '<br>');
}

function handleBlockKeydown(e, block, index, blocks, c) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const newBlock = { id: uid(), content: '', indent: block.indent || 0 };
    blocks.splice(index + 1, 0, newBlock);
    renderBlocks(blocks);
    focusBlock(index + 1);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    block.indent = Math.max(0, (block.indent || 0) + (e.shiftKey ? -24 : 24));
    renderBlocks(blocks);
    focusBlock(index);
    return;
  }
  if (e.key === 'Backspace') {
    const text = e.currentTarget.innerText.trim();
    if (!text && blocks.length > 1) {
      e.preventDefault();
      blocks.splice(index, 1);
      renderBlocks(blocks);
      focusBlock(Math.max(0, index - 1));
    }
  }
}

function focusBlock(index) {
  const row = $('blocksContainer').children[index];
  const ed = row?.querySelector('.block-editor,.todo-content');
  ed?.focus();
}

function renderTodoBlock(block, editor, blocks, index) {
  const wrap = document.createElement('div');
  wrap.className = 'todo-block';
  const box = document.createElement('div');
  box.className = 'todo-checkbox' + (block.todo ? ' checked' : '');
  box.textContent = block.todo ? '✓' : '';
  const content = document.createElement('div');
  content.className = 'todo-content';
  content.contentEditable = true;
  content.innerHTML = inlineFormat(block.content || '');
  content.addEventListener('input', () => block.content = content.innerHTML);
  content.addEventListener('keydown', e => handleBlockKeydown(e, block, index, blocks, $('blocksContainer')));
  content.addEventListener('blur', () => saveCurrentNote(false));
  box.addEventListener('click', () => { block.todo = !block.todo; renderBlocks(blocks); saveCurrentNote(false); });
  wrap.appendChild(box); wrap.appendChild(content); editor.appendChild(wrap);
}

function renderImageBlock(block, editor) {
  const wrap = document.createElement('div');
  wrap.className = 'image-block-wrap';
  const img = document.createElement('img');
  const src = block.src || block.content || '';
  const rel = parseImagePath(src);
  img.src = src.startsWith('~') ? src.replace(/^~/, '') : rel;
  img.alt = 'image';
  const ctrl = document.createElement('div');
  ctrl.className = 'image-controls';
  const slider = document.createElement('input');
  slider.type = 'range'; slider.min = 80; slider.max = 900; slider.value = block.width || 320;
  slider.addEventListener('input', () => { img.style.width = slider.value + 'px'; block.width = +slider.value; });
  const label = document.createElement('span');
  label.textContent = slider.value + ' px';
  slider.addEventListener('input', () => label.textContent = slider.value + ' px');
  ctrl.appendChild(slider); ctrl.appendChild(label);
  wrap.appendChild(img); wrap.appendChild(ctrl);
  editor.appendChild(wrap);
}

async function handlePaste(e, block, index, blocks) {
  const items = e.clipboardData?.items || [];
  for (const it of items) {
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      e.preventDefault();
      const file = it.getAsFile();
      if (!dirHandle) return toast('請先開啟工作區');
      const imgDir = await dirHandle.getDirectoryHandle('image', { create: true });
      const fileName = `img_${Date.now()}.png`;
      const fh = await imgDir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable();
      await w.write(file);
      await w.close();
      block.type = 'image';
      block.src = `~/image/${fileName}`;
      block.width = 320;
      renderBlocks(blocks);
      return;
    }
  }
  const rawText = e.clipboardData?.getData('text/plain') || '';
  if (rawText) {
    e.preventDefault();
    document.execCommand('insertText', false, rawText);
  }
}

async function saveCurrentNote(showToast = true) {
  if (!currentFileId) return;
  if (!dirHandle) return toast('尚未連結工作區');
  const fh = fileHandleMap[currentFileId];
  if (!fh) return toast('找不到檔案句柄');
  const payload = {
    meta: {
      ...(fileMeta[currentFileId] || {}),
      modified: Date.now(),
      tags: fileMeta[currentFileId]?.tags || []
    },
    blocks: database[currentFileId] || []
  };
  const w = await fh.createWritable();
  await w.write(JSON.stringify(payload, null, 2));
  await w.close();
  fileMeta[currentFileId].modified = payload.meta.modified;
  $('lastSaved').textContent = new Date(payload.meta.modified).toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit' });
  if (showToast) toast('已儲存');
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (currentFileId) saveCurrentNote(false);
  }, 800);
}

async function smartRefresh() {
  if (!dirHandle) return selectWorkspace();
  await scanAndBuild();
  toast('已重新整理');
}

async function createNewNotePrompt() {
  if (!dirHandle) return toast('請先開啟工作區');
  const name = prompt('筆記名稱');
  if (!name?.trim()) return;
  const fileName = name.trim().replace(/[\\/:*?"<>|]/g, '-') + '.json';
  const fh = await dirHandle.getFileHandle(fileName, { create: true });
  const initial = {
    meta: { created: Date.now(), modified: Date.now(), tags: [] },
    blocks: [{ id: uid(), content: '', indent: 0 }]
  };
  const w = await fh.createWritable();
  await w.write(JSON.stringify(initial, null, 2));
  await w.close();
  await scanAndBuild();
  await switchNote(Object.keys(database).find(k => k.endsWith('/' + fileName)) || fileName);
}

async function createNewFolderPrompt() {
  if (!dirHandle) return toast('請先開啟工作區');
  const name = prompt('資料夾名稱');
  if (!name?.trim()) return;
  await dirHandle.getDirectoryHandle(name.trim(), { create: true });
  await scanAndBuild();
}

async function deleteCurrentNote() {
  if (!currentFileId || !dirHandle) return;
  if (!confirm(`刪除 ${getName(currentFileId)} ?`)) return;
  const parts = currentFileId.split('/');
  const fileName = parts.pop();
  let parent = dirHandle;
  for (const p of parts) parent = await parent.getDirectoryHandle(p);
  await parent.removeEntry(fileName);
  await scanAndBuild();
  currentFileId = null;
  renderEmptyUI();
}

function handleSearch(query) {
  const sr = $('searchResults');
  if (!query.trim()) {
    hide(sr);
    if (currentFileId) { show($('blocksContainer')); show($('noteHeader')); }
    return;
  }
  show(sr);
  hide($('blocksContainer'));
  hide($('noteHeader'));
  sr.innerHTML = '';
  const q = query.toLowerCase();
  const results = [];
  Object.entries(database).forEach(([fid, blocks]) => {
    blocks.forEach((b, i) => {
      const t = (b.content || '').replace(/<[^>]+>/g, ' ');
      if (t.toLowerCase().includes(q)) results.push({ fid, text: t, index: i });
    });
  });
  const header = document.createElement('div');
  header.className = 'search-header';
  header.textContent = `${results.length} 筆結果`;
  sr.appendChild(header);
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'search-result-item';
    item.dataset.fileId = r.fid;
    item.innerHTML = `<div class="search-result-file">${getName(r.fid)}</div><div class="search-result-snippet">${escHtml(r.text.slice(0, 200))}</div>`;
    sr.appendChild(item);
  });
}

function updateStats() {
  if (!currentFileId) return;
  const blocks = database[currentFileId] || [];
  let words = 0;
  blocks.forEach(b => {
    const t = (b.content || '').replace(/<[^>]+>/g, ' ').trim();
    if (t) words += t.split(/\s+/).filter(Boolean).length;
  });
  $('wordCount').textContent = `${words} 字`;
  $('blockCount').textContent = `${blocks.length} 個區塊`;
  $('propWords').textContent = `${words}`;
  $('propBlocks').textContent = `${blocks.length}`;
  $('propModified').textContent = fileMeta[currentFileId]?.modified ? new Date(fileMeta[currentFileId].modified).toLocaleString('zh-TW') : '—';
  $('propCreated').textContent = fileMeta[currentFileId]?.created ? new Date(fileMeta[currentFileId].created).toLocaleString('zh-TW') : '—';
}

function updateOutline() {
  const list = $('outlineList');
  list.innerHTML = '';
  if (!currentFileId) return;
  const blocks = database[currentFileId] || [];
  let has = false;
  blocks.forEach((b, i) => {
    const m = String(b.content || '').match(/<h([1-3])>(.*?)<\/h\1>/i);
    if (m) {
      has = true;
      const item = document.createElement('div');
      item.className = 'outline-item';
      item.textContent = m[2].replace(/<[^>]+>/g, '');
      item.addEventListener('click', () => focusBlock(i));
      list.appendChild(item);
    }
  });
  if (!has) list.innerHTML = '<div class="outline-empty">此筆記無標題結構</div>';
}

function updatePropsPanel() {
  if (!currentFileId) return;
  const meta = fileMeta[currentFileId] || {};
  $('propCreated').textContent = meta.created ? new Date(meta.created).toLocaleString('zh-TW') : '—';
  $('propModified').textContent = meta.modified ? new Date(meta.modified).toLocaleString('zh-TW') : '—';
  $('propWords').textContent = $('wordCount').textContent.replace(' 字','');
  $('propBlocks').textContent = $('blockCount').textContent.replace(' 個區塊','');
  $('propLinks').textContent = countLinks(currentFileId);
}

function renderTags() {
  const list = $('tagsList');
  list.innerHTML = '';
  const tags = fileMeta[currentFileId]?.tags || [];
  tags.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = tag;
    chip.addEventListener('click', () => { $('topSearch').value = tag; handleSearch(tag); });
    list.appendChild(chip);
  });
}

function promptAddTag() {
  if (!currentFileId) return;
  const tag = prompt('標籤');
  if (!tag?.trim()) return;
  const clean = tag.trim();
  const meta = fileMeta[currentFileId];
  meta.tags ||= [];
  if (!meta.tags.includes(clean)) meta.tags.push(clean);
  renderTags();
  scheduleSave();
}

function computeAndShowBacklinks(fileId) {
  const panel = $('backlinksPanel');
  const list = $('backlinksList');
  list.innerHTML = '';
  const noteName = getName(fileId);
  const backlinks = [];
  Object.entries(database).forEach(([fid, blocks]) => {
    if (fid === fileId) return;
    if (blocks.some(b => String(b.content || '').includes(`[[${noteName}]]`) || String(b.content || '').includes(noteName))) backlinks.push(fid);
  });
  if (!backlinks.length) return hide(panel);
  show(panel);
  backlinks.forEach(fid => {
    const li = document.createElement('li');
    li.className = 'backlink-item';
    li.textContent = getName(fid);
    li.addEventListener('click', () => switchNote(fid));
    list.appendChild(li);
  });
}

function countLinks(fileId) {
  const blocks = database[fileId] || [];
  let n = 0;
  blocks.forEach(b => {
    const m = String(b.content || '').match(/\[\[([^\]]+)\]\]/g);
    if (m) n += m.length;
  });
  return n;
}

function openGraphModal() {
  show($('graphModal'));
  drawGraph();
}

function drawGraph() {
  const canvas = $('graphCanvas');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);

  const files = Object.keys(database);
  if (!files.length) return;
  const nodes = {};
  const cx = canvas.width/2, cy = canvas.height/2, r = Math.min(cx, cy) * 0.7;

  files.forEach((fid, i) => {
    const a = i / files.length * Math.PI * 2;
    nodes[fid] = { x: cx + r*Math.cos(a), y: cy + r*Math.sin(a), name: getName(fid), linkCount: 0 };
  });

  const links = [];
  files.forEach(fid => {
    (database[fid] || []).forEach(b => {
      const ms = String(b.content || '').match(/\[\[([^\]]+)\]\]/g) || [];
      ms.forEach(m => {
        const name = m.slice(2, -2);
        const target = files.find(f => getName(f) === name);
        if (target && target !== fid) {
          links.push([fid, target]);
          nodes[fid].linkCount++;
          nodes[target].linkCount++;
        }
      });
    });
  });

  ctx.strokeStyle = 'rgba(128,128,128,.35)';
  links.forEach(([a,b]) => {
    ctx.beginPath();
    ctx.moveTo(nodes[a].x, nodes[a].y);
    ctx.lineTo(nodes[b].x, nodes[b].y);
    ctx.stroke();
  });

  files.forEach(fid => {
    const n = nodes[fid];
    const rad = 6 + n.linkCount * 2;
    ctx.beginPath();
    ctx.arc(n.x, n.y, rad, 0, Math.PI*2);
    ctx.fillStyle = fid === currentFileId ? '#4f46e5' : '#9ca3af';
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(n.name, n.x, n.y - rad - 10);
  });

  canvas.onclick = e => {
    const r2 = canvas.getBoundingClientRect();
    const mx = e.clientX - r2.left, my = e.clientY - r2.top;
    for (const fid of files) {
      const n = nodes[fid];
      const rad = 6 + n.linkCount * 2;
      const dx = mx - n.x, dy = my - n.y;
      if (dx*dx + dy*dy <= rad*rad) {
        hide($('graphModal'));
        switchNote(fid);
        break;
      }
    }
  };
}

function openExportModal() {
  if (!currentFileId) return;
  show($('exportModal'));
  $('exportPreview').textContent = buildMarkdown().slice(0, 800);
}

function buildMarkdown() {
  if (!currentFileId) return '';
  const title = getName(currentFileId);
  const lines = [title, ''];
  (database[currentFileId] || []).forEach(b => {
    if (b.type === 'image') {
      lines.push(`![](${b.src || ''})`);
      return;
    }
    if (b.todo !== undefined) {
      lines.push(`- [${b.todo ? 'x' : ' '}] ${(b.content || '').replace(/<[^>]+>/g, '')}`);
      return;
    }
    const text = String(b.content || '').replace(/<[^>]+>/g, '').trim();
    if (text) lines.push(`${' '.repeat((b.indent || 0) / 24)}${text}`);
  });
  return lines.join('\n');
}

function doExport(format) {
  const title = getName(currentFileId);
  if (format === 'md') downloadFile(`${title}.md`, buildMarkdown(), 'text/markdown');
  else if (format === 'json') downloadFile(`${title}.json`, JSON.stringify({ meta: fileMeta[currentFileId], blocks: database[currentFileId] }, null, 2), 'application/json');
  else if (format === 'txt') downloadFile(`${title}.txt`, (database[currentFileId] || []).map(b => b.content).join('\n'), 'text/plain');
  else if (format === 'copy') navigator.clipboard.writeText(buildMarkdown()).then(() => toast('已複製'));
}

function downloadFile(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function toggleMobileDrawer(showIt) {
  const d = $('mobileDrawer');
  d.classList.toggle('hidden', !showIt);
}

async function createTreeFileHandle(dir, path) {
  const parts = normalizePath(path).split('/').filter(Boolean);
  let curr = dir;
  for (let i = 0; i < parts.length - 1; i++) curr = await curr.getDirectoryHandle(parts[i], { create: true });
  return await curr.getFileHandle(parts[parts.length - 1], { create: true });
}
