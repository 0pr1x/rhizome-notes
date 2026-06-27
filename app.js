/* =========================================================
   Nexus Notes Cloud Unified — Full Version
   ========================================================= */

'use strict';

// ─── 1. 設定與全域變數 ───────────────────────────────
const CLIENT_ID = '249300683470-vtgnnd73jvhe1ku7ckoftasrn8tesmfe.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let tokenClient;
let currentFileId = null;
let database = {};     // fileId → blocks[]
let fileMeta = {};     // fileId → { created, modified }
let saveTimer = null;  // 用於防抖動 (Debounce)

// ─── 2. 初始化與 Google Auth ─────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    // 載入 GAPI
    gapi.load('client', async () => {
        await gapi.client.init({ discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"] });
    });

    // 設定 OAuth2
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
            if (resp.error) return;
            loadDriveFiles(); // 登入後載入檔案列表
        },
    });

    bindGlobalEvents();
});

// ─── 3. 雲端存檔 (核心邏輯：防抖動) ──────────────────
function scheduleSave() {
    clearTimeout(saveTimer);
    // 顯示「同步中」的 UI 狀態 (如果有的話)
    const status = document.getElementById('lastSaved');
    if (status) status.innerText = "編輯中...";

    // 設定 2 秒後才觸發真正的儲存
    saveTimer = setTimeout(async () => {
        await uploadToDrive();
    }, 2000);
}

async function uploadToDrive() {
    if (!currentFileId) return;

    const content = JSON.stringify({
        blocks: database[currentFileId],
        meta: fileMeta[currentFileId]
    });

    try {
        await gapi.client.drive.files.update({
            fileId: currentFileId,
            uploadType: 'media',
            body: content
        });
        const status = document.getElementById('lastSaved');
        if (status) status.innerText = "已同步至雲端";
    } catch (e) {
        console.error("Save error:", e);
    }
}

// ─── 4. 編輯器核心邏輯 (從本地版移植) ────────────────
function renderBlocks(blocks) {
    const c = document.getElementById('blocksContainer');
    c.innerHTML = '';
    if (!blocks || !blocks.length) blocks = [{ id: uid(), content: '', indent: 0 }];
    
    blocks.forEach((block, index) => renderBlock(block, index, blocks, c));
}

function renderBlock(block, index, blocks, c) {
    const row = document.createElement('div');
    row.className = 'block-row';
    row.style.marginLeft = (block.indent || 0) + 'px';
     if (block._isHidden) {
        row.style.display = 'none';
    }
    // Drag handle
    const drag = document.createElement('div');
    drag.className = 'block-drag';
    drag.innerHTML = '⦙⦙';
    drag.draggable = true;
    drag.title = '拖曳排序';

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
    row.addEventListener('drop', async e => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (draggedIndex !== null && draggedIndex !== index) {

            // 1. 計算被拖曳的區塊一共包含多少個子區塊
            let count = 1;
            const parentIndent = blocks[draggedIndex].indent || 0;
            while (blocks[draggedIndex + count] && (blocks[draggedIndex + count].indent || 0) > parentIndent) {
                count++;
            }

            // 2. 取出整組區塊 (父區塊 + 所有子區塊)
            const movedGroup = blocks.splice(draggedIndex, count);

            // 3. 計算插入的新位置 (因為前面 splice 之後陣列長度變了，index 需要修正)
            let targetIndex = index;
            if (draggedIndex < targetIndex) {
                targetIndex -= count;
                if (targetIndex < 0) targetIndex = 0;
            }

            // 4. 將整組區塊插入新位置
            blocks.splice(targetIndex, 0, ...movedGroup);

            renderBlocks(blocks);
            scheduleSave();
        }
        draggedIndex = null;
    });
    // 【核心新增 2】：建立摺疊/展開按鈕
    const foldToggle = document.createElement('div');
    foldToggle.className = 'block-fold-toggle';
    foldToggle.style.cssText = 'width:14px; height:14px; display:flex; align-items:center; justify-content:center; cursor:pointer; user-select:none; font-size:10px; color:var(--text3); margin-right:4px;';
    // 檢查是否有子區塊：下一個區塊存在且其縮排大於當前區塊
    const hasChildren = blocks[index + 1] && (blocks[index + 1].indent || 0) > (block.indent || 0);

    if (hasChildren) {
        foldToggle.innerHTML = block.collapsed ? '▶' : '▼';
        foldToggle.title = block.collapsed ? '展開子區塊' : '摺疊子區塊';
        foldToggle.addEventListener('click', () => {
            block.collapsed = !block.collapsed; // 切換狀態
            renderBlocks(blocks);              // 重新計算並重新渲染
            scheduleSave();                    // 觸發存檔
        });
    } else {
        foldToggle.innerHTML = ''; // 沒有子區塊時保持空白，但保留 14px 寬度以利子母項目完美對齊
    }
    // Bullet / type indicator
    const bullet = document.createElement('div');
    bullet.className = 'block-bullet';
    if (block.type === 'image') {
        bullet.innerHTML = '🖼';
    } else if (block.todo !== undefined) {
        bullet.innerHTML = '';  // checkbox rendered in editor
    } else {
        bullet.innerHTML = '•';
        bullet.title = '按住點擊轉換類型';
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
        editor.contentEditable = 'true';
        editor.innerHTML = renderInlineMarkdown(block.content || '');

        editor.addEventListener('keydown', e => handleBlockKeydown(e, block, index, blocks, c));
        editor.addEventListener('input', () => {
            block.content = editor.innerHTML;
            scheduleSave();
            updateStatsDebounced();
            refreshInlineRender(editor);
        });
        editor.addEventListener('blur', () => {
            block.content = editor.innerHTML;
            scheduleSave();
            updateOutline();
        });
        editor.addEventListener('paste', e => handlePaste(e, block, index, blocks));
        editor.addEventListener('focus', () => {
            $('editorToolbar') && show($('editorToolbar'));
        });
    }

    row.appendChild(drag);
    row.appendChild(foldToggle); // 插入摺疊扭
    row.appendChild(bullet);
    row.appendChild(editor);
    c.appendChild(row);

    // ... 這裡貼上你原本的 renderBlock 完整程式碼 ...
    // 注意：原本監聽 input 的地方，務必改為呼叫 scheduleSave()
    // 範例：
    // editor.addEventListener('input', () => {
    //     block.content = editor.innerHTML;
    //     scheduleSave(); // 呼叫這裡，而不是直接同步
    // });
}

// ─── 5. 工具函式 ─────────────────────────────────────
const uid = (p = 'b') => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const $ = id => document.getElementById(id);

function toast(msg, duration = 2200) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), duration);
}

// ─── 6. Drive 檔案操作 ──────────────────────────────
async function loadDriveFiles() {
    const resp = await gapi.client.drive.files.list({
        q: "mimeType = 'application/json' and trashed = false",
        fields: "files(id, name)"
    });
    // renderNoteTree(resp.result.files); 這裡呼叫你的渲染選單邏輯
}

async function openNote(fileId) {
    currentFileId = fileId;
    const resp = await gapi.client.drive.files.get({ fileId: fileId, alt: 'media' });
    database[fileId] = resp.result.blocks;
    fileMeta[fileId] = resp.result.meta;
    renderBlocks(database[fileId]);
}

// ─── 7. 事件綁定 ─────────────────────────────────────
function bindGlobalEvents() {
    $('btnOpenFolder').addEventListener('click', selectWorkspace);
    //$('welcomeOpenFolder').addEventListener('click', selectWorkspace);
    $('btnNewNote').addEventListener('click', createNewNotePrompt);
    $('btnNewFolder')?.addEventListener('click', createNewFolderPrompt);
    $('textColorPicker')?.addEventListener('input', e => {
        document.execCommand('foreColor', false, e.target.value);
        scheduleSave();
    });
    $('btnNewNoteMobile').addEventListener('click', createNewNotePrompt);
    //$('btnRefresh').addEventListener('click', scanAndBuild);
    $('btnRefresh').addEventListener('click', smartRefresh);
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

    // Search
    $('topSearch').addEventListener('input', e => handleSearch(e.target.value));
    $('topSearch').addEventListener('keydown', e => {
        if (e.key === 'Escape') { $('topSearch').value = ''; handleSearch(''); }
    });

    // Command palette
    $('cmdInput').addEventListener('input', filterCmdResults);
    $('cmdInput').addEventListener('keydown', handleCmdKeydown);
    $$('#cmdResults .cmd-item').forEach(item => {
        item.addEventListener('click', () => runCmdAction(item.dataset.action));
    });

    // Export buttons
    $('exportMd').addEventListener('click', () => doExport('md'));
    $('exportJson').addEventListener('click', () => doExport('json'));
    $('exportTxt').addEventListener('click', () => doExport('txt'));
    $('exportCopy').addEventListener('click', () => doExport('copy'));

    // Panel tabs
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

    // Toolbar buttons
    $$('.toolbar-btn').forEach(btn => {
        btn.addEventListener('mousedown', e => {
            e.preventDefault(); // prevent losing focus from editor
            if (btn.dataset.format) {
                document.execCommand(btn.dataset.format, false, null);
            } else if (btn.dataset.cmd) {
                applyBlockCommand(btn.dataset.cmd);
            }
        });
    });

    // Global keyboard shortcuts
    document.addEventListener('keydown', handleGlobalShortcut);

    // Click outside to close modals
    $('cmdPalette').addEventListener('click', e => { if (e.target === $('cmdPalette')) closeCmdPalette(); });
    $('graphModal').addEventListener('click', e => { if (e.target === $('graphModal')) hide($('graphModal')); });
    $('exportModal').addEven
}
