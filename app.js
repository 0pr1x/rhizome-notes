/* =========================================================
   Nexus Notes v4.0 — Application Logic
   Features: Blocks, Wiki-links, Backlinks, Graph, Outline,
             Tags, Export, Markdown paste, Image handling,
             Manual save (cloud), Theme, Command Palette, Search
   ========================================================= */

'use strict';

// ─── State ───────────────────────────────────────────────
let database = {};      // fileId → blocks[]
let fileMeta = {};      // fileId → { created, modified }
let tagIndex = {};      // tag → Set<fileId>
let fileHandleMap = {};      // fileId → FileSystemFileHandle | { driveId }
let dirHandle = null;
let currentFileId = null;
let draggedIndex = null;
let saveTimer = null;
let noteTree = [];      // raw tree structure
let isDirty = false;
let isSaving = false;

const isCloudMode = !!(window.RHIZOME_CONFIG?.USE_DRIVE);
const DB_NAME = 'NexusNotesV4';

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
/**
 * 刪除指定區塊及其所有子孫區塊（級聯刪除）
 */
function deleteBlockAndChildren(index, blocks) {
    const parentIndent = blocks[index].indent || 0;
    let countToDelete = 1;

    // 只要後續區塊的縮排嚴格大於父區塊，就代表是子孫區塊
    while (index + countToDelete < blocks.length && (blocks[index + countToDelete].indent || 0) > parentIndent) {
        countToDelete++;
    }

    // 一次性從陣列中剔除父區塊與所有子區塊
    blocks.splice(index, countToDelete);

    // 安全防禦：如果筆記被全刪光了，自動補一個空白基礎區塊
    if (blocks.length === 0) {
        blocks.push({ id: uid(), content: '', indent: 0 });
    }
}
// ─── Init ─────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);

async function init() {
    applyStorageModeUI();
    bindGlobalEvents();
    if (isCloudMode) {
        const restored = await window.RhizomeDrive?.tryRestoreSession();
        if (restored) await scanAndBuildFromDrive();
    } else {
        await tryRestoreHandle();
    }
    registerServiceWorker();
    window.addEventListener('beforeunload', e => {
        if (isCloudMode && isDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

function applyStorageModeUI() {
    const label = $('btnOpenFolderLabel');
    if (label) label.textContent = isCloudMode ? '連接 Google Drive' : '開啟資料夾';
}

function isWorkspaceReady() {
    return isCloudMode ? window.RhizomeDrive?.isConnected() : !!dirHandle;
}

function registerServiceWorker() {
    // Future: offline support
}

// ─── Event Bindings ──────────────────────────────────────
function bindGlobalEvents() {
    $('btnOpenFolder').addEventListener('click', isCloudMode ? connectGoogleDrive : selectWorkspace);
    $('btnSave')?.addEventListener('click', () => saveToDisk(true));
    //$('welcomeOpenFolder').addEventListener('click', selectWorkspace);
    $('btnNewNote').addEventListener('click', createNewNotePrompt);
    $('btnNewFolder')?.addEventListener('click', createNewFolderPrompt);
    $('textColorPicker')?.addEventListener('input', e => {
        document.execCommand('foreColor', false, e.target.value);
        markDirty();
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
    $('mobileSearch')?.addEventListener('input', e => handleSearch(e.target.value));
    $('mobileSearch')?.addEventListener('keydown', e => {
        if (e.key === 'Escape') { $('mobileSearch').value = ''; handleSearch(''); }
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
    $('exportModal').addEventListener('click', e => { if (e.target === $('exportModal')) hide($('exportModal')); });
}

function handleGlobalShortcut(e) {
    const tag = document.activeElement.tagName.toLowerCase();
    const inEditor = tag === 'div' && document.activeElement.contentEditable === 'true';

    // ⌘K or Ctrl+K → command palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openCmdPalette();
        return;
    }
    // Ctrl+S → manual save
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (isCloudMode && isDirty) saveToDisk(true);
        else if (!isCloudMode) saveToDisk(true);
        return;
    }
    // Escape closes modals
    if (e.key === 'Escape') {
        closeCmdPalette();
        hide($('graphModal'));
        hide($('exportModal'));
        toggleMobileDrawer(false);
        return;
    }
    // '/' focuses search when not in editor
    if (e.key === '/' && !inEditor && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        $('topSearch').focus();
    }
}

// ─── Workspace & File System ──────────────────────────────
async function connectGoogleDrive() {
    try {
        toast('🔑 正在連接 Google Drive…');
        await window.RhizomeDrive.signIn();
        await scanAndBuildFromDrive();
        toast('✅ 已連接 Google Drive');
    } catch (e) {
        console.error(e);
        toast('⚠️ ' + (e.message || '無法連接 Google Drive'));
    }
}

async function scanAndBuildFromDrive() {
    if (!window.RhizomeDrive?.isConnected()) {
        renderTreeUI([]);
        return;
    }
    database = {};
    fileHandleMap = {};
    fileMeta = {};
    tagIndex = {};
    currentFileId = null;
    window.RhizomeDrive.clearRegistry();

    const folderId = window.RhizomeDrive.workspaceFolderId;
    noteTree = await window.RhizomeDrive.buildTreeFromDrive(folderId, '');

    await window.RhizomeDrive.loadAllNotes(noteTree, async (fileId, driveId) => {
        try {
            const text = await window.RhizomeDrive.readFileText(driveId);
            let data = {};
            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                data = {};
            }
            const blocks = Array.isArray(data.blocks)
                ? data.blocks
                : Array.isArray(data)
                    ? data
                    : [{ id: uid(), content: '', indent: 0 }];
            const meta = data.meta || {};
            database[fileId] = blocks;
            fileMeta[fileId] = {
                created: meta.created || Date.now(),
                modified: meta.modified || Date.now(),
                tags: meta.tags || [],
                wordCount: 0,
            };
            fileHandleMap[fileId] = { driveId };
            window.RhizomeDrive.registerFile(fileId, driveId);
            (meta.tags || []).forEach(tag => {
                if (!tagIndex[tag]) tagIndex[tag] = new Set();
                tagIndex[tag].add(fileId);
            });
        } catch (err) {
            console.warn('[Rhizome] Drive read failed:', fileId, err);
        }
    });

    finishScanUI();

    const ids = Object.keys(database);
    if (ids.length) {
        ids.forEach(fid => relinkBacklinksForFile(fid));
        await switchNote(ids[0]);
    } else {
        clearDirty();
    }
}

function relinkBacklinksForFile(fid) {
    const blocks = database[fid];
    if (!blocks) return;
    const anchorIndices = [];
    blocks.forEach((b, i) => {
        if (b._backlinkSync) anchorIndices.push(i);
    });
    if (!anchorIndices.length) return;
    anchorIndices.reverse().forEach(anchorIndex => {
        let endIndex = anchorIndex + 1;
        while (endIndex < blocks.length && blocks[endIndex]._backlinkGenerated) endIndex++;
        blocks.splice(anchorIndex + 1, endIndex - anchorIndex - 1);
        const prevFileId = currentFileId;
        currentFileId = fid;
        insertBacklinksToCurrentBlock(anchorIndex, blocks);
        currentFileId = prevFileId;
    });
    database[fid] = blocks;
}

function finishScanUI() {
    renderTreeUI(noteTree);
    const badge = $('syncStatus');
    badge.textContent = '● 已同步';
    badge.classList.add('synced');
    show($('sidebarActions'));
    const drawerActions = $('drawerActions');
    if (drawerActions) drawerActions.style.display = isWorkspaceReady() ? '' : 'none';
}

async function selectWorkspace() {
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await storeHandle(dirHandle);
        await scanAndBuild();
    } catch (e) {
        if (e.name !== 'AbortError') toast('⚠️ 無法開啟資料夾');
    }
}

function storeHandle(handle) {
    return new Promise((resolve) => {
        if (!window.indexedDB) return resolve();
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('data');
        req.onsuccess = () => {
            const tx = req.result.transaction('data', 'readwrite');
            tx.objectStore('data').put(handle, 'rootHandle');
            tx.oncomplete = resolve;
        };
        req.onerror = resolve;
    });
}

async function tryRestoreHandle() {
    if (!window.indexedDB) return;
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('data');
    req.onsuccess = async () => {
        const tx = req.result.transaction('data', 'readonly');
        const get = tx.objectStore('data').get('rootHandle');
        get.onsuccess = async () => {
            const h = get.result;
            if (!h) return;
            try {
                const perm = await h.queryPermission({ mode: 'readwrite' });
                if (perm === 'granted') {
                    dirHandle = h;
                    await scanAndBuild();
                } else {
                    const badge = $('syncStatus');
                    badge.innerHTML = '<button onclick="' + (isCloudMode ? 'connectGoogleDrive' : 'selectWorkspace') + '()" style="color:var(--accent);font-weight:600">⚡ 點擊授權</button>';
                }
            } catch { /* handle may be stale */ }
        };
    };
}

async function scanAndBuild() {
    if (isCloudMode) {
        await scanAndBuildFromDrive();
        return;
    }
    if (!dirHandle) { renderTreeUI([]); return; }
    database = {}; fileHandleMap = {}; fileMeta = {}; tagIndex = {};
    currentFileId = null;

    noteTree = await buildTree(dirHandle, '');
    finishScanUI();

    const ids = Object.keys(database);
    if (ids.length) {
        ids.forEach(fid => relinkBacklinksForFile(fid));
        await switchNote(ids[0]);
    }
}
async function smartRefresh() {
    if (isCloudMode) {
        if (!window.RhizomeDrive?.isConnected()) {
            await connectGoogleDrive();
            return;
        }
        await scanAndBuildFromDrive();
        toast('🔄 已重新載入');
        return;
    }
    if (!dirHandle) {
        // 完全沒有 handle，走完整選資料夾流程
        await selectWorkspace();
        return;
    }

    // 有 handle，先確認權限狀態
    const perm = await dirHandle.queryPermission({ mode: 'readwrite' });

    if (perm === 'granted') {
        // 權限正常，直接掃描取得最新
        await scanAndBuild();

    } else {
        // 需要重新授權
        toast('🔑 請授權後重新整理…');
        try {
            const newPerm = await dirHandle.requestPermission({ mode: 'readwrite' });
            if (newPerm === 'granted') {
                await scanAndBuild();
            } else {
                toast('⚠️ 未取得授權');
            }
        } catch {
            toast('⚠️ 授權失敗，請重新選取資料夾');
            dirHandle = null;
        }
    }
}
async function buildTree(dirH, relPath) {
    const nodes = [];
    const SKIP_DIRS = new Set(['.git', 'node_modules', 'image', '.obsidian', '.trash']);

    for await (const entry of dirH.values()) {
        if (entry.kind === 'directory') {
            if (SKIP_DIRS.has(entry.name)) continue;
            const children = await buildTree(entry, relPath + entry.name + '/');
            nodes.push({ name: entry.name, kind: 'directory', children, path: relPath + entry.name });
        } else if (entry.kind === 'file' && entry.name.endsWith('.json')) {
            try {
                const file = await entry.getFile();
                const text = await file.text();
                let data = {};
                try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

                const fileId = relPath + entry.name;
                const blocks = Array.isArray(data.blocks) ? data.blocks
                    : Array.isArray(data) ? data  // legacy format
                        : [{ id: uid(), content: '', indent: 0 }];

                const meta = data.meta || {};
                database[fileId] = blocks;
                fileMeta[fileId] = {
                    created: meta.created || file.lastModified,
                    modified: meta.modified || file.lastModified,
                    tags: meta.tags || [],
                    wordCount: 0,
                };
                fileHandleMap[fileId] = entry;

                // Index tags
                (meta.tags || []).forEach(tag => {
                    if (!tagIndex[tag]) tagIndex[tag] = new Set();
                    tagIndex[tag].add(fileId);
                });

                nodes.push({ name: entry.name, kind: 'file', fileId });
            } catch (err) { console.warn('[Nexus] Read failed:', entry.name, err); }
        }
    }
    nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-TW') : (a.kind === 'directory' ? -1 : 1));
    return nodes;
}

// ─── Tree UI ─────────────────────────────────────────────
function renderTreeUI(tree) {
    const root = $('noteTree');
    const mobile = $('noteTreeMobile');
    root.innerHTML = '';
    mobile.innerHTML = '';

    if (!Object.keys(database).length && isWorkspaceReady()) {
        root.innerHTML = '<li class="tree-empty"><div>資料夾中無 .json 筆記<br>點擊「新增筆記」開始</div></li>';
        return;
    }

    function buildNodes(nodes, parentEl, isMobile) {
        nodes.forEach(n => {
            const li = document.createElement('li');

            if (n.kind === 'directory') {
                // 🌟 新增：讓資料夾帶有 tree-folder class 與路徑資料 🌟
                li.className = 'tree-folder';
                li.dataset.path = n.path || '';

                const dir = document.createElement('div');
                dir.className = 'tree-dir';
                dir.innerHTML = `<span class="tree-dir-icon">▶</span> <span>📂 ${n.name}</span>`;
                const ul = document.createElement('ul');
                let collapsed = false;
                dir.addEventListener('click', () => {
                    collapsed = !collapsed;
                    ul.style.display = collapsed ? 'none' : '';
                    dir.querySelector('.tree-dir-icon').textContent = collapsed ? '▶' : '▼';
                });
                dir.querySelector('.tree-dir-icon').textContent = '▼';
                li.appendChild(dir);
                li.appendChild(ul);
                parentEl.appendChild(li);
                buildNodes(n.children, ul, isMobile);
            } else {
                // 🌟 新增：讓檔案帶有 tree-item class，並開啟 draggable 🌟
                li.className = 'tree-item';
                li.draggable = true;
                li.dataset.id = n.fileId;

                const btn = document.createElement('button');
                btn.className = 'tree-file-btn' + (n.fileId === currentFileId ? ' active' : '');
                const label = n.name.replace('.json', '');
                btn.innerHTML = `<span class="tree-file-name" title="${label}">📄 ${label}</span>`;
                btn.addEventListener('click', () => {
                    if (isMobile) toggleMobileDrawer(false);
                    switchNote(n.fileId);
                });
                li.appendChild(btn);
                parentEl.appendChild(li);
            }
        });
    }

    buildNodes(tree, root, false);
    buildNodes(tree, mobile, true);
}

function refreshTreeHighlight() {
    $$('.tree-file-btn').forEach(btn => {
        btn.classList.toggle('active',
            btn.closest('li')?.querySelector('.tree-file-name')?.title === currentFileId?.replace('.json', '').split('/').pop());
    });
    // More reliable: re-render
    renderTreeUI(noteTree);
}

// ─── Note CRUD ────────────────────────────────────────────
async function confirmLeaveUnsaved() {
    if (!isCloudMode || !isDirty) return true;
    const choice = confirm('此筆記有未儲存的變更。\n\n按「確定」放棄變更並離開\n按「取消」留在目前筆記');
    if (choice) clearDirty();
    return choice;
}

async function switchNote(fileId) {
    if (currentFileId && currentFileId !== fileId) {
        const ok = await confirmLeaveUnsaved();
        if (!ok) return;
    }
    currentFileId = fileId;
    const title = fileId.split('/').pop().replace('.json', '');
    $('noteTitle').textContent = title;
    $('noteTitle').contentEditable = 'true';
    $('noteMeta').textContent = `📁 ./${fileId}`;

    renderTreeUI(noteTree);
    renderBlocks(database[fileId] || []);
    updateStats();
    updateOutline();
    updatePropsPanel();
    renderTags();
    computeAndShowBacklinks(fileId);

    hide($('welcomeScreen'));
    hide($('searchResults'));
    show($('blocksContainer'));
    show($('editorToolbar'));
    show($('noteHeader'));
    updateSaveButtonVisibility();
    clearDirty();

    // Handle note title rename
    $('noteTitle').addEventListener('blur', renameCurrentNote, { once: true });
}

async function renameCurrentNote() {
    if (!currentFileId || !isWorkspaceReady()) return;
    const newName = $('noteTitle').textContent.trim();
    if (!newName) return;
    const ext = '.json';
    const oldName = currentFileId.split('/').pop();
    const newFileName = newName + ext;
    if (oldName === newFileName) return;
    try {
        if (isCloudMode) {
            await window.RhizomeDrive.renameNote(currentFileId, newFileName);
            const pathParts = currentFileId.split('/');
            pathParts[pathParts.length - 1] = newFileName;
            const newFileId = pathParts.join('/');
            database[newFileId] = database[currentFileId];
            fileMeta[newFileId] = fileMeta[currentFileId];
            fileHandleMap[newFileId] = fileHandleMap[currentFileId];
            window.RhizomeDrive.registerFile(newFileId, fileHandleMap[newFileId].driveId, newFileName);
            delete database[currentFileId];
            delete fileMeta[currentFileId];
            delete fileHandleMap[currentFileId];
            await scanAndBuildFromDrive();
            await switchNote(newFileId);
        } else {
            const oldFh = fileHandleMap[currentFileId];
            const oldFile = await oldFh.getFile();
            const content = await oldFile.text();
            const newFh = await dirHandle.getFileHandle(newFileName, { create: true });
            const w = await newFh.createWritable();
            await w.write(content);
            await w.close();
            await dirHandle.removeEntry(oldName);
            await scanAndBuild();
            await switchNote(newFileName);
        }
        toast(`✅ 已重新命名為 ${newName}`);
    } catch (e) {
        toast('⚠️ 重新命名失敗');
        $('noteTitle').textContent = currentFileId.split('/').pop().replace('.json', '');
    }
}

async function createNewNotePrompt() {
    const name = prompt('新筆記名稱 (不需 .json 副檔名):');
    if (!name || !name.trim()) return;
    if (!isWorkspaceReady()) return alert(isCloudMode ? '請先連接 Google Drive' : '請先選取工作資料夾');
    const fileName = name.trim().replace(/[/\\:*?"<>|]/g, '-') + '.json';
    try {
        const initial = {
            meta: { created: Date.now(), modified: Date.now(), tags: [] },
            blocks: [{ id: uid(), content: '', indent: 0 }]
        };
        const json = JSON.stringify(initial, null, 2);
        if (isCloudMode) {
            await window.RhizomeDrive.createNote(fileName, json);
            await scanAndBuildFromDrive();
            await switchNote(fileName);
        } else {
            const fh = await dirHandle.getFileHandle(fileName, { create: true });
            const w = await fh.createWritable();
            await w.write(json);
            await w.close();
            await scanAndBuild();
            await switchNote(fileName);
        }
        toast('📝 新筆記已建立');
    } catch (e) { toast('⚠️ 建立失敗: ' + e.message); }
}
async function createNewFolderPrompt() {
    if (!isWorkspaceReady()) return alert(isCloudMode ? '請先連接 Google Drive' : '請先選取工作資料夾');
    const name = prompt('新資料夾名稱:');
    if (!name || !name.trim()) return;
    try {
        if (isCloudMode) {
            await window.RhizomeDrive.createFolder(name.trim());
            await scanAndBuildFromDrive();
        } else {
            await dirHandle.getDirectoryHandle(name.trim(), { create: true });
            await scanAndBuild();
        }
        toast('📁 資料夾已建立');
    } catch (e) {
        toast('⚠️ 建立失敗: ' + e.message);
    }
}
async function deleteCurrentNote() {
    if (!currentFileId || !isWorkspaceReady()) return;
    const name = currentFileId.split('/').pop().replace('.json', '');
    if (!confirm(`確認刪除「${name}」？此操作不可逆。`)) return;
    try {
        if (isCloudMode) {
            await window.RhizomeDrive.deleteNote(currentFileId);
            await scanAndBuildFromDrive();
        } else {
            await dirHandle.removeEntry(currentFileId.split('/').pop());
            await scanAndBuild();
        }
        currentFileId = null;
        hide($('blocksContainer'));
        hide($('noteHeader'));
        hide($('editorToolbar'));
        hide($('btnSave'));
        show($('welcomeScreen'));
        clearDirty();
        toast('🗑️ 已刪除');
    } catch (e) { toast('⚠️ 刪除失敗'); }
}

// ─── Block Rendering ─────────────────────────────────────
function renderBlocks(blocks) {
    const c = $('blocksContainer');
    c.innerHTML = '';

    if (!blocks || !blocks.length) {
        blocks = [{ id: uid(), content: '', indent: 0 }];
        database[currentFileId] = blocks;
    }

    // ★ 核心補強：在渲染前，遍歷所有區塊來動態計算每個區塊的 _isHidden 狀態
    let skipIndentLevel = Infinity;
    blocks.forEach((block) => {
        const currentIndent = block.indent || 0;

        // 如果目前區塊的縮排小於等於跳過層級，說明已經離開摺疊父區塊的子代範圍了
        if (currentIndent <= skipIndentLevel) {
            skipIndentLevel = Infinity;
        }

        // 根據跳過層級決定是否隱藏
        if (skipIndentLevel !== Infinity) {
            block._isHidden = true;
        } else {
            block._isHidden = false;
        }

        // 如果目前區塊本身是被摺疊的，就把跳過層級鎖定在目前的縮排
        if (block.collapsed) {
            skipIndentLevel = Math.min(skipIndentLevel, currentIndent);
        }
    });

    // 計算完狀態後，才真正開始渲染
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
}

function cycleBlockType(block, index, blocks) {
    // Toggle heading level or back to normal
    const content = block.content || '';
    if (!content.trim()) return;
    const stripped = content.replace(/<\/?h[1-3][^>]*>/g, '').replace(/<br\s*\/?>/gi, '').trim();
    if (!block._headingLevel) block._headingLevel = 1;
    else block._headingLevel = (block._headingLevel % 3) + 1;
    const tag = 'h' + block._headingLevel;
    block.content = `<${tag}>${stripped}</${tag}>`;
    renderBlocks(blocks);
    scheduleSave();
}

// ─── Inline Markdown ─────────────────────────────────────
function renderInlineMarkdown(html) {
    if (!html) return '';
    // Preserve existing HTML structure but enhance with inline patterns
    // Run only on text nodes to avoid corrupting existing HTML
    return html;
}

function refreshInlineRender(editor) {
    // Real-time wiki-link highlighting
    // We do a lightweight scan after typing stops
    clearTimeout(editor._ilTimer);
    editor._ilTimer = setTimeout(() => {
        // just update stats; full render on blur to avoid cursor jump
    }, 300);
}

function parseMarkdownToHtml(md) {
    const lines = md.split('\n');
    let inTable = false, tableBuffer = '', inCodeBlock = false, codeBuffer = '';
    const out = [];

    for (let raw of lines) {
        const line = raw.trimEnd();

        // Code fences
        if (line.startsWith('```')) {
            if (inCodeBlock) {
                out.push(`<pre><code class="code-block">${escHtml(codeBuffer)}</code></pre>`);
                codeBuffer = ''; inCodeBlock = false;
            } else { inCodeBlock = true; }
            continue;
        }
        if (inCodeBlock) { codeBuffer += (codeBuffer ? '\n' : '') + line; continue; }

        const trimmed = line.trim();
        if (trimmed.startsWith('|')) {
            if (trimmed.replace(/[\|\-\s:]/g, '').length === 0) continue; // separator row
            if (!inTable) { inTable = true; tableBuffer = '<table><thead><tr>'; }
            const cells = trimmed.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1);
            const tag = out.length === 0 || !inTable ? 'th' : 'td';
            if (tableBuffer.includes('<thead>') && !tableBuffer.includes('</thead>')) {
                cells.forEach(c => tableBuffer += `<th>${inlineFormat(c)}</th>`);
                tableBuffer += '</tr></thead><tbody>';
            } else {
                tableBuffer += '<tr>';
                cells.forEach(c => tableBuffer += `<td>${inlineFormat(c)}</td>`);
                tableBuffer += '</tr>';
            }
            continue;
        } else if (inTable) {
            tableBuffer += '</tbody></table>';
            out.push(tableBuffer);
            tableBuffer = ''; inTable = false;
        }

        if (trimmed === '---' || trimmed === '***' || trimmed === '___') { out.push('<hr>'); continue; }
        if (trimmed.startsWith('# ')) { out.push(`<h1>${inlineFormat(trimmed.slice(2))}</h1>`); continue; }
        if (trimmed.startsWith('## ')) { out.push(`<h2>${inlineFormat(trimmed.slice(3))}</h2>`); continue; }
        if (trimmed.startsWith('### ')) { out.push(`<h3>${inlineFormat(trimmed.slice(4))}</h3>`); continue; }
        if (trimmed.startsWith('> ')) { out.push(`<blockquote>${inlineFormat(trimmed.slice(2))}</blockquote>`); continue; }
        if (trimmed.startsWith('- [ ] ') || trimmed.startsWith('* [ ] ')) {
            out.push(`<span class="todo-item">☐ ${inlineFormat(trimmed.slice(6))}</span>`); continue;
        }
        if (trimmed.startsWith('- [x] ') || trimmed.startsWith('* [x] ')) {
            out.push(`<span class="todo-item done">☑ ${inlineFormat(trimmed.slice(6))}</span>`); continue;
        }
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
        .replace(/\[\[(.+?)\]\]/g, (_, p) => `<span class="wiki-link" data-target="${p}" onclick="handleWikiClick(event, '${p.replace(/'/g, "\\'")}')">${p}</span>`)
        .replace(/(^|\s)(#[\w\u4e00-\u9fa5]+)/g, '$1<span class="inline-tag" onclick="searchTag(\'$2\')">$2</span>')
        .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

window.connectGoogleDrive = connectGoogleDrive;
window.selectWorkspace = selectWorkspace;

window.handleWikiClick = function (e, name) {
    if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd + Click: Jump to note
        const target = Object.keys(database).find(id => id.replace('.json', '').split('/').pop() === name);
        if (target) switchNote(target);
        else if (confirm(`「${name}」尚未存在，要建立此筆記嗎？`)) {
            createNoteByName(name);
        }
    } else {
        // Normal Click: Search
        const searchInput = $('topSearch') || $('mobileSearch');
        if (searchInput) {
            searchInput.value = `[[${name}]]`;
            handleSearch(searchInput.value);
        }
    }
};

window.searchTag = function (tag) {
    $('topSearch').value = tag;
    handleSearch(tag);
};

async function createNoteByName(name) {
    if (!isWorkspaceReady()) return;
    const fileName = name.replace(/[/\\:*?"<>|]/g, '-') + '.json';
    const initial = { meta: { created: Date.now(), modified: Date.now(), tags: [] }, blocks: [{ id: uid(), content: '', indent: 0 }] };
    const json = JSON.stringify(initial, null, 2);
    if (isCloudMode) {
        await window.RhizomeDrive.createNote(fileName, json);
        await scanAndBuildFromDrive();
        await switchNote(fileName);
    } else {
        const fh = await dirHandle.getFileHandle(fileName, { create: true });
        const w = await fh.createWritable();
        await w.write(json);
        await w.close();
        await scanAndBuild();
        await switchNote(fileName);
    }
}

// ─── Todo Block ──────────────────────────────────────────
function renderTodoBlock(block, index, blocks, editor) {
    const wrap = document.createElement('div');
    wrap.className = 'todo-block';

    const box = document.createElement('div');
    box.className = 'todo-checkbox' + (block.todo ? ' checked' : '');
    box.textContent = block.todo ? '✓' : '';
    box.addEventListener('click', () => {
        block.todo = !block.todo;
        box.classList.toggle('checked', block.todo);
        box.textContent = block.todo ? '✓' : '';
        content.classList.toggle('checked', block.todo);
        scheduleSave();
    });

    const content = document.createElement('div');
    content.className = 'todo-content' + (block.todo ? ' checked' : '');
    content.contentEditable = 'true';
    content.innerHTML = block.content || '';
    content.addEventListener('input', () => { block.content = content.innerHTML; scheduleSave(); });
    content.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !content.innerText.trim()) {
            e.preventDefault();
            if (blocks.length > 1) {
                // 【修改這裡】：改用級聯刪除
                deleteBlockAndChildren(index, blocks);
            } else {
                blocks[0] = { id: uid(), content: '', indent: 0 };
            }
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

    wrap.appendChild(box);
    wrap.appendChild(content);
    editor.appendChild(wrap);
}

// ─── Image Block ─────────────────────────────────────────
function renderImageBlock(block, index, blocks, editor) {
    const wrap = document.createElement('div');
    wrap.className = 'image-block-wrap';

    const img = document.createElement('img');
    img.style.width = block.width || '320px';
    img.alt = '圖片';

    // 🔧 修正 1：把 dirHandle 條件放寬，讓 isCloudMode 也能進入此區塊
    if ((dirHandle || isCloudMode) && block.src && block.src.startsWith('./image/')) {
        const fileName = block.src.replace('./image/', '');
        (async () => {
            try {
                if (isCloudMode) {
                    // 🔧 修正 2：優先使用 driveImageId，若無則查詢並「回寫」儲存
                    const driveId = block.driveImageId || await window.RhizomeDrive.resolveImageDriveId(fileName);
                    if (driveId) {
                        block.driveImageId = driveId; // 記錄 ID，下次載入更快
                        img.src = await window.RhizomeDrive.getImageBlobUrl(driveId);
                    }
                    else img.alt = '❌ 圖片遺失';
                } else {
                    const imgDir = await dirHandle.getDirectoryHandle('image');
                    const imgFh = await imgDir.getFileHandle(fileName);
                    const f = await imgFh.getFile();
                    img.src = URL.createObjectURL(f);
                }
            } catch { img.alt = '❌ 圖片遺失'; }
        })();
    } else if (block._pendingImage) {
        img.src = URL.createObjectURL(block._pendingImage);
    } else {
        img.src = block.content || block.src || '';
    }

    const ctrl = document.createElement('div');
    ctrl.className = 'image-controls';

    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '80'; slider.max = '900';
    slider.value = parseInt(block.width) || 320;
    slider.addEventListener('input', () => {
        img.style.width = slider.value + 'px';
        block.width = slider.value + 'px';
        scheduleSave();
    });

    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px;color:var(--text3)';
    slider.addEventListener('input', () => { label.textContent = slider.value + 'px'; });
    label.textContent = (parseInt(block.width) || 320) + 'px';

    const del = document.createElement('button');
    del.className = 'image-del-btn';
    del.textContent = '🗑 刪除';
    del.addEventListener('click', () => {
        deleteBlockAndChildren(index, blocks);
        renderBlocks(blocks);
        scheduleSave();
    });

    ctrl.append(slider, label, del);
    wrap.append(img, ctrl);
    editor.appendChild(wrap);
}

// ─── Keyboard Handling ───────────────────────────────────
async function handleBlockKeydown(e, block, index, blocks, c) {
    // 1. 優先處理特殊指令 (確保放在第一位，且必須加上 !e.shiftKey)
    if (e.key === 'Enter' && !e.shiftKey && block.content.trim() === '/bl') {
        e.preventDefault();
        insertBacklinksToCurrentBlock(index, blocks);
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const newBlock = { id: uid(), content: '', indent: block.indent || 0 };
        blocks.splice(index + 1, 0, newBlock);
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
                // 【修改這裡】：改用級聯刪除
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
            renderBlocks(blocks);
            scheduleSave();
            setTimeout(() => focusBlock(index - 1), 10);
        }

    } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        if (index < blocks.length - 1) {
            [blocks[index], blocks[index + 1]] = [blocks[index + 1], blocks[index]];
            renderBlocks(blocks);
            scheduleSave();
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
    if (!focused || focused.className.indexOf('block-editor') < 0) return;
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
            let tableHtml = '<table>';
            tableHtml += '<thead><tr>' + Array(cols).fill('<th>欄位</th>').join('') + '</tr></thead>';
            tableHtml += '<tbody>';
            for (let r = 0; r < rows - 1; r++) tableHtml += '<tr>' + Array(cols).fill('<td>&nbsp;</td>').join('') + '</tr>';
            tableHtml += '</tbody></table>';
            document.execCommand('insertHTML', false, tableHtml);
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
        const wrapper = document.createElement(tag);
        range.surroundContents(wrapper);
    }
}

function getBlockIndex(editorEl) {
    const row = editorEl.closest('.block-row');
    if (!row) return -1;
    const c = $('blocksContainer');
    return Array.from(c.children).indexOf(row);
}

// ─── Paste Handler ───────────────────────────────────────
async function handlePaste(e, block, index, blocks) {
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items || [];
    for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
            e.preventDefault();
            const file = it.getAsFile();
            if (!isWorkspaceReady()) { toast('⚠️ 請先連結工作區'); return; }
            const imgName = `img_${Date.now()}.png`;
            if (isCloudMode) {
                blocks.splice(index + 1, 0, {
                    id: uid(), type: 'image',
                    src: `./image/${imgName}`,
                    _pendingImage: file,
                    width: '320px', indent: block.indent || 0
                });
                renderBlocks(blocks);
                markDirty();
                toast('🖼️ 圖片已加入（請按儲存上傳）');
            } else {
                try {
                    const imgDir = await dirHandle.getDirectoryHandle('image', { create: true });
                    const imgFh = await imgDir.getFileHandle(imgName, { create: true });
                    const w = await imgFh.createWritable();
                    await w.write(file);
                    await w.close();
                    blocks.splice(index + 1, 0, {
                        id: uid(), type: 'image',
                        src: `./image/${imgName}`, width: '320px', indent: block.indent || 0
                    });
                    renderBlocks(blocks);
                    scheduleSave();
                    toast('🖼️ 圖片已儲存');
                } catch (err) { toast('⚠️ 圖片寫入失敗'); console.error(err); }
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

// ─── Save ─────────────────────────────────────────────────
function markDirty() {
    if (!isCloudMode || !currentFileId) return;
    isDirty = true;
    updateSaveUI();
}

function clearDirty() {
    isDirty = false;
    updateSaveUI();
}

function updateSaveUI() {
    const lastSaved = $('lastSaved');
    const btnSave = $('btnSave');
    if (!lastSaved) return;

    if (isCloudMode) {
        if (isSaving) {
            lastSaved.textContent = '儲存中…';
            lastSaved.classList.remove('unsaved');
        } else if (isDirty) {
            lastSaved.textContent = '● 未儲存';
            lastSaved.classList.add('unsaved');
        } else {
            lastSaved.textContent = '已同步至 Drive';
            lastSaved.classList.remove('unsaved');
        }
        if (btnSave) {
            btnSave.disabled = !isDirty || isSaving;
            btnSave.classList.toggle('btn-save-dirty', isDirty && !isSaving);
        }
    } else if (fileMeta[currentFileId]?.modified) {
        const t = new Date(fileMeta[currentFileId].modified);
        lastSaved.textContent = '已儲存 ' + t.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
        lastSaved.classList.remove('unsaved');
    }
}

function updateSaveButtonVisibility() {
    const btnSave = $('btnSave');
    if (!btnSave) return;
    if (isCloudMode && currentFileId && isWorkspaceReady()) show(btnSave);
    else hide(btnSave);
}

function scheduleSave() {
    if (isCloudMode) {
        markDirty();
        return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveToDisk(false), 800);
    $('lastSaved').textContent = '儲存中…';
}
/*
async function flushPendingImages(blocks) {
    if (!isCloudMode) return;
    for (const block of blocks) {
        if (block.type !== 'image' || !block._pendingImage) continue;
        const fileName = (block.src || '').replace('./image/', '') || `img_${Date.now()}.png`;
        const result = await window.RhizomeDrive.uploadImage(block._pendingImage, fileName);
        block.src = result.src;
        block.driveImageId = result.driveId;
        delete block._pendingImage;
    }
}
*/
async function flushPendingImages(blocks) {
    if (!isCloudMode) return;
    for (const block of blocks) {
        if (block.type !== 'image' || !block._pendingImage) continue;
        
        const fileName = (block.src || '').replace('./image/', '') || `img_${Date.now()}.png`;
        const result = await window.RhizomeDrive.uploadImage(block._pendingImage, fileName);
        
        // 1. 儲存原始的雲端硬碟 ID 供備用（這步保留，很棒）
        block.driveImageId = result.driveId;
        
        // 2. 將 src 改為使用 ID 拼湊出的 Google Drive 圖片直鏈，取代相對路徑
        // 格式 A：標準高相容性直鏈
        block.src = `https://drive.google.com/uc?export=view&id=${result.driveId}`;
        
        // 格式 B（備用）：如果您發現格式 A 載入較慢，需要優化縮圖速度，可以用這行：
        // block.src = `https://drive.google.com/thumbnail?id=${result.driveId}&sz=w1200`;
        
        delete block._pendingImage;
    }
}
async function saveToDisk(showToast = false) {
    if (!currentFileId) return;
    if (isCloudMode && !window.RhizomeDrive?.isConnected()) {
        toast('⚠️ 請先連接 Google Drive');
        return;
    }
    if (isCloudMode && !isDirty && !showToast) return;

    const blocks = database[currentFileId];
    if (!blocks) return;

    if (isCloudMode) {
        if (isSaving) return;
        isSaving = true;
        updateSaveUI();
    } else if (!dirHandle || !fileHandleMap[currentFileId]) {
        return;
    }

    try {
        const meta = fileMeta[currentFileId] || {};
        meta.modified = Date.now();
        if (isCloudMode) await flushPendingImages(blocks);
        const payload = { meta, blocks: database[currentFileId] };
        const json = JSON.stringify(payload, null, 2);

        if (isCloudMode) {
            await window.RhizomeDrive.saveNoteContent(currentFileId, json);
            clearDirty();
            if (showToast) toast('✅ 已儲存至 Google Drive');
        } else {
            const fh = fileHandleMap[currentFileId];
            const w = await fh.createWritable();
            await w.write(json);
            await w.close();
            const t = new Date(meta.modified);
            $('lastSaved').textContent = '已儲存 ' + t.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
        }
        fileMeta[currentFileId] = meta;
        updateSaveUI();
    } catch (e) {
        console.error('[Rhizome] Save failed', e);
        $('lastSaved').textContent = '⚠️ 儲存失敗';
        toast('⚠️ 儲存失敗');
    } finally {
        isSaving = false;
        updateSaveUI();
    }
}

// ─── Search ──────────────────────────────────────────────
function handleSearch(query) {
    const sr = $('searchResults');
    const bc = $('blocksContainer');
    const nh = $('noteHeader');

    // 如果在手機版進行搜尋，搜尋後自動關閉側邊欄（如果是從側邊欄搜尋的話）
    if (query.trim() && window.innerWidth <= 768) {
        // 延遲一點點讓使用者看到輸入，或者直接關閉
        // toggleMobileDrawer(false); 
    }

    if (!query.trim()) {
        hide(sr);
        if (currentFileId) { show(bc); show(nh); }
        return;
    }

    hide(bc);
    show(sr);
    sr.innerHTML = '';

    const q = query.toLowerCase();
    const results = [];

    Object.keys(database).forEach(fid => {
        (database[fid] || []).forEach((b, bi) => {
            const text = (b.content || '').replace(/<[^>]+>/g, '');
            if (text.toLowerCase().includes(q)) {
                results.push({ fid, text, index: bi });
            }
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
        item.innerHTML = `<div class="search-result-file">📄 ${r.fid.replace('.json', '')}</div>
                          <div class="search-result-snippet">${highlighted.slice(0, 200)}</div>`;
        item.addEventListener('click', () => {
            $('topSearch').value = '';
            hide(sr);
            switchNote(r.fid);
        });
        sr.appendChild(item);
    });
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─── Stats ───────────────────────────────────────────────
let statsTimer = null;
function updateStatsDebounced() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateStats, 500);
}

function updateStats() {
    if (!currentFileId) return;
    const blocks = database[currentFileId] || [];
    let words = 0;
    blocks.forEach(b => {
        const text = (b.content || '').replace(/<[^>]+>/g, '').trim();
        if (text) words += text.split(/\s+/).filter(Boolean).length;
    });
    $('wordCount').textContent = words + ' 字';
    $('blockCount').textContent = blocks.length + ' 個區塊';
    $('propWords').textContent = words;
    $('propBlocks').textContent = blocks.length;
    if (fileMeta[currentFileId]) fileMeta[currentFileId].wordCount = words;
}

// ─── Outline ─────────────────────────────────────────────
function updateOutline() {
    if (!currentFileId) return;
    const list = $('outlineList');
    list.innerHTML = '';
    const blocks = database[currentFileId] || [];
    let hasHeadings = false;

    blocks.forEach((b, i) => {
        const text = (b.content || '').replace(/<[^>]+>/g, '').trim();
        const match = (b.content || '').match(/^<(h[1-3])[^>]*>(.*?)<\/h[1-3]>/i);
        if (match) {
            hasHeadings = true;
            const level = match[1]; const label = match[2].replace(/<[^>]+>/g, '');
            const item = document.createElement('div');
            item.className = `outline-item ${level}`;
            item.textContent = label;
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
    $('propCreated').textContent = fmt(meta.created);
    $('propModified').textContent = fmt(meta.modified);

    // Count wiki-links
    const blocks = database[currentFileId] || [];
    let linkCount = 0;
    blocks.forEach(b => {
        const matches = (b.content || '').match(/\[\[.+?\]\]/g);
        if (matches) linkCount += matches.length;
    });
    $('propLinks').textContent = linkCount;
}

// ─── Tags ─────────────────────────────────────────────────
function renderTags() {
    if (!currentFileId) return;
    const meta = fileMeta[currentFileId];
    const tags = meta?.tags || [];
    const tagsList = $('tagsList');
    tagsList.innerHTML = '';
    tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = '#' + tag;
        chip.title = '點擊搜尋此標籤';
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
        renderTags();
        scheduleSave();
    }
}

// ─── Backlinks ───────────────────────────────────────────
function computeAndShowBacklinks(fileId) {
    const panel = $('backlinksPanel');
    const list = $('backlinksList');
    list.innerHTML = '';

    const noteName = fileId.split('/').pop().replace('.json', '');
    const backlinks = [];

    Object.keys(database).forEach(fid => {
        if (fid === fileId) return;
        const blocks = database[fid] || [];
        const found = blocks.some(b => (b.content || '').includes(`[[${noteName}]]`));
        if (found) backlinks.push(fid);
    });

    if (!backlinks.length) { hide(panel); return; }
    show(panel);

    backlinks.forEach(fid => {
        const li = document.createElement('li');
        li.className = 'backlink-item';
        li.textContent = '🔗 ' + fid.replace('.json', '').split('/').pop();
        li.addEventListener('click', () => switchNote(fid));
        list.appendChild(li);
    });
}

// ─── Knowledge Graph ─────────────────────────────────────
function openGraphModal() {
    show($('graphModal'));
    requestAnimationFrame(drawGraph);
}

function drawGraph() {
    const canvas = $('graphCanvas');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');

    const isDark = document.body.dataset.theme === 'dark';
    const fgColor = isDark ? '#e7e5e4' : '#1c1917';
    const bgColor = isDark ? '#1c1b1a' : '#ffffff';
    const accentColor = isDark ? '#818cf8' : '#4f46e5';
    const edgeColor = isDark ? '#3a3937' : '#e7e5e4';
    const nodeColor = isDark ? '#242322' : '#f9f9f8';

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const files = Object.keys(database);
    if (!files.length) {
        ctx.fillStyle = fgColor; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('尚無筆記資料', canvas.width / 2, canvas.height / 2);
        return;
    }

    // Build node positions (simple force-directed approximation)
    const nodes = {};
    const links = [];
    const cx = canvas.width / 2, cy = canvas.height / 2;
    const r = Math.min(cx, cy) * 0.75;

    files.forEach((fid, i) => {
        const angle = (i / files.length) * Math.PI * 2 - Math.PI / 2;
        const radius = files.length <= 1 ? 0 : r * (0.3 + 0.7 * Math.random());
        nodes[fid] = {
            x: cx + radius * Math.cos(angle) + (Math.random() - .5) * 40,
            y: cy + radius * Math.sin(angle) + (Math.random() - .5) * 40,
            name: fid.split('/').pop().replace('.json', ''),
            linkCount: 0
        };
    });

    // Build links from [[wikilinks]]
    files.forEach(fid => {
        (database[fid] || []).forEach(b => {
            const matches = (b.content || '').matchAll(/\[\[(.+?)\]\]/g);
            for (const m of matches) {
                const target = files.find(f => f.replace('.json', '').split('/').pop() === m[1]);
                if (target && target !== fid) {
                    links.push({ from: fid, to: target });
                    nodes[fid].linkCount++;
                    nodes[target].linkCount++;
                }
            }
        });
    });

    // Draw edges
    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = 1;
    links.forEach(l => {
        const a = nodes[l.from], b = nodes[l.to];
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
    });

    // Draw nodes
    files.forEach(fid => {
        const n = nodes[fid];
        const rad = 6 + n.linkCount * 2;
        const isActive = fid === currentFileId;

        ctx.beginPath();
        ctx.arc(n.x, n.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = isActive ? accentColor : nodeColor;
        ctx.fill();
        ctx.strokeStyle = isActive ? accentColor : edgeColor;
        ctx.lineWidth = isActive ? 2 : 1;
        ctx.stroke();

        ctx.fillStyle = fgColor;
        ctx.font = `${isActive ? 600 : 400} 10px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(n.name.length > 12 ? n.name.slice(0, 12) + '…' : n.name, n.x, n.y + rad + 12);
    });

    // Click handler for graph navigation
    canvas.onclick = (e) => {
        const rect2 = canvas.getBoundingClientRect();
        const mx = e.clientX - rect2.left, my = e.clientY - rect2.top;
        for (const fid of files) {
            const n = nodes[fid];
            const rad = 6 + n.linkCount * 2;
            const dx = mx - n.x, dy = my - n.y;
            if (dx * dx + dy * dy <= rad * rad) {
                hide($('graphModal'));
                switchNote(fid);
                break;
            }
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
    const title = currentFileId.split('/').pop().replace('.json', '');
    const blocks = database[currentFileId] || [];
    const lines = ['# ' + title, ''];
    blocks.forEach(b => {
        if (b.type === 'image') { lines.push(`![圖片](${b.src || ''})`); return; }
        if (b.todo !== undefined) {
            const text = (b.content || '').replace(/<[^>]+>/g, '');
            lines.push(`- [${b.todo ? 'x' : ' '}] ${text}`);
            return;
        }
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
    const title = currentFileId?.split('/').pop().replace('.json', '') || 'note';

    if (format === 'md') {
        downloadFile(title + '.md', buildMarkdown(), 'text/markdown');
        toast('📄 Markdown 已下載');
    } else if (format === 'json') {
        const payload = JSON.stringify({ meta: fileMeta[currentFileId], blocks: database[currentFileId] }, null, 2);
        downloadFile(title + '.json', payload, 'application/json');
        toast('🗂️ JSON 已下載');
    } else if (format === 'txt') {
        const txt = (database[currentFileId] || []).map(b => (b.content || '').replace(/<[^>]+>/g, '')).join('\n');
        downloadFile(title + '.txt', txt, 'text/plain');
        toast('📃 文字檔已下載');
    } else if (format === 'copy') {
        navigator.clipboard.writeText(buildMarkdown()).then(() => toast('📋 已複製到剪貼簿'));
    }
    hide($('exportModal'));
}

function downloadFile(name, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ─── Theme ───────────────────────────────────────────────
function toggleTheme() {
    const isDark = document.body.dataset.theme === 'dark';
    document.body.dataset.theme = isDark ? 'light' : 'dark';
    $('themeIconLight').classList.toggle('hidden', !isDark);
    $('themeIconDark').classList.toggle('hidden', isDark);
    localStorage.setItem('nexus-theme', isDark ? 'light' : 'dark');
}

// Load saved theme
(function loadTheme() {
    const saved = localStorage.getItem('nexus-theme');
    if (saved) {
        document.body.dataset.theme = saved;
        if (saved === 'dark') {
            const l = $('themeIconLight'), d = $('themeIconDark');
            if (l && d) { l.classList.add('hidden'); d.classList.remove('hidden'); }
        }
    }
})();

// ─── Mobile Drawer ───────────────────────────────────────
function toggleMobileDrawer(show_) {
    const d = $('mobileDrawer');
    show_ ? show(d) : hide(d);
    if (show_ && $('drawerActions')) {
        $('drawerActions').style.display = isWorkspaceReady() ? '' : 'none';
    }
}

// ─── Command Palette ─────────────────────────────────────
function openCmdPalette() {
    show($('cmdPalette'));
    $('cmdInput').focus();
    $('cmdInput').value = '';
    filterCmdResults();
}

function closeCmdPalette() {
    hide($('cmdPalette'));
    $('cmdInput').value = '';
}

function filterCmdResults() {
    const q = $('cmdInput').value.toLowerCase().trim();
    $$('#cmdResults .cmd-item').forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = (!q || text.includes(q)) ? '' : 'none';
    });

    // Show matching note names
    let notesSection = $('cmdNotes');
    if (!notesSection) {
        notesSection = document.createElement('div');
        notesSection.id = 'cmdNotes';
        $('cmdResults').appendChild(notesSection);
    }
    notesSection.innerHTML = '';
    if (q && database) {
        const matches = Object.keys(database).filter(fid =>
            fid.toLowerCase().replace('.json', '').includes(q)
        ).slice(0, 5);
        if (matches.length) {
            const label = document.createElement('div');
            label.className = 'cmd-section-label';
            label.textContent = '筆記';
            notesSection.appendChild(label);
            matches.forEach(fid => {
                const item = document.createElement('div');
                item.className = 'cmd-item';
                item.innerHTML = `<span class="cmd-item-icon">📄</span> ${fid.replace('.json', '').split('/').pop()}`;
                item.addEventListener('click', () => { closeCmdPalette(); switchNote(fid); });
                notesSection.appendChild(item);
            });
        }
    }
}

function handleCmdKeydown(e) {
    if (e.key === 'Escape') { closeCmdPalette(); return; }
    if (e.key === 'Enter') {
        const q = $('cmdInput').value.trim().toLowerCase();
        runCmdAction(q);
    }
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
        case 'open': case 'o': (isCloudMode ? connectGoogleDrive : selectWorkspace)(); break;
        case 'theme': case 't': toggleTheme(); break;
        case 'search': case '/': $('topSearch').focus(); break;
        case 'graph': case 'g': openGraphModal(); break;
        default:
            // Try to find a matching note
            const match = Object.keys(database).find(fid =>
                fid.toLowerCase().replace('.json', '').split('/').pop() === action.toLowerCase()
            );
            if (match) switchNote(match);
    }
}
// ===================================================================
// 拖曳移動檔案邏輯 (Drag & Drop + File System Access API)
// ===================================================================

let dragSourceFileId = null;
let dragSourceParentPath = null;

function initDragAndDrop() {
    const treeContainer = $('noteTree');
    if (!treeContainer) return;

    // 1. 開始拖曳
    treeContainer.addEventListener('dragstart', (e) => {
        // 尋找被拖曳的筆記元素 (假設 class 包含 tree-item)
        const item = e.target.closest('.tree-item');
        if (!item) return;

        dragSourceFileId = item.dataset.id;
        // 尋找該筆記目前所在的資料夾路徑 (假設資料夾外層有 tree-folder 且帶有 data-path)
        const parentFolder = item.closest('.tree-folder');
        dragSourceParentPath = parentFolder ? (parentFolder.dataset.path || '') : '';

        e.dataTransfer.effectAllowed = 'move';
        item.style.opacity = '0.5';
    });

    // 2. 結束拖曳
    treeContainer.addEventListener('dragend', (e) => {
        if (e.target.style) e.target.style.opacity = '1';
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
    });

    // 3. 拖曳經過資料夾 (必須 preventDefault 才能觸發 drop)
    treeContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        const folder = e.target.closest('.tree-folder');
        if (folder) folder.classList.add('drag-over');
    });

    // 4. 拖曳離開資料夾
    treeContainer.addEventListener('dragleave', (e) => {
        const folder = e.target.closest('.tree-folder');
        if (folder) folder.classList.remove('drag-over');
    });

    // 5. 放開滑鼠 (Drop) - 執行移動
    treeContainer.addEventListener('drop', async (e) => {
        e.preventDefault();
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));

        const targetFolder = e.target.closest('.tree-folder');
        if (!dragSourceFileId) return;

        // 如果沒有 targetFolder，代表拖回根目錄 ('')
        const targetPath = targetFolder ? (targetFolder.dataset.path || '') : '';

        // 如果來源與目標資料夾相同，就不動作
        if (dragSourceParentPath === targetPath) return;

        await executeFileMove(dragSourceFileId, dragSourceParentPath, targetPath);
    });
}

// 核心移動邏輯
async function executeFileMove(fileId, sourcePath, targetPath) {
    try {
        const fileName = fileId.split('/').pop();
        const newFileId = (targetPath ? targetPath + '/' : '') + fileName;

        if (isCloudMode) {
            toast('⏳ 正在移動雲端筆記...');
            await window.RhizomeDrive.moveNote(fileId, newFileId);
            
            // 更新本地狀態
            database[newFileId] = database[fileId];
            fileMeta[newFileId] = fileMeta[fileId];
            fileHandleMap[newFileId] = fileHandleMap[fileId];
            delete database[fileId];
            delete fileMeta[fileId];
            delete fileHandleMap[fileId];

            await scanAndBuildFromDrive();
        } else {
            const sourceHandle = fileHandleMap[fileId];
            if (!sourceHandle) throw new Error("找不到該檔案的 Handle");

            const targetDirHandle = await getDirHandleFromPath(targetPath);
            const sourceDirHandle = await getDirHandleFromPath(sourcePath);

            const file = await sourceHandle.getFile();
            const content = await file.text();

            const newHandle = await targetDirHandle.getFileHandle(file.name, { create: true });
            const writable = await newHandle.createWritable();
            await writable.write(content);
            await writable.close();

            await sourceDirHandle.removeEntry(file.name);
            await scanAndBuild();
        }
        toast('✅ 筆記已成功移動！');
    } catch (error) {
        console.error("移動失敗:", error);
        toast('⚠️ 移動失敗: ' + error.message);
    }
}

// 輔助函數：將路徑字串 (ex: "folderA/folderB") 轉換回對應的 DirectoryHandle
async function getDirHandleFromPath(path) {
    if (!path || path === '/' || path === '') return dirHandle; // 回傳根目錄
    const parts = path.split('/').filter(p => p);
    let curr = dirHandle;
    for (const p of parts) {
        curr = await curr.getDirectoryHandle(p);
    }
    return curr;
}

// 綁定事件 (在頁面載入後執行一次)
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(initDragAndDrop, 1000); // 延遲確保樹狀結構已生成
});
/**
 * 更新反向連結面板
 * @param {string} currentFid - 當前開啟的筆記 ID
 */
function updateBacklinks(currentFid) {
    const listEl = $('backlinksList');
    const panel = $('backlinksPanel');
    if (!listEl || !panel) return;

    listEl.innerHTML = ''; // 清空列表
    let count = 0;

    // 取得當前筆記的名稱 (假設您有儲存名稱或從 fileHandleMap 對應)
    const currentFileName = getFileNameById(currentFid);

    // 遍歷整個資料庫
    Object.entries(database).forEach(([fid, blocks]) => {
        // 跳過當前筆記本身
        if (fid === currentFid) return;

        // 檢查內容是否包含 [[當前筆記名稱]] 或 [[當前筆記ID]]
        const content = blocks.map(b => b.content).join(' ');
        if (content.includes(`[[${currentFileName}]]`) || content.includes(`[[${currentFid}]]`)) {
            const li = document.createElement('li');
            li.className = 'backlink-item';
            li.textContent = getFileNameById(fid); // 顯示引用這篇筆記的筆記名稱
            li.onclick = () => switchNote(fid);    // 點擊後跳轉
            listEl.appendChild(li);
            count++;
        }
    });

    // 如果沒有連結，顯示提示；反之顯示面板
    if (count > 0) {
        show(panel);
    } else {
        hide(panel); // 如果沒人連結它，就隱藏面板
    }
}

// 輔助函式：根據 ID 取得名稱
function getFileNameById(fid) {
    // 假設您的 noteTree 結構中有對應名稱，或是從其他地方讀取
    // 這裡是一個簡易實作，請依照您的 data 結構調整
    return fid; // 若尚未實作名稱對應，暫時回傳 ID
}

/**
 * 在編輯器插入反向連結區塊
 * 使用方式：在編輯器輸入 /backlinks 後按 Enter
 */
async function insertBacklinksToEditor() {
    // 1. 取得當前筆記的名稱 (假設我們用 fileId 對應檔名)
    const currentNoteName = getFileNameById(currentFileId); // 請確保您有這個對應函數

    // 2. 搜尋所有其他筆記中包含 [[currentNoteName]] 的區塊
    let results = [];
    Object.entries(database).forEach(([fid, blocks]) => {
        if (fid === currentFileId) return; // 跳過自己

        blocks.forEach(block => {
            if (block.content.includes(`[[${currentNoteName}]]`)) {
                results.push({
                    fileId: fid,
                    content: block.content,
                    blockId: block.id
                });
            }
        });
    });

    if (results.length === 0) {
        toast('沒有找到反向連結');
        return;
    }

    // 3. 將這些區塊資訊格式化為 HTML 字串
    // 我們可以將它們轉成您 JSON 格式中需要的 block 格式，或者直接插入編輯器
    const insertHTML = results.map(r => `
        <div class="backlink-block" style="border-left: 2px solid #4f46e5; padding-left: 10px; margin: 10px 0; font-size: 0.9em; background: #f9f9f8;">
            <small>引用自: ${getFileNameById(r.fileId)}</small>
            <div>${r.content}</div>
        </div>
    `).join('');

    // 4. 使用編輯器的 API 插入內容 (這裡假設您是用 contenteditable 或類似編輯器)
    document.execCommand('insertHTML', false, insertHTML);
}
function insertBacklinksToCurrentBlock(currentIndex, blocks) {
    const currentName = currentFileId.split('/').pop().replace('.json', '');
    const targetLink = `[[${currentName}]]`;

    let allGroupsToInsert = [];

    Object.entries(database).forEach(([fid, bks]) => {
        if (fid === currentFileId) return;
        const sourceName = fid.split('/').pop().replace('.json', '');

        bks.forEach((b, bIndex) => {
            if (!(b.content || '').includes(targetLink)) return;

            const anchorIndent = b.indent || 0;
            const group = [{ ...b, id: uid('b') }];

            for (let i = bIndex + 1; i < bks.length; i++) {
                const childIndent = bks[i].indent || 0;
                if (childIndent <= anchorIndent) break;
                group.push({ ...bks[i], id: uid('b') });
            }

            allGroupsToInsert.push({ sourceName, fid, group, anchorIndent });
        });
    });

    if (allGroupsToInsert.length === 0) {
        toast(`找不到包含 ${targetLink} 的引用內容`);
        return;
    }

    const baseIndent = (blocks[currentIndex].indent || 0) + 24;

    const newBlocks = [];

    // ★ 錨點 block：記住「這裡要自動同步」，取代原本的 /bl
    newBlocks.push({
        id: uid('b'),
        content: '',
        indent: blocks[currentIndex].indent || 0,
        _backlinkSync: true   // ← 識別標記
    });

    allGroupsToInsert.forEach(({ sourceName, group, anchorIndent }) => {
        newBlocks.push({
            id: uid('b'),
            content: `<span style="color:var(--text3);font-size:0.82em">🔗 引用自：<strong>${sourceName}</strong></span>`,
            indent: baseIndent - 24,
            _backlinkGenerated: true  // ← 標記為自動產生，relink 時清除重建
        });

        group.forEach(blk => {
            const relativeOffset = (blk.indent || 0) - anchorIndent;
            newBlocks.push({
                ...blk,
                id: uid('b'),
                indent: baseIndent + relativeOffset,
                _backlinkGenerated: true  // ← 同上
            });
        });
    });

    blocks.splice(currentIndex, 1, ...newBlocks);

    renderBlocks(blocks);
    scheduleSave();
    toast(`✅ 已匯入 ${allGroupsToInsert.length} 組引用區塊（含子階層）`);
}
