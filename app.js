/* =========================================================
   Rhizome Notes v5.0 — Cloud Edition
   完整移植本地版所有功能，儲存層替換為 Google Drive API
   圖片維持上傳至 Drive image/ 資料夾（driveFileId 參照）
   ========================================================= */

'use strict';

// ─── Google OAuth 設定 ───────────────────────────────────
const CLIENT_ID = '249300683470-vtgnnd73jvhe1ku7ckoftasrn8tesmfe.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILENAME = 'rhizome_notes_data.json';

let tokenClient;
let gapiInited = false;
let gsiInited = false;
let accessToken = null;
let driveDataFileId = null;   // 主資料 JSON 的 Drive fileId
let driveImageFolderId = null; // image/ 資料夾的 Drive fileId

// ─── App State（與本地版完全對應）────────────────────────
let database = {};       // noteId → blocks[]
let fileMeta = {};       // noteId → { created, modified, tags, wordCount }
let tagIndex = {};       // tag → Set<noteId>
let currentFileId = null;
let draggedIndex = null;
let saveTimer = null;
let noteTree = [];       // 目錄樹（雲端版為平坦結構）

// ─── 手機 read-only 偵測 ─────────────────────────────────
const IS_MOBILE = ('ontouchstart' in window) && window.screen.width < 768;

// ─── Helpers ─────────────────────────────────────────────
const uid = (p = 'b') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, duration = 2500) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(t._timer);
    t._timer = setTimeout(() => hide(t), duration);
}

function deleteBlockAndChildren(index, blocks) {
    const parentIndent = blocks[index].indent || 0;
    let countToDelete = 1;
    while (index + countToDelete < blocks.length && (blocks[index + countToDelete].indent || 0) > parentIndent) {
        countToDelete++;
    }
    blocks.splice(index, countToDelete);
    if (blocks.length === 0) blocks.push({ id: uid(), content: '', indent: 0 });
}

// ─── Google SDK 初始化 ────────────────────────────────────
window.onload = function () {
    gapiLoad();
    gsiLoad();
    initUI();
    loadTheme();
};

function gapiLoad() {
    gapi.load('client', async () => {
        await gapi.client.init({});
        await gapi.client.load('drive', 'v3');
        gapiInited = true;
        checkSDKReady();
    });
}

function gsiLoad() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: handleAuthResponse,
    });
    gsiInited = true;
    checkSDKReady();
}

function checkSDKReady() {
    if (gapiInited && gsiInited) {
        // SDK 就緒，靜默完成，不跳 toast
    }
}

// ─── Auth ─────────────────────────────────────────────────
function handleAuthClick() {
    if (!tokenClient) { toast('⚠️ Google SDK 尚未就緒，請重新整理'); return; }
    tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function handleAuthResponse(response) {
    if (response.error) { toast(`授權失敗: ${response.error}`); return; }
    accessToken = response.access_token;
    toast('☁️ 登入成功，正在載入資料…');

    $('btnOpenFolder').innerHTML = '☁️ 雲端已連結';
    $('btnOpenFolder').style.cssText = 'background:#15803d;color:white;border-color:#15803d';
    $('syncStatus').textContent = '● 已連線';
    $('syncStatus').style.background = '#15803d';
    show($('sidebarActions'));
    show($('btnLogout'));
    if ($('drawerActions')) $('drawerActions').style.display = '';

    await syncWithGoogleDrive();
}

function handleLogoutClick() {
    if (!accessToken) return;
    google.accounts.oauth2.revokeToken(accessToken);
    accessToken = null; driveDataFileId = null; driveImageFolderId = null;
    database = {}; fileMeta = {}; tagIndex = {};
    currentFileId = null; noteTree = [];

    $('btnOpenFolder').innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> 連結 Google 雲端`;
    $('btnOpenFolder').style.cssText = '';
    $('syncStatus').textContent = '未連結';
    $('syncStatus').style.background = '';
    hide($('sidebarActions'));
    hide($('btnLogout'));
    hide($('noteHeader'));
    hide($('blocksContainer'));
    hide($('editorToolbar'));
    renderTreeUI([]);
    toast('已安全登出');
}

// ─── Google Drive 同步主邏輯 ──────────────────────────────
async function syncWithGoogleDrive() {
    try {
        // 搜尋主資料 JSON
        const res = await gapi.client.drive.files.list({
            q: `name='${BACKUP_FILENAME}' and trashed=false`,
            fields: 'files(id,name)',
            spaces: 'drive'
        });
        const files = res.result.files || [];
        if (files.length > 0) {
            driveDataFileId = files[0].id;
            await downloadNotesFromDrive();
        } else {
            toast('首次使用，建立雲端筆記庫…');
            await createInitialDriveFile();
        }
        // 確保 image/ 資料夾存在
        await ensureImageFolder();
    } catch (err) {
        console.error('[Rhizome] syncWithGoogleDrive error', err);
        toast('⚠️ 雲端同步失敗，請重試');
    }
}

async function downloadNotesFromDrive() {
    try {
        const res = await gapi.client.drive.files.get({
            fileId: driveDataFileId,
            alt: 'media'
        });
        if (res.result) {
            const data = res.result;
            database = data.database || {};
            fileMeta = data.fileMeta || {};

            // 重建 tagIndex
            tagIndex = {};
            Object.entries(fileMeta).forEach(([fid, meta]) => {
                (meta.tags || []).forEach(tag => {
                    if (!tagIndex[tag]) tagIndex[tag] = new Set();
                    tagIndex[tag].add(fid);
                });
            });

            noteTree = buildCloudTree();
            renderTreeUI(noteTree);

            const ids = Object.keys(database);
            if (ids.length) switchNote(ids[0]);
            toast(`✅ 已載入 ${ids.length} 篇筆記`);
        }
    } catch (err) {
        console.error('[Rhizome] downloadNotes error', err);
        toast('⚠️ 下載資料失敗');
    }
}

async function uploadNotesToDrive() {
    if (!driveDataFileId || !accessToken) return;
    $('lastSaved').textContent = '同步中…';
    try {
        const payload = JSON.stringify({ database, fileMeta }, null, 2);
        await fetch(`https://www.googleapis.com/upload/drive/v3/files/${driveDataFileId}?uploadType=media`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: payload
        });
        const now = new Date();
        $('lastSaved').textContent = '已同步 ' + now.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
        console.error('[Rhizome] uploadNotes error', err);
        $('lastSaved').textContent = '⚠️ 同步失敗';
    }
}

async function createInitialDriveFile() {
    const welcomeId = 'note_welcome';
    database[welcomeId] = [
        { id: uid(), content: '<h1>歡迎使用 Rhizome Notes 雲端版</h1>', indent: 0 },
        { id: uid(), content: '這是專屬於你的數位筆記大腦，資料安全儲存於 Google Drive。', indent: 0 },
        { id: uid(), content: '使用 <strong>Enter</strong> 新增區塊，<strong>Tab</strong> 縮排，<strong>[[筆記名]]</strong> 建立連結。', indent: 0 }
    ];
    fileMeta[welcomeId] = { created: Date.now(), modified: Date.now(), tags: [], wordCount: 0, title: '歡迎使用' };

    try {
        // 建立空檔案取得 fileId
        const createRes = await gapi.client.drive.files.create({
            resource: { name: BACKUP_FILENAME, mimeType: 'application/json' },
            fields: 'id'
        });
        driveDataFileId = createRes.result.id;
        await uploadNotesToDrive();
        noteTree = buildCloudTree();
        renderTreeUI(noteTree);
        switchNote(welcomeId);
    } catch (err) {
        console.error('[Rhizome] createInitialFile error', err);
    }
}

// ─── Drive image/ 資料夾管理 ──────────────────────────────
async function ensureImageFolder() {
    try {
        const res = await gapi.client.drive.files.list({
            q: `name='image' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id,name)',
            spaces: 'drive'
        });
        const folders = res.result.files || [];
        if (folders.length > 0) {
            driveImageFolderId = folders[0].id;
        } else {
            const cr = await gapi.client.drive.files.create({
                resource: { name: 'image', mimeType: 'application/vnd.google-apps.folder' },
                fields: 'id'
            });
            driveImageFolderId = cr.result.id;
        }
    } catch (err) {
        console.error('[Rhizome] ensureImageFolder error', err);
    }
}

// 上傳圖片 Blob 至 Drive image/ 資料夾，回傳 driveFileId
async function uploadImageToDrive(file) {
    if (!driveImageFolderId) await ensureImageFolder();
    if (!driveImageFolderId) throw new Error('image 資料夾不存在');

    const imgName = `img_${Date.now()}.png`;
    const metadata = { name: imgName, parents: [driveImageFolderId] };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', file);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}` },
        body: form
    });
    const data = await res.json();
    if (!data.id) throw new Error('上傳圖片失敗: ' + JSON.stringify(data));

    // 設為任何人可讀（讓 img src 可直接顯示）
    await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
    });

    return data.id;
}

// 由 driveFileId 取得可顯示的圖片 URL（使用 Blob URL 避免跨域問題）
async function getDriveImageUrl(driveFileId) {
    try {
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const blob = await res.blob();
        return URL.createObjectURL(blob);
    } catch {
        return '';
    }
}

// ─── Cloud Tree（雲端版目錄樹，平坦結構）─────────────────
function buildCloudTree() {
    return Object.keys(database).map(id => ({
        kind: 'file',
        fileId: id,
        name: (fileMeta[id]?.title || id) + '.json'
    }));
}

// ─── UI 初始化與事件綁定 ──────────────────────────────────
function initUI() {
    $('btnOpenFolder').addEventListener('click', handleAuthClick);
    $('btnLogout').addEventListener('click', handleLogoutClick);
    $('btnNewNote').addEventListener('click', createNewNotePrompt);
    $('btnNewNoteMobile')?.addEventListener('click', createNewNotePrompt);
    $('btnRefresh').addEventListener('click', async () => {
        if (!accessToken) { toast('請先連結 Google 雲端'); return; }
        toast('正在手動同步…');
        await downloadNotesFromDrive();
    });
    $('btnSidebarToggle').addEventListener('click', () => toggleMobileDrawer(true));
    $('closeDrawer').addEventListener('click', () => toggleMobileDrawer(false));
    $('drawerMask').addEventListener('click', () => toggleMobileDrawer(false));
    $('btnTheme').addEventListener('click', toggleTheme);
    $('btnCommand').addEventListener('click', openCmdPalette);
    $('btnGraph').addEventListener('click', openGraphModal);
    $('btnDelete').addEventListener('click', deleteCurrentNote);
    $('btnExport').addEventListener('click', openExportModal);
    $('btnAddTag').addEventListener('click', promptAddTag);
    $('closeGraph').addEventListener('click', () => hide($('graphModal')));
    $('closeExport').addEventListener('click', () => hide($('exportModal')));

    $('textColorPicker')?.addEventListener('input', e => {
        document.execCommand('foreColor', false, e.target.value);
        scheduleSave();
    });

    $('topSearch').addEventListener('input', e => handleSearch(e.target.value));
    $('topSearch').addEventListener('keydown', e => {
        if (e.key === 'Escape') { $('topSearch').value = ''; handleSearch(''); }
    });

    $('cmdInput').addEventListener('input', filterCmdResults);
    $('cmdInput').addEventListener('keydown', handleCmdKeydown);
    $$('#cmdResults .cmd-item').forEach(item => {
        item.addEventListener('click', () => runCmdAction(item.dataset.action));
    });

    $('exportMd').addEventListener('click', () => doExport('md'));
    $('exportJson').addEventListener('click', () => doExport('json'));
    $('exportTxt').addEventListener('click', () => doExport('txt'));
    $('exportCopy').addEventListener('click', () => doExport('copy'));

    $$('.panel-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.panel-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            const panelId = 'panel' + btn.dataset.panel.charAt(0).toUpperCase() + btn.dataset.panel.slice(1);
            $$('.panel-content').forEach(p => p.classList.remove('active'));
            const target = $(panelId);
            if (target) target.classList.add('active');
        });
    });

    $$('.toolbar-btn').forEach(btn => {
        btn.addEventListener('mousedown', e => {
            e.preventDefault();
            if (btn.dataset.format) {
                document.execCommand(btn.dataset.format, false, null);
            } else if (btn.dataset.cmd) {
                applyBlockCommand(btn.dataset.cmd);
            }
        });
    });

    document.addEventListener('keydown', handleGlobalShortcut);
    $('cmdPalette').addEventListener('click', e => { if (e.target === $('cmdPalette')) closeCmdPalette(); });
    $('graphModal').addEventListener('click', e => { if (e.target === $('graphModal')) hide($('graphModal')); });
    $('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) hide($('exportModal')); });
}

function handleGlobalShortcut(e) {
    const inEditor = document.activeElement.contentEditable === 'true';
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openCmdPalette(); return; }
    if (e.key === 'Escape') {
        closeCmdPalette(); hide($('graphModal')); hide($('exportModal')); toggleMobileDrawer(false); return;
    }
    if (e.key === '/' && !inEditor && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('topSearch').focus(); }
}

// ─── Tree UI ─────────────────────────────────────────────
function renderTreeUI(tree) {
    const root = $('noteTree');
    const mobile = $('noteTreeMobile');
    root.innerHTML = '';
    if (mobile) mobile.innerHTML = '';

    if (!Object.keys(database).length) {
        root.innerHTML = '<li class="tree-empty"><div class="tree-empty-icon">☁️</div><div>請連結 Google 雲端<br>以載入筆記</div></li>';
        return;
    }

    function buildNodes(nodes, parentEl, isMobile) {
        nodes.forEach(n => {
            const li = document.createElement('li');
            li.className = 'tree-item';
            li.dataset.id = n.fileId;

            const btn = document.createElement('button');
            btn.className = 'tree-file-btn' + (n.fileId === currentFileId ? ' active' : '');
            const label = fileMeta[n.fileId]?.title || n.fileId;
            btn.innerHTML = `<span class="tree-file-name" title="${label}">📄 ${label}</span>`;
            btn.addEventListener('click', () => {
                if (isMobile) toggleMobileDrawer(false);
                switchNote(n.fileId);
            });
            li.appendChild(btn);
            parentEl.appendChild(li);
        });
    }

    buildNodes(tree, root, false);
    if (mobile) buildNodes(tree, mobile, true);
}

// ─── Note CRUD ───────────────────────────────────────────
function switchNote(fileId) {
    if (!database[fileId]) return;
    currentFileId = fileId;
    const title = fileMeta[fileId]?.title || fileId;
    $('noteTitle').textContent = title;

    // 手機版 read-only，桌機版可編輯
    $('noteTitle').contentEditable = IS_MOBILE ? 'false' : 'true';

    $('noteMeta').textContent = `🆔 ${fileId}`;
    renderTreeUI(buildCloudTree());
    renderBlocks(database[fileId] || []);
    updateStats();
    updateOutline();
    updatePropsPanel();
    renderTags();
    computeAndShowBacklinks(fileId);

    hide($('searchResults'));
    show($('blocksContainer'));
    show($('editorToolbar'));
    show($('noteHeader'));

    // 手機 read-only：隱藏 toolbar
    if (IS_MOBILE) hide($('editorToolbar'));

    $('noteTitle').addEventListener('blur', renameCurrentNote, { once: true });
}

function renameCurrentNote() {
    if (!currentFileId) return;
    const newTitle = $('noteTitle').textContent.trim();
    if (!newTitle || (fileMeta[currentFileId]?.title === newTitle)) return;
    if (!fileMeta[currentFileId]) fileMeta[currentFileId] = { created: Date.now(), tags: [] };
    fileMeta[currentFileId].title = newTitle;
    renderTreeUI(buildCloudTree());
    scheduleSave();
}

function createNewNotePrompt() {
    if (!accessToken) { toast('請先連結 Google 雲端'); return; }
    const name = prompt('新筆記名稱:');
    if (!name || !name.trim()) return;
    const cleanName = name.trim();
    const id = 'note_' + Date.now().toString(36);
    database[id] = [{ id: uid(), content: '', indent: 0 }];
    fileMeta[id] = { created: Date.now(), modified: Date.now(), tags: [], wordCount: 0, title: cleanName };
    noteTree = buildCloudTree();
    renderTreeUI(noteTree);
    switchNote(id);
    scheduleSave();
    toast('📝 新筆記已建立');
}

function deleteCurrentNote() {
    if (!currentFileId) return;
    const title = fileMeta[currentFileId]?.title || currentFileId;
    if (!confirm(`確認刪除「${title}」？此操作不可逆。`)) return;
    delete database[currentFileId];
    delete fileMeta[currentFileId];
    currentFileId = null;
    noteTree = buildCloudTree();
    renderTreeUI(noteTree);
    hide($('blocksContainer'));
    hide($('noteHeader'));
    hide($('editorToolbar'));
    scheduleSave();
    toast('🗑️ 已刪除');
}

// ─── Block Rendering ─────────────────────────────────────
function renderBlocks(blocks) {
    const c = $('blocksContainer');
    c.innerHTML = '';

    if (!blocks || !blocks.length) {
        blocks = [{ id: uid(), content: '', indent: 0 }];
        database[currentFileId] = blocks;
    }

    // 計算 fold 隱藏狀態
    let skipIndentLevel = Infinity;
    blocks.forEach(block => {
        const ci = block.indent || 0;
        if (ci <= skipIndentLevel) skipIndentLevel = Infinity;
        block._isHidden = (skipIndentLevel !== Infinity);
        if (block.collapsed) skipIndentLevel = Math.min(skipIndentLevel, ci);
    });

    blocks.forEach((block, index) => renderBlock(block, index, blocks, c));
}

function renderBlock(block, index, blocks, c) {
    const row = document.createElement('div');
    row.className = 'block-row';
    row.style.marginLeft = (block.indent || 0) + 'px';
    if (block._isHidden) row.style.display = 'none';

    // Drag handle（手機版隱藏）
    const drag = document.createElement('div');
    drag.className = 'block-drag';
    drag.innerHTML = '⦙⦙';
    drag.draggable = true;
    drag.title = '拖曳排序';
    if (IS_MOBILE) drag.style.display = 'none';

    drag.addEventListener('dragstart', e => {
        draggedIndex = index;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
    });
    drag.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        c.querySelectorAll('.block-row').forEach(r => r.classList.remove('drag-over'));
    });
    row.addEventListener('dragover', e => {
        e.preventDefault();
        c.querySelectorAll('.block-row').forEach(r => r.classList.remove('drag-over'));
        row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (draggedIndex !== null && draggedIndex !== index) {
            let count = 1;
            const parentIndent = blocks[draggedIndex].indent || 0;
            while (blocks[draggedIndex + count] && (blocks[draggedIndex + count].indent || 0) > parentIndent) count++;
            const movedGroup = blocks.splice(draggedIndex, count);
            let targetIndex = draggedIndex < index ? index - count : index;
            if (targetIndex < 0) targetIndex = 0;
            blocks.splice(targetIndex, 0, ...movedGroup);
            renderBlocks(blocks);
            scheduleSave();
        }
        draggedIndex = null;
    });

    // Fold toggle
    const foldToggle = document.createElement('div');
    foldToggle.className = 'block-fold-toggle';
    foldToggle.style.cssText = 'width:14px;height:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;font-size:10px;color:var(--text3);margin-right:4px;';
    const hasChildren = blocks[index + 1] && (blocks[index + 1].indent || 0) > (block.indent || 0);
    if (hasChildren) {
        foldToggle.innerHTML = block.collapsed ? '▶' : '▼';
        foldToggle.title = block.collapsed ? '展開' : '摺疊';
        foldToggle.addEventListener('click', () => {
            block.collapsed = !block.collapsed;
            renderBlocks(blocks);
            scheduleSave();
        });
    }

    // Bullet
    const bullet = document.createElement('div');
    bullet.className = 'block-bullet';
    if (block.type === 'image') {
        bullet.innerHTML = '🖼';
    } else if (block.todo !== undefined) {
        bullet.innerHTML = '';
    } else {
        bullet.innerHTML = '•';
        bullet.title = '點擊轉換類型';
        bullet.addEventListener('click', () => cycleBlockType(block, index, blocks));
    }

    // Editor
    const editor = document.createElement('div');
    editor.className = 'block-editor';
    editor.setAttribute('data-placeholder', index === 0 ? '開始記錄…' : '');

    if (block.type === 'image') {
        editor.contentEditable = 'false';
        renderImageBlock(block, index, blocks, editor);
    } else if (block.todo !== undefined) {
        editor.contentEditable = 'false';
        renderTodoBlock(block, index, blocks, editor);
    } else {
        // 手機版 read-only
        editor.contentEditable = IS_MOBILE ? 'false' : 'true';
        editor.innerHTML = block.content || '';

        if (!IS_MOBILE) {
            editor.addEventListener('keydown', e => handleBlockKeydown(e, block, index, blocks, c));
            editor.addEventListener('input', () => {
                block.content = editor.innerHTML;
                scheduleSave();
                updateStatsDebounced();
            });
            editor.addEventListener('blur', () => {
                block.content = editor.innerHTML;
                scheduleSave();
                updateOutline();
            });
            editor.addEventListener('paste', e => handlePaste(e, block, index, blocks));
            editor.addEventListener('focus', () => show($('editorToolbar')));
        }
    }

    row.appendChild(drag);
    row.appendChild(foldToggle);
    row.appendChild(bullet);
    row.appendChild(editor);
    c.appendChild(row);
}

function cycleBlockType(block, index, blocks) {
    const content = block.content || '';
    if (!content.trim()) return;
    const stripped = content.replace(/<\/?h[1-3][^>]*>/g, '').replace(/<br\s*\/?>/gi, '').trim();
    if (!block._headingLevel) block._headingLevel = 1;
    else block._headingLevel = (block._headingLevel % 3) + 1;
    block.content = `<h${block._headingLevel}>${stripped}</h${block._headingLevel}>`;
    renderBlocks(blocks);
    scheduleSave();
}

// ─── Image Block（Drive 版）───────────────────────────────
function renderImageBlock(block, index, blocks, editor) {
    const wrap = document.createElement('div');
    wrap.className = 'image-block-wrap';

    const img = document.createElement('img');
    img.style.width = block.width || '320px';
    img.alt = '圖片載入中…';

    // 優先用 driveFileId 透過 API 取得，fallback 用 content（base64 或 url）
    if (block.driveFileId && accessToken) {
        getDriveImageUrl(block.driveFileId).then(url => {
            if (url) { img.src = url; img.alt = ''; }
            else { img.alt = '❌ 圖片無法載入'; }
        });
    } else if (block.content) {
        img.src = block.content;
        img.alt = '';
    } else {
        img.alt = '❌ 圖片遺失';
    }

    const ctrl = document.createElement('div');
    ctrl.className = 'image-controls';

    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '80'; slider.max = '900';
    slider.value = parseInt(block.width) || 320;
    slider.addEventListener('input', () => {
        img.style.width = slider.value + 'px';
        block.width = slider.value + 'px';
        label.textContent = slider.value + 'px';
        scheduleSave();
    });

    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text3)';
    label.textContent = (parseInt(block.width) || 320) + 'px';

    const del = document.createElement('button');
    del.className = 'image-del-btn';
    del.textContent = '🗑 刪除';
    del.addEventListener('click', () => {
        deleteBlockAndChildren(index, blocks);
        renderBlocks(blocks);
        scheduleSave();
    });

    if (!IS_MOBILE) ctrl.append(slider, label, del);
    wrap.append(img, ctrl);
    editor.appendChild(wrap);
}

// ─── Todo Block ──────────────────────────────────────────
function renderTodoBlock(block, index, blocks, editor) {
    const wrap = document.createElement('div');
    wrap.className = 'todo-block';

    const box = document.createElement('div');
    box.className = 'todo-checkbox' + (block.todo ? ' checked' : '');
    box.textContent = block.todo ? '✓' : '';

    const content = document.createElement('div');
    content.className = 'todo-content' + (block.todo ? ' checked' : '');
    content.contentEditable = IS_MOBILE ? 'false' : 'true';
    content.innerHTML = block.content || '';

    if (!IS_MOBILE) {
        box.addEventListener('click', () => {
            block.todo = !block.todo;
            box.classList.toggle('checked', block.todo);
            box.textContent = block.todo ? '✓' : '';
            content.classList.toggle('checked', block.todo);
            scheduleSave();
        });
        content.addEventListener('input', () => { block.content = content.innerHTML; scheduleSave(); });
        content.addEventListener('keydown', e => {
            if (e.key === 'Backspace' && !content.innerText.trim()) {
                e.preventDefault();
                if (blocks.length > 1) { deleteBlockAndChildren(index, blocks); }
                else { blocks[0] = { id: uid(), content: '', indent: 0 }; }
                renderBlocks(blocks);
                scheduleSave();
                setTimeout(() => focusBlock(Math.max(0, index - 1)), 10);
            }
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                blocks.splice(index + 1, 0, { id: uid(), content: '', indent: block.indent || 0 });
                renderBlocks(blocks);
                scheduleSave();
                setTimeout(() => focusBlock(index + 1), 10);
            }
        });
    }

    wrap.appendChild(box);
    wrap.appendChild(content);
    editor.appendChild(wrap);
}

// ─── Keyboard Handling ───────────────────────────────────
async function handleBlockKeydown(e, block, index, blocks, c) {
    if (e.key === 'Enter' && !e.shiftKey && (block.content || '').trim() === '/bl') {
        e.preventDefault();
        insertBacklinksToCurrentBlock(index, blocks);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        blocks.splice(index + 1, 0, { id: uid(), content: '', indent: block.indent || 0 });
        renderBlocks(blocks);
        scheduleSave();
        setTimeout(() => focusBlock(index + 1), 10);
    } else if (e.key === 'Tab') {
        e.preventDefault();
        block.indent = Math.max(0, (block.indent || 0) + (e.shiftKey ? -24 : 24));
        renderBlocks(blocks);
        scheduleSave();
        setTimeout(() => focusBlock(index), 10);
    } else if (e.key === 'Backspace') {
        const el = c.children[index]?.querySelector('.block-editor');
        const text = el ? el.innerText.trim() : '';
        if (!text) {
            e.preventDefault();
            if (blocks.length > 1) {
                deleteBlockAndChildren(index, blocks);
                renderBlocks(blocks);
                scheduleSave();
                setTimeout(() => focusBlock(Math.max(0, index - 1)), 10);
            } else {
                blocks[0].content = '';
                if (el) el.innerHTML = '';
                scheduleSave();
            }
        }
    } else if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        if (index > 0) {
            [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
            renderBlocks(blocks); scheduleSave();
            setTimeout(() => focusBlock(index - 1), 10);
        }
    } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        if (index < blocks.length - 1) {
            [blocks[index], blocks[index + 1]] = [blocks[index + 1], blocks[index]];
            renderBlocks(blocks); scheduleSave();
            setTimeout(() => focusBlock(index + 1), 10);
        }
    }
}

function focusBlock(index) {
    const c = $('blocksContainer');
    const row = c?.children[index];
    if (!row) return;
    const ed = row.querySelector('.block-editor, .todo-content');
    if (!ed) return;
    ed.focus();
    try {
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(ed);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    } catch { }
}

// ─── Toolbar commands ─────────────────────────────────────
function applyBlockCommand(cmd) {
    const focused = document.activeElement;
    if (!focused || !focused.className.includes('block-editor')) return;
    const index = getBlockIndex(focused);
    if (index < 0 || !currentFileId) return;
    const blocks = database[currentFileId];
    const block = blocks[index];

    switch (cmd) {
        case 'h1': wrapSelection(focused, 'h1'); break;
        case 'h2': wrapSelection(focused, 'h2'); break;
        case 'h3': wrapSelection(focused, 'h3'); break;
        case 'highlight': document.execCommand('backColor', false, '#fef08a'); break;
        case 'code': document.execCommand('insertHTML', false, '<code>&nbsp;</code>'); break;
        case 'quote': document.execCommand('insertHTML', false, '<blockquote>&nbsp;</blockquote>'); break;
        case 'link': {
            const url = prompt('URL:');
            const text = prompt('連結文字:') || url;
            if (url) document.execCommand('insertHTML', false, `<a href="${url}" target="_blank">${text}</a>`);
            break;
        }
        case 'tag': document.execCommand('insertHTML', false, ' #標籤 '); break;
        case 'table': {
            const rows = parseInt(prompt('列數:', '3')) || 3;
            const cols = parseInt(prompt('欄數:', '3')) || 3;
            let tbl = '<table><thead><tr>' + Array(cols).fill('<th>欄位</th>').join('') + '</tr></thead><tbody>';
            for (let r = 0; r < rows - 1; r++) tbl += '<tr>' + Array(cols).fill('<td>&nbsp;</td>').join('') + '</tr>';
            tbl += '</tbody></table>';
            document.execCommand('insertHTML', false, tbl);
            break;
        }
        case 'hr': document.execCommand('insertHTML', false, '<hr>'); break;
        case 'todo': {
            const newTodo = { id: uid(), todo: false, content: '', indent: block.indent || 0 };
            blocks.splice(index + 1, 0, newTodo);
            renderBlocks(blocks);
            scheduleSave();
            break;
        }
    }
    if (block) { block.content = focused.innerHTML; scheduleSave(); }
}

function wrapSelection(el, tag) {
    const sel = window.getSelection();
    if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        try {
            const wrapper = document.createElement(tag);
            range.surroundContents(wrapper);
        } catch { document.execCommand('insertHTML', false, `<${tag}>${sel.toString()}</${tag}>`); }
    }
}

function getBlockIndex(editorEl) {
    const row = editorEl.closest('.block-row');
    if (!row) return -1;
    return Array.from($('blocksContainer').children).indexOf(row);
}

// ─── Paste Handler（圖片 → Drive image/ 資料夾）──────────
async function handlePaste(e, block, index, blocks) {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items || [];
    for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
            e.preventDefault();
            const file = it.getAsFile();
            if (!accessToken) { toast('⚠️ 請先連結 Google 雲端以儲存圖片'); return; }
            toast('🖼️ 圖片上傳中…');
            try {
                const driveFileId = await uploadImageToDrive(file);
                blocks.splice(index + 1, 0, {
                    id: uid(), type: 'image',
                    driveFileId,               // ← 對應本地版的 src: './image/...'
                    width: '320px',
                    indent: block.indent || 0
                });
                renderBlocks(blocks);
                scheduleSave();
                toast('✅ 圖片已儲存至 Google Drive image/ 資料夾');
            } catch (err) {
                toast('⚠️ 圖片上傳失敗: ' + err.message);
                console.error(err);
            }
            return;
        }
    }

    // Markdown paste
    const rawText = e.clipboardData?.getData('text/plain') || '';
    if (rawText && (rawText.includes('|') || /^#+\s/.test(rawText) || rawText.includes('**') || rawText.includes('```'))) {
        e.preventDefault();
        const html = parseMarkdownToHtml(rawText);
        document.execCommand('insertHTML', false, html);
    }
}

// ─── Markdown Parser ─────────────────────────────────────
function parseMarkdownToHtml(md) {
    const lines = md.split('\n');
    let inTable = false, tableBuffer = '', inCodeBlock = false, codeBuffer = '';
    const out = [];

    for (let raw of lines) {
        const line = raw.trimEnd();
        if (line.startsWith('```')) {
            if (inCodeBlock) { out.push(`<pre><code>${escHtml(codeBuffer)}</code></pre>`); codeBuffer = ''; inCodeBlock = false; }
            else inCodeBlock = true;
            continue;
        }
        if (inCodeBlock) { codeBuffer += (codeBuffer ? '\n' : '') + line; continue; }

        const trimmed = line.trim();
        if (trimmed.startsWith('|')) {
            if (trimmed.replace(/[\|\-\s:]/g, '').length === 0) continue;
            if (!inTable) { inTable = true; tableBuffer = '<table><thead><tr>'; }
            const cells = trimmed.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
            if (tableBuffer.includes('<thead>') && !tableBuffer.includes('</thead>')) {
                cells.forEach(c => tableBuffer += `<th>${inlineFormat(c)}</th>`);
                tableBuffer += '</tr></thead><tbody>';
            } else {
                tableBuffer += '<tr>'; cells.forEach(c => tableBuffer += `<td>${inlineFormat(c)}</td>`); tableBuffer += '</tr>';
            }
            continue;
        } else if (inTable) { tableBuffer += '</tbody></table>'; out.push(tableBuffer); tableBuffer = ''; inTable = false; }

        if (trimmed === '---' || trimmed === '***') { out.push('<hr>'); continue; }
        if (trimmed.startsWith('# ')) { out.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`); continue; }
        if (trimmed.startsWith('## ')) { out.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`); continue; }
        if (trimmed.startsWith('### ')) { out.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`); continue; }
        if (trimmed.startsWith('> ')) { out.push(`<blockquote>${inlineFormat(trimmed.slice(2))}</blockquote>`); continue; }
        if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('* [ ] ')) { out.push(`<span class="todo-item">☐ ${inlineFormat(trimmed.slice(6))}</span>`); continue; }
        if (trimmed.startsWith('- [x] ') || trimmed.startsWith('* [x] ')) { out.push(`<span class="todo-item done">☑ ${inlineFormat(trimmed.slice(6))}</span>`); continue; }
        if (trimmed) out.push(inlineFormat(trimmed));
        else if (out.length) out.push('<br>');
    }
    if (inTable) { tableBuffer += '</tbody></table>'; out.push(tableBuffer); }
    return out.join('<br>');
}

function inlineFormat(text) {
    return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/~~(.+?)~~/g, '<s>$1</s>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[\[(.+?)\]\]/g, (_, p) => `<span class="wiki-link" data-target="${p}" onclick="jumpToWikiLink('${p.replace(/'/g, "\\'")}')">${p}</span>`)
        .replace(/(^|\s)(#[\w\u4e00-\u9fa5]+)/g, '$1<span class="inline-tag" onclick="searchTag(\'$2\')">$2</span>')
        .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

window.jumpToWikiLink = function (name) {
    const target = Object.keys(database).find(id => (fileMeta[id]?.title || id) === name);
    if (target) switchNote(target);
    else if (confirm(`「${name}」尚未存在，要建立此筆記嗎？`)) createNoteByName(name);
};

window.searchTag = function (tag) {
    $('topSearch').value = tag;
    handleSearch(tag);
};

function createNoteByName(name) {
    if (!accessToken) return;
    const id = 'note_' + Date.now().toString(36);
    database[id] = [{ id: uid(), content: '', indent: 0 }];
    fileMeta[id] = { created: Date.now(), modified: Date.now(), tags: [], wordCount: 0, title: name };
    noteTree = buildCloudTree();
    renderTreeUI(noteTree);
    switchNote(id);
    scheduleSave();
}

// ─── Save（debounce → Drive）─────────────────────────────
function scheduleSave() {
    if (!accessToken) return;
    clearTimeout(saveTimer);
    $('lastSaved').textContent = '未儲存…';
    saveTimer = setTimeout(uploadNotesToDrive, 800);
}

// ─── Search ──────────────────────────────────────────────
function handleSearch(query) {
    const sr = $('searchResults');
    const bc = $('blocksContainer');
    const nh = $('noteHeader');
    if (!query.trim()) { hide(sr); if (currentFileId) { show(bc); show(nh); } return; }
    hide(bc); show(sr);
    sr.innerHTML = '';
    const q = query.toLowerCase();
    const results = [];
    Object.keys(database).forEach(fid => {
        (database[fid] || []).forEach((b, bi) => {
            const text = (b.content || '').replace(/<[^>]+>/g, '');
            if (text.toLowerCase().includes(q)) results.push({ fid, text, index: bi });
        });
    });
    const header = document.createElement('div');
    header.className = 'search-header';
    header.textContent = results.length ? `找到 ${results.length} 個結果` : '找不到符合內容';
    sr.appendChild(header);
    results.forEach(r => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const highlighted = r.text.replace(new RegExp(escapeRegex(query), 'gi'), m => `<mark>${m}</mark>`);
        item.innerHTML = `<div class="search-result-file">📄 ${fileMeta[r.fid]?.title || r.fid}</div><div class="search-result-snippet">${highlighted.slice(0, 200)}</div>`;
        item.addEventListener('click', () => { $('topSearch').value = ''; hide(sr); switchNote(r.fid); });
        sr.appendChild(item);
    });
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Stats ───────────────────────────────────────────────
let statsTimer = null;
function updateStatsDebounced() { clearTimeout(statsTimer); statsTimer = setTimeout(updateStats, 500); }
function updateStats() {
    if (!currentFileId) return;
    const blocks = database[currentFileId] || [];
    let words = 0;
    blocks.forEach(b => { const t = (b.content || '').replace(/<[^>]+>/g, '').trim(); if (t) words += t.split(/\s+/).filter(Boolean).length; });
    $('wordCount').textContent = words + ' 字';
    $('blockCount').textContent = blocks.length + ' 個區塊';
    if ($('propWords')) $('propWords').textContent = words;
    if ($('propBlocks')) $('propBlocks').textContent = blocks.length;
    if (fileMeta[currentFileId]) fileMeta[currentFileId].wordCount = words;
}

// ─── Outline ─────────────────────────────────────────────
function updateOutline() {
    if (!currentFileId) return;
    const list = $('outlineList');
    list.innerHTML = '';
    let hasHeadings = false;
    (database[currentFileId] || []).forEach((b, i) => {
        const match = (b.content || '').match(/^<(h[1-3])[^>]*>(.*?)<\/h[1-3]>/i);
        if (match) {
            hasHeadings = true;
            const item = document.createElement('div');
            item.className = `outline-item ${match[1]}`;
            item.textContent = match[2].replace(/<[^>]+>/g, '');
            item.addEventListener('click', () => focusBlock(i));
            list.appendChild(item);
        }
    });
    if (!hasHeadings) list.innerHTML = '<div class="outline-empty">此筆記無標題結構</div>';
}

// ─── Props Panel ─────────────────────────────────────────
function updatePropsPanel() {
    if (!currentFileId || !fileMeta[currentFileId]) return;
    const meta = fileMeta[currentFileId];
    const fmt = ts => ts ? new Date(ts).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '—';
    if ($('propCreated')) $('propCreated').textContent = fmt(meta.created);
    if ($('propModified')) $('propModified').textContent = fmt(meta.modified);
    const blocks = database[currentFileId] || [];
    let linkCount = 0;
    blocks.forEach(b => { const m = (b.content || '').match(/\[\[.+?\]\]/g); if (m) linkCount += m.length; });
    if ($('propLinks')) $('propLinks').textContent = linkCount;
}

// ─── Tags ─────────────────────────────────────────────────
function renderTags() {
    if (!currentFileId) return;
    const tags = fileMeta[currentFileId]?.tags || [];
    const tagsList = $('tagsList');
    tagsList.innerHTML = '';
    tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = '#' + tag;
        chip.addEventListener('click', () => { $('topSearch').value = '#' + tag; handleSearch('#' + tag); });
        tagsList.appendChild(chip);
    });
}

function promptAddTag() {
    const tag = prompt('新增標籤 (不需 # 符號):');
    if (!tag || !tag.trim()) return;
    const clean = tag.trim().replace(/^#/, '');
    if (!fileMeta[currentFileId]) fileMeta[currentFileId] = { tags: [] };
    if (!fileMeta[currentFileId].tags) fileMeta[currentFileId].tags = [];
    if (!fileMeta[currentFileId].tags.includes(clean)) {
        fileMeta[currentFileId].tags.push(clean);
        if (!tagIndex[clean]) tagIndex[clean] = new Set();
        tagIndex[clean].add(currentFileId);
        renderTags();
        scheduleSave();
    }
}

// ─── Backlinks ───────────────────────────────────────────
function computeAndShowBacklinks(fileId) {
    const panel = $('backlinksPanel');
    const list = $('backlinksList');
    if (!list || !panel) return;
    list.innerHTML = '';
    const noteName = fileMeta[fileId]?.title || fileId;
    const backlinks = [];
    Object.keys(database).forEach(fid => {
        if (fid === fileId) return;
        const found = (database[fid] || []).some(b => (b.content || '').includes(`[[${noteName}]]`));
        if (found) backlinks.push(fid);
    });
    if (!backlinks.length) { hide(panel); return; }
    show(panel);
    backlinks.forEach(fid => {
        const li = document.createElement('li');
        li.className = 'backlink-item';
        li.textContent = '🔗 ' + (fileMeta[fid]?.title || fid);
        li.addEventListener('click', () => switchNote(fid));
        list.appendChild(li);
    });
}

function insertBacklinksToCurrentBlock(currentIndex, blocks) {
    const currentName = fileMeta[currentFileId]?.title || currentFileId;
    const targetLink = `[[${currentName}]]`;
    let allGroupsToInsert = [];

    Object.entries(database).forEach(([fid, bks]) => {
        if (fid === currentFileId) return;
        const sourceName = fileMeta[fid]?.title || fid;
        bks.forEach((b, bIndex) => {
            if (!(b.content || '').includes(targetLink)) return;
            const anchorIndent = b.indent || 0;
            const group = [{ ...b, id: uid('b') }];
            for (let i = bIndex + 1; i < bks.length; i++) {
                if ((bks[i].indent || 0) <= anchorIndent) break;
                group.push({ ...bks[i], id: uid('b') });
            }
            allGroupsToInsert.push({ sourceName, fid, group, anchorIndent });
        });
    });

    if (!allGroupsToInsert.length) { toast('找不到引用此筆記的內容'); return; }

    const baseIndent = (blocks[currentIndex].indent || 0) + 24;
    const newBlocks = [{ id: uid('b'), content: '', indent: blocks[currentIndex].indent || 0, _backlinkSync: true }];

    allGroupsToInsert.forEach(({ sourceName, group, anchorIndent }) => {
        newBlocks.push({ id: uid('b'), content: `<span style="color:var(--text3);font-size:0.82em">🔗 引用自：<strong>${sourceName}</strong></span>`, indent: baseIndent - 24, _backlinkGenerated: true });
        group.forEach(blk => {
            newBlocks.push({ ...blk, id: uid('b'), indent: baseIndent + ((blk.indent || 0) - anchorIndent), _backlinkGenerated: true });
        });
    });

    blocks.splice(currentIndex, 1, ...newBlocks);
    renderBlocks(blocks);
    scheduleSave();
    toast(`✅ 已匯入 ${allGroupsToInsert.length} 組引用`);
}

// ─── Knowledge Graph ─────────────────────────────────────
function openGraphModal() { show($('graphModal')); requestAnimationFrame(drawGraph); }

function drawGraph() {
    const canvas = $('graphCanvas');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const isDark = document.body.dataset.theme === 'dark';
    const fgColor = isDark ? '#e7e5e4' : '#1c1917';
    const bgColor = isDark ? '#1c1b1a' : '#ffffff';
    const accentColor = isDark ? '#818cf8' : '#4f46e5';
    const edgeColor = isDark ? '#3a3937' : '#e7e5e4';
    const nodeColor = isDark ? '#242322' : '#f9f9f8';
    ctx.fillStyle = bgColor; ctx.fillRect(0, 0, canvas.width, canvas.height);

    const files = Object.keys(database);
    if (!files.length) {
        ctx.fillStyle = fgColor; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('尚無筆記資料', canvas.width / 2, canvas.height / 2); return;
    }

    const nodes = {}; const links = [];
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const r = Math.min(cx, cy) * 0.75;

    files.forEach((fid, i) => {
        const angle = (i / files.length) * Math.PI * 2 - Math.PI / 2;
        const radius = files.length <= 1 ? 0 : r * (0.3 + 0.7 * Math.random());
        nodes[fid] = { x: cx + radius * Math.cos(angle) + (Math.random() - .5) * 40, y: cy + radius * Math.sin(angle) + (Math.random() - .5) * 40, name: fileMeta[fid]?.title || fid, linkCount: 0 };
    });

    files.forEach(fid => {
        (database[fid] || []).forEach(b => {
            const matches = (b.content || '').matchAll(/\[\[(.+?)\]\]/g);
            for (const m of matches) {
                const target = files.find(f => (fileMeta[f]?.title || f) === m[1]);
                if (target && target !== fid) { links.push({ from: fid, to: target }); nodes[fid].linkCount++; nodes[target].linkCount++; }
            }
        });
    });

    ctx.strokeStyle = edgeColor; ctx.lineWidth = 1;
    links.forEach(l => {
        const a = nodes[l.from], b = nodes[l.to];
        if (!a || !b) return;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });

    files.forEach(fid => {
        const n = nodes[fid];
        const rad = 6 + n.linkCount * 2;
        const isActive = fid === currentFileId;
        ctx.beginPath(); ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? accentColor : nodeColor; ctx.fill();
        ctx.strokeStyle = isActive ? accentColor : edgeColor; ctx.lineWidth = isActive ? 2 : 1; ctx.stroke();
        ctx.fillStyle = fgColor; ctx.font = `${isActive ? 600 : 400} 10px sans-serif`; ctx.textAlign = 'center';
        ctx.fillText(n.name.length > 12 ? n.name.slice(0, 12) + '…' : n.name, n.x, n.y + rad + 12);
    });

    canvas.onclick = (e) => {
        const rect2 = canvas.getBoundingClientRect();
        const mx = e.clientX - rect2.left, my = e.clientY - rect2.top;
        for (const fid of files) {
            const n = nodes[fid]; const rad = 6 + n.linkCount * 2;
            if ((mx - n.x) ** 2 + (my - n.y) ** 2 <= rad * rad) { hide($('graphModal')); switchNote(fid); break; }
        }
    };
}

// ─── Export ──────────────────────────────────────────────
function openExportModal() {
    if (!currentFileId) return;
    show($('exportModal'));
    const md = buildMarkdown();
    $('exportPreview').textContent = md.slice(0, 600) + (md.length > 600 ? '\n…' : '');
}

function buildMarkdown() {
    if (!currentFileId) return '';
    const title = fileMeta[currentFileId]?.title || currentFileId;
    const blocks = database[currentFileId] || [];
    const lines = ['# ' + title, ''];
    blocks.forEach(b => {
        if (b.type === 'image') { lines.push(`![圖片](drive://image/${b.driveFileId || ''})`); return; }
        if (b.todo !== undefined) { lines.push(`- [${b.todo ? 'x' : ' '}] ${(b.content || '').replace(/<[^>]+>/g, '')}`); return; }
        const text = (b.content || '').replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/?(h1)[^>]*>/gi, m => m.startsWith('</') ? '\n' : '# ')
            .replace(/<\/?(h2)[^>]*>/gi, m => m.startsWith('</') ? '\n' : '## ')
            .replace(/<\/?(h3)[^>]*>/gi, m => m.startsWith('</') ? '\n' : '### ')
            .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
            .replace(/<em>(.*?)<\/em>/gi, '*$1*')
            .replace(/<s>(.*?)<\/s>/gi, '~~$1~~')
            .replace(/<code>(.*?)<\/code>/gi, '`$1`')
            .replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
            .replace(/<blockquote>(.*?)<\/blockquote>/gi, '> $1')
            .replace(/<[^>]+>/g, '').trim();
        if (text) lines.push('  '.repeat((b.indent || 0) / 24) + text);
    });
    return lines.join('\n');
}

function doExport(format) {
    const title = fileMeta[currentFileId]?.title || currentFileId || 'note';
    if (format === 'md') { downloadFile(title + '.md', buildMarkdown(), 'text/markdown'); toast('📄 Markdown 已下載'); }
    else if (format === 'json') { downloadFile(title + '.json', JSON.stringify({ meta: fileMeta[currentFileId], blocks: database[currentFileId] }, null, 2), 'application/json'); toast('🗂️ JSON 已下載'); }
    else if (format === 'txt') { downloadFile(title + '.txt', (database[currentFileId] || []).map(b => (b.content || '').replace(/<[^>]+>/g, '')).join('\n'), 'text/plain'); toast('📃 文字檔已下載'); }
    else if (format === 'copy') { navigator.clipboard.writeText(buildMarkdown()).then(() => toast('📋 已複製')); }
    hide($('exportModal'));
}

function downloadFile(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    URL.revokeObjectURL(a.href);
}

// ─── Theme ───────────────────────────────────────────────
function toggleTheme() {
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? 'light' : 'dark';
    $('themeIconLight').classList.toggle('hidden', !isDark);
    $('themeIconDark').classList.toggle('hidden', isDark);
    localStorage.setItem('rhizome-theme', isDark ? 'light' : 'dark');
}

function loadTheme() {
    const saved = localStorage.getItem('rhizome-theme');
    if (saved) {
        document.body.dataset.theme = saved;
        if (saved === 'dark') {
            $('themeIconLight')?.classList.add('hidden');
            $('themeIconDark')?.classList.remove('hidden');
        }
    }
}

// ─── Mobile Drawer ───────────────────────────────────────
function toggleMobileDrawer(show_) {
    const d = $('mobileDrawer');
    show_ ? show(d) : hide(d);
}

// ─── Command Palette ─────────────────────────────────────
function openCmdPalette() { show($('cmdPalette')); $('cmdInput').focus(); $('cmdInput').value = ''; filterCmdResults(); }
function closeCmdPalette() { hide($('cmdPalette')); $('cmdInput').value = ''; }

function filterCmdResults() {
    const q = $('cmdInput').value.toLowerCase().trim();
    $$('#cmdResults .cmd-item').forEach(item => {
        item.style.display = (!q || item.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
    let notesSection = $('cmdNotes');
    if (!notesSection) { notesSection = document.createElement('div'); notesSection.id = 'cmdNotes'; $('cmdResults').appendChild(notesSection); }
    notesSection.innerHTML = '';
    if (q && database) {
        const matches = Object.keys(database).filter(fid => (fileMeta[fid]?.title || fid).toLowerCase().includes(q)).slice(0, 5);
        if (matches.length) {
            const label = document.createElement('div'); label.className = 'cmd-section-label'; label.textContent = '筆記'; notesSection.appendChild(label);
            matches.forEach(fid => {
                const item = document.createElement('div'); item.className = 'cmd-item';
                item.innerHTML = `<span class="cmd-item-icon">📄</span> ${fileMeta[fid]?.title || fid}`;
                item.addEventListener('click', () => { closeCmdPalette(); switchNote(fid); });
                notesSection.appendChild(item);
            });
        }
    }
}

function handleCmdKeydown(e) {
    if (e.key === 'Escape') { closeCmdPalette(); return; }
    if (e.key === 'Enter') { runCmdAction($('cmdInput').value.trim().toLowerCase()); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...$$('#cmdResults .cmd-item')].filter(i => i.style.display !== 'none');
        const cur = items.findIndex(i => i.classList.contains('selected'));
        items.forEach(i => i.classList.remove('selected'));
        const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
        if (items[next]) items[next].classList.add('selected');
    }
}

function runCmdAction(action) {
    closeCmdPalette();
    switch (action) {
        case 'new': case 'n': createNewNotePrompt(); break;
        case 'open': case 'o': handleAuthClick(); break;
        case 'theme': case 't': toggleTheme(); break;
        case 'search': case '/': $('topSearch').focus(); break;
        case 'graph': case 'g': openGraphModal(); break;
        default:
            const match = Object.keys(database).find(fid => (fileMeta[fid]?.title || fid).toLowerCase() === action.toLowerCase());
            if (match) switchNote(match);
    }
}
