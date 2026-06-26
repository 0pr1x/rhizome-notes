/* =========================================================
   Rhizome Notes v4.0 — Cloud Edition (Google Drive API)
   Features: Blocks, Wiki-links, Backlinks, Tags, 
             Google Drive Sync, OAuth 2.0 Auth
   ========================================================= */

'use strict';

// ─── Cloud & API Config ──────────────────────────────────
// 【重要】請前往 Google Cloud Console 申請憑證並替換以下兩行！
const CLIENT_ID = '249300683470-vtgnnd73jvhe1ku7ckoftasrn8tesmfe.apps.googleusercontent.com'; 
const API_KEY = 'YOUR_API_KEY';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let driveFolderId = null; // 記錄雲端硬碟中 "NexusNotes_Workspace" 的資料夾 ID

// ─── State ───────────────────────────────────────────────
let database = {};      // fileId → blocks[]
let fileMeta = {};      // fileId → { name, created, modified }
let tagIndex = {};      // tag → Set<fileId>
let currentFileId = null;
let saveTimer = null;

// ─── Helpers ─────────────────────────────────────────────
const uid = (p = 'b') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, duration = 2200) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(t._timer);
    t._timer = setTimeout(() => hide(t), duration);
}

// ─── Google API Initialization ───────────────────────────
window.gapiLoaded = function() {
    gapi.load('client', async () => {
        await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
        checkAuthReady();
    });
};

window.gisLoaded = function() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (resp) => {
            if (resp.error !== undefined) { throw resp; }
            $('btnAuth').textContent = '已連線';
            $('syncStatus').className = 'status-dot online';
            await loadCloudWorkspace();
        }
    });
    gisInited = true;
    checkAuthReady();
};

function checkAuthReady() {
    if (gapiInited && gisInited) {
        $('btnAuth').onclick = handleAuthClick;
        $('btnAuthMobile').onclick = handleAuthClick;
    }
}

function handleAuthClick() {
    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

// ─── Drive File Operations (取代原本的 fs API) ───────────

// 1. 尋找或建立專屬資料夾
async function loadCloudWorkspace() {
    toast('正在同步雲端工作區...');
    $('syncStatus').className = 'status-dot syncing';
    try {
        let response = await gapi.client.drive.files.list({
            q: "mimeType='application/vnd.google-apps.folder' and name='NexusNotes_Workspace' and trashed=false",
            fields: 'files(id, name)',
            spaces: 'drive'
        });
        
        let files = response.result.files;
        if (files && files.length > 0) {
            driveFolderId = files[0].id;
        } else {
            // 建立資料夾
            let folderMeta = { name: 'NexusNotes_Workspace', mimeType: 'application/vnd.google-apps.folder' };
            let folderResp = await gapi.client.drive.files.create({ resource: folderMeta, fields: 'id' });
            driveFolderId = folderResp.result.id;
        }
        await fetchAllNotes();
        renderTree();
        $('syncStatus').className = 'status-dot online';
        toast('雲端同步完成');
    } catch (err) {
        console.error(err);
        toast('同步失敗，請檢查權限');
        $('syncStatus').className = 'status-dot';
    }
}

// 2. 抓取資料夾內所有筆記
async function fetchAllNotes() {
    database = {};
    fileMeta = {};
    
    let response = await gapi.client.drive.files.list({
        q: `'${driveFolderId}' in parents and mimeType='application/json' and trashed=false`,
        fields: 'files(id, name, createdTime, modifiedTime)',
        pageSize: 1000
    });
    
    const files = response.result.files || [];
    for (const f of files) {
        fileMeta[f.id] = { 
            name: f.name.replace('.json', ''), 
            created: f.createdTime, 
            modified: f.modifiedTime 
        };
        // 背景非同步下載內容
        fetchFileContent(f.id); 
    }
}

// 3. 讀取單一筆記內容
async function fetchFileContent(fileId) {
    try {
        let resp = await gapi.client.drive.files.get({ fileId: fileId, alt: 'media' });
        database[fileId] = resp.result; // Parse JSON array
    } catch (e) {
        console.error(`無法讀取檔案 ${fileId}`, e);
        database[fileId] = [];
    }
}

// 4. 新增或更新筆記 (Auto-Save 核心)
async function saveToDrive(fileId) {
    if (!driveFolderId) return;
    $('syncStatus').className = 'status-dot syncing';
    
    const content = JSON.stringify(database[fileId]);
    const token = gapi.client.getToken().access_token;
    
    try {
        if (!fileMeta[fileId].isNew) {
            // 更新現有檔案 (Media Upload via Fetch)
            await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
                method: 'PATCH',
                headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: content
            });
        } else {
            // 建立新檔案 (Multipart Upload 簡化版)
            const metadata = { name: `${fileMeta[fileId].name}.json`, parents: [driveFolderId] };
            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
            form.append('file', new Blob([content], { type: 'application/json' }));
            
            let res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: form
            });
            let data = await res.json();
            
            // 更新 ID 映射
            const oldId = fileId;
            const newId = data.id;
            database[newId] = database[oldId];
            fileMeta[newId] = fileMeta[oldId];
            fileMeta[newId].isNew = false;
            delete database[oldId];
            delete fileMeta[oldId];
            if (currentFileId === oldId) currentFileId = newId;
            renderTree();
        }
        $('syncStatus').className = 'status-dot online';
    } catch (e) {
        console.error('儲存失敗', e);
        $('syncStatus').className = 'status-dot';
        toast('儲存失敗，請檢查網路');
    }
}

// ─── UI & Editor Logic ───────────────────────────────────

function createNewNote() {
    if (!driveFolderId) { toast('請先登入 Google 雲端'); return; }
    
    const tempId = uid('file');
    const noteName = '新筆記 ' + new Date().toLocaleTimeString();
    fileMeta[tempId] = { name: noteName, isNew: true };
    database[tempId] = [{ id: uid('b'), content: '', indent: 0 }];
    
    renderTree();
    openNote(tempId);
    saveToDrive(tempId); // 觸發首次建立
}

function renderTree() {
    const tree = $('noteTree');
    tree.innerHTML = '';
    Object.entries(fileMeta).forEach(([id, meta]) => {
        const li = document.createElement('li');
        li.className = 'tree-item' + (id === currentFileId ? ' active' : '');
        li.textContent = meta.name;
        li.onclick = () => openNote(id);
        tree.appendChild(li);
    });
}

function openNote(fileId) {
    currentFileId = fileId;
    renderTree();
    
    const titleInput = $('noteTitle');
    titleInput.disabled = false;
    titleInput.value = fileMeta[fileId].name;
    
    titleInput.oninput = () => {
        fileMeta[fileId].name = titleInput.value;
        renderTree();
        triggerAutoSave();
    };
    
    renderBlocks();
    updateStats();
}

function renderBlocks() {
    const container = $('blocksContainer');
    container.innerHTML = '';
    
    if (!database[currentFileId]) {
        container.innerHTML = '<div class="empty-state">載入中...</div>';
        return;
    }
    
    const blocks = database[currentFileId];
    blocks.forEach((blk, index) => {
        const div = document.createElement('div');
        div.className = 'block';
        div.style.marginLeft = (blk.indent * 24) + 'px';
        
        div.innerHTML = `
            <div class="block-controls">
                <span class="block-drag">⋮⋮</span>
                <span class="block-bullet">•</span>
            </div>
            <div class="block-content" contenteditable="true" data-idx="${index}">${blk.content}</div>
        `;
        
        const editor = div.querySelector('.block-content');
        editor.oninput = (e) => {
            blocks[index].content = e.target.innerHTML;
            triggerAutoSave();
        };
        // 支援 Enter 新增區塊
        editor.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                blocks.splice(index + 1, 0, { id: uid('b'), content: '', indent: blk.indent });
                renderBlocks();
                $$('.block-content')[index + 1].focus();
                triggerAutoSave();
            } else if (e.key === 'Backspace' && editor.innerHTML === '' && blocks.length > 1) {
                e.preventDefault();
                blocks.splice(index, 1);
                renderBlocks();
                $$('.block-content')[Math.max(0, index - 1)].focus();
                triggerAutoSave();
            } else if (e.key === 'Tab') {
                e.preventDefault();
                if (e.shiftKey) {
                    blocks[index].indent = Math.max(0, (blocks[index].indent || 0) - 1);
                } else {
                    blocks[index].indent = (blocks[index].indent || 0) + 1;
                }
                renderBlocks();
                $$('.block-content')[index].focus();
                triggerAutoSave();
            }
        };
        container.appendChild(div);
    });
}

function triggerAutoSave() {
    if (!currentFileId) return;
    clearTimeout(saveTimer);
    $('syncStatus').className = 'status-dot syncing';
    saveTimer = setTimeout(() => {
        saveToDrive(currentFileId);
        updateStats();
    }, 1500); // 1.5秒防抖
}

function updateStats() {
    if (!currentFileId || !database[currentFileId]) return;
    const blocks = database[currentFileId];
    $('propBlocks').textContent = blocks.length;
    const text = blocks.map(b => b.content.replace(/<[^>]+>/g, '')).join('');
    $('propWords').textContent = text.length;
}

// ─── Event Listeners ─────────────────────────────────────
$('btnNewNote').onclick = createNewNote;
$('btnNewNoteMobile').onclick = createNewNote;

// Command Palette (簡化版)
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
        e.preventDefault();
        show($('cmdPalette'));
        $('cmdInput').focus();
    }
});
$('cmdPalette').onclick = (e) => { if(e.target.id === 'cmdPalette') hide($('cmdPalette')); };
