// ==========================================
// 1. 設定與全域變數
// ==========================================
const CLIENT_ID = '249300683470-vtgnnd73jvhe1ku7ckoftasrn8tesmfe.apps.googleusercontent.com';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILENAME = 'rhizome_notes_data.json';

let tokenClient;
let accessToken = null;
let driveFileId = null;
let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent );

let noteData = {
    notes: {},
    activeNoteId: null
};

// ==========================================
// 2. 初始化
// ==========================================
window.onload = () => {
    gapi.load('client', async () => {
        await gapi.client.init({});
        await gapi.client.load('drive', 'v3');
        console.log("GAPI loaded");
    });

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: handleAuthResponse,
    });

    initUI();
    if (isMobile) {
        showToast("偵測到行動裝置：開啟唯讀模式", "info");
    }
};

// ==========================================
// 3. UI 事件綁定
// ==========================================
function initUI() {
    document.getElementById('btnOpenFolder').onclick = () => tokenClient.requestAccessToken({ prompt: 'consent' });
    document.getElementById('btnLogout').onclick = handleLogout;
    document.getElementById('btnNewNote').onclick = createNewNote;
    document.getElementById('btnRefresh').onclick = downloadNotesFromCloud;
    document.getElementById('btnTheme').onclick = toggleTheme;
    document.getElementById('btnSidebarToggle').onclick = () => document.getElementById('sidebar').classList.toggle('active');

    // 搜尋功能
    document.getElementById('topSearch').oninput = (e) => filterNotes(e.target.value);
    
    // 工具列功能
    document.querySelectorAll('.toolbar-btn').forEach(btn => {
        btn.onclick = () => {
            const cmd = btn.dataset.cmd;
            if (cmd === 'h1' || cmd === 'h2') {
                document.execCommand('formatBlock', false, cmd);
            } else if (cmd === 'ul') {
                document.execCommand('insertUnorderedList');
            } else {
                document.execCommand(cmd);
            }
        };
    });

    // 標題編輯監聽
    document.getElementById('noteTitle').onblur = (e) => {
        if (noteData.activeNoteId) {
            noteData.notes[noteData.activeNoteId].title = e.target.innerText;
            renderNoteTree();
            autoSave();
        }
    };
}

// ==========================================
// 4. 核心功能：筆記管理
// ==========================================
function renderNoteTree() {
    const tree = document.getElementById('noteTree');
    tree.innerHTML = "";
    Object.keys(noteData.notes).forEach(id => {
        const note = noteData.notes[id];
        const li = document.createElement('li');
        li.className = `tree-item ${noteData.activeNoteId === id ? 'active' : ''}`;
        li.innerHTML = `📝 ${note.title || '未命名'}`;
        li.onclick = () => loadNote(id);
        tree.appendChild(li);
    });
}

function loadNote(id) {
    noteData.activeNoteId = id;
    const note = noteData.notes[id];
    
    // 顯示編輯區域
    document.getElementById('noteHeader').classList.remove('hidden');
    document.getElementById('blocksContainer').classList.remove('hidden');
    
    // 設置標題
    const titleEl = document.getElementById('noteTitle');
    titleEl.innerText = note.title;
    
    // 設置內容
    const container = document.getElementById('blocksContainer');
    container.innerHTML = note.content || "<div class='note-block' contenteditable='true'>開始輸入...</div>";

    // 權限控制：手機端唯讀
    if (isMobile) {
        titleEl.contentEditable = "false";
        document.getElementById('editorToolbar').classList.add('hidden');
        container.querySelectorAll('.note-block').forEach(b => b.contentEditable = "false");
        container.contentEditable = "false";
    } else {
        titleEl.contentEditable = "true";
        document.getElementById('editorToolbar').classList.remove('hidden');
        container.contentEditable = "true";
    }

    // 監聽內容變動
    container.oninput = () => {
        noteData.notes[id].content = container.innerHTML;
        autoSave();
    };

    renderNoteTree();
}

function createNewNote() {
    const id = 'note_' + Date.now();
    noteData.notes[id] = { title: "新筆記", content: "<div class='note-block'>點擊開始編輯...</div>" };
    loadNote(id);
    uploadNotesToCloud();
}

// ==========================================
// 5. Google Drive 同步
// ==========================================
async function handleAuthResponse(response) {
    if (response.error) return;
    accessToken = response.access_token;
    
    // UI 切換
    document.getElementById('btnOpenFolder').classList.add('hidden');
    document.getElementById('btnLogout').classList.remove('hidden');
    document.getElementById('sidebarActions').classList.remove('hidden');
    document.getElementById('syncStatus').innerText = "已連線";
    document.getElementById('syncStatus').style.background = "#10b981";

    await syncWithGoogleDrive();
}

async function syncWithGoogleDrive() {
    const resp = await gapi.client.drive.files.list({
        q: `name='${BACKUP_FILENAME}' and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive'
    });
    const files = resp.result.files;
    if (files.length > 0) {
        driveFileId = files[0].id;
        await downloadNotesFromCloud();
    } else {
        await createInitialCloudFile();
    }
}

async function downloadNotesFromCloud() {
    const resp = await gapi.client.drive.files.get({ fileId: driveFileId, alt: 'media' });
    noteData = resp.result;
    renderNoteTree();
    showToast("同步成功", "success");
}

async function uploadNotesToCloud() {
    if (!driveFileId) return;
    document.getElementById('lastSaved').innerText = "同步中...";
    await gapi.client.request({
        path: `/upload/drive/v3/files/${driveFileId}`,
        method: 'PATCH',
        params: { uploadType: 'media' },
        body: JSON.stringify(noteData)
    });
    document.getElementById('lastSaved').innerText = "已同步至雲端";
}

let autoSaveTimer;
function autoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(uploadNotesToCloud, 2000);
}

// ==========================================
// 6. 工具函式
// ==========================================
function toggleTheme() {
    const body = document.body;
    const theme = body.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    body.setAttribute('data-theme', theme);
}

function showToast(msg, type) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.className = `toast visible ${type}`;
    setTimeout(() => t.className = "toast hidden", 3000);
}

function handleLogout() {
    location.reload(); // 簡單處理：重新整理即登出
}

function filterNotes(query) {
    const items = document.querySelectorAll('.tree-item');
    items.forEach(item => {
        item.style.display = item.innerText.toLowerCase().includes(query.toLowerCase()) ? 'flex' : 'none';
    });
}
