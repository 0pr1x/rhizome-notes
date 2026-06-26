// ==========================================
// 1. Google Auth & API 設定
// ==========================================
const CLIENT_ID = '249300683470-vtgnnd73jvhe1ku7ckoftasrn8tesmfe.apps.googleusercontent.com'; // 👈 這裡請換成你專屬的 Client ID
const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FILENAME = 'rhizome_notes_data.json';

let tokenClient;
let gapiInited = false;
let gsiInited = false;
let accessToken = null;
let driveFileId = null; // 記錄在雲端硬碟建立的 JSON 檔案 ID

// 記憶體中的筆記資料結構
let noteData = {
    notes: {},      // { id: { title: "", blocks: [], tags: [], updated: "" } }
    folders: [],    // 目錄結構
    activeNoteId: null
};

// ==========================================
// 2. 初始化與載入 Google SDK
// ==========================================
window.onload = function () {
    gapiLoad();
    gsiLoad();
    initUI();
};

function gapiLoad() {
    gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
    await gapi.client.init({
        // 這裡不需要填 API Key，因為我們有限制金鑰，改用更有保障的 OAuth 驗證
    });
    await gapi.client.load('drive', 'v3');
    gapiInited = true;
    checkAuthStatus();
}

function gsiLoad() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: handleAuthResponse,
    });
    gsiInited = true;
    checkAuthStatus();
}

function checkAuthStatus() {
    if (gapiInited && gsiInited) {
        showToast("Google 模組載入成功，請點擊連結雲端！", "success");
    }
}

// ==========================================
// 3. 登入與權限處理 (Auth)
// ==========================================
function handleAuthClick() {
    if (!tokenClient) {
        showToast("Google SDK 尚未準備就緒，請重新整理網頁", "error");
        return;
    }
    // 彈出 Google 官方登入與授權視窗
    tokenClient.requestAccessToken({ prompt: 'consent' });
}

async function handleAuthResponse(response) {
    if (response.error !== undefined) {
        showToast(`授權失敗: ${response.error}`, "error");
        throw (response);
    }

    accessToken = response.access_token;
    showToast("登入成功！正在連線雲端硬碟...", "success");

    // UI 狀態切換
    document.getElementById('btnOpenFolder').innerHTML = "☁️ 雲端已連結";
    document.getElementById('btnOpenFolder').style.background = "#2e7d32";
    document.getElementById('syncStatus').innerText = "已連線";
    document.getElementById('syncStatus').style.background = "#2e7d32";
    document.getElementById('sidebarActions').classList.remove('hidden');
    document.getElementById('btnLogout').classList.remove('hidden');

    // 開始同步或建立檔案
    await syncWithGoogleDrive();
}

function handleLogoutClick() {
    if (accessToken) {
        google.accounts.oauth2.revokeToken(accessToken);
        accessToken = null;
        driveFileId = null;
        noteData = { notes: {}, folders: [], activeNoteId: null };

        // 恢復 UI 狀態
        document.getElementById('btnOpenFolder').innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
            </svg> 連結 Google 雲端`;
        document.getElementById('btnOpenFolder').style.background = "";
        document.getElementById('syncStatus').innerText = "未連結";
        document.getElementById('syncStatus').style.background = "";
        document.getElementById('sidebarActions').classList.add('hidden');
        document.getElementById('btnLogout').classList.add('hidden');

        renderNoteTree();
        showToast("已安全登出並清除本地快取", "info");
    }
}

// ==========================================
// 4. Google Drive 雲端檔案讀寫邏輯 (核心)
// ==========================================
async function syncWithGoogleDrive() {
    try {
        // 1. 搜尋雲端硬碟是否已經有 Rhizome Notes 建立過的 json 檔案
        let response = await gapi.client.drive.files.list({
            q: `name='${BACKUP_FILENAME}' and trashed=false`,
            fields: 'files(id, name)',
            spaces: 'drive'
        });

        let files = response.result.files;
        if (files && files.length > 0) {
            // 2. 如果檔案存在，讀取它
            driveFileId = files[0].id;
            await downloadNotesFromCloud();
        } else {
            // 3. 如果不存在，初始化一個新的檔案
            showToast("首次登入，正在雲端建立初始筆記庫...", "info");
            await createInitialCloudFile();
        }
    } catch (err) {
        console.error(err);
        showToast("同步雲端時發生錯誤", "error");
    }
}

async function downloadNotesFromCloud() {
    try {
        let response = await gapi.client.drive.files.get({
            fileId: driveFileId,
            alt: 'media'
        });

        if (response.result) {
            noteData = response.result;
            showToast("成功自雲端下載所有筆記！", "success");
            renderNoteTree();
        }
    } catch (err) {
        console.error(err);
        showToast("下載雲端資料失敗", "error");
    }
}

async function uploadNotesToCloud() {
    if (!driveFileId || !accessToken) return;

    document.getElementById('lastSaved').innerText = "同步中...";
    try {
        await gapi.client.request({
            path: `/upload/drive/v3/files/${driveFileId}`,
            method: 'PATCH',
            params: { uploadType: 'media' },
            body: JSON.stringify(noteData, null, 2)
        });

        const now = new Date();
        document.getElementById('lastSaved').innerText = `已同步 ${now.toLocaleTimeString()}`;
    } catch (err) {
        console.error(err);
        document.getElementById('lastSaved').innerText = "同步失敗";
    }
}

async function createInitialCloudFile() {
    // 建立預設的第一篇歡迎筆記
    const welcomeId = "welcome-note";
    noteData.notes[welcomeId] = {
        title: "歡迎使用 Rhizome Notes 雲端版",
        blocks: [
            { type: "p", content: "這是一個安全且完全專屬於你的網狀數位大腦。" },
            { type: "p", content: "現在這份資料已經成功儲存於你的 Google Drive 雲端硬碟。只有被你加入白名單的人可以存取它。" }
        ],
        tags: ["歡迎", "說明"],
        updated: new Date().toISOString()
    };
    noteData.activeNoteId = welcomeId;

    try {
        let response = await gapi.client.drive.files.create({
            resource: {
                name: BACKUP_FILENAME,
                mimeType: 'application/json'
            },
            fields: 'id'
        });

        driveFileId = response.result.id;
        // 把初始資料打上去
        await uploadNotesToCloud();
        renderNoteTree();
    } catch (err) {
        console.error(err);
    }
}

// ==========================================
// 5. 畫面渲染與 UI 綁定 (保留你原本功能)
// ==========================================
function initUI() {
    // 綁定「連結 Google 雲端」按鈕
    document.getElementById('btnOpenFolder').addEventListener('click', handleAuthClick);

    // 綁定「登出」按鈕
    document.getElementById('btnLogout').addEventListener('click', handleLogoutClick);

    // 監聽同步按鈕
    document.getElementById('btnRefresh').addEventListener('click', async () => {
        if (driveFileId) {
            showToast("正在手動同步雲端...", "info");
            await downloadNotesFromCloud();
        }
    });

    // 監聽新增筆記按鈕
    document.getElementById('btnNewNote').addEventListener('click', createNewNote);
}

function renderNoteTree() {
    const tree = document.getElementById('noteTree');
    tree.innerHTML = ""; // 清空

    const keys = Object.keys(noteData.notes);

    if (keys.length === 0) {
        tree.innerHTML = `
            <li class="tree-empty">
                <div class="tree-empty-icon">☁️</div>
                <div>請連結 Google 雲端<br>以載入個人筆記</div>
            </li>`;
        return;
    }

    keys.forEach(id => {
        const note = noteData.notes[id];
        const li = document.createElement('li');
        li.className = `tree-item ${noteData.activeNoteId === id ? 'active' : ''}`;
        li.innerHTML = `📝 <span class="tree-note-title">${note.title || "未命名筆記"}</span>`;
        li.addEventListener('click', () => loadNote(id));
        tree.appendChild(li);
    });

    if (noteData.activeNoteId) {
        loadNote(noteData.activeNoteId);
    }
}

function loadNote(id) {
    noteData.activeNoteId = id;
    const note = noteData.notes[id];

    // 顯示編輯器區域
    document.getElementById('noteHeader').classList.remove('hidden');
    document.getElementById('blocksContainer').classList.remove('hidden');

    document.getElementById('noteTitle').innerText = note.title;

    // 渲染區塊 (這裡簡單示意，可以對接你原有的 Block 渲染引擎)
    const container = document.getElementById('blocksContainer');
    container.innerHTML = "";
    note.blocks.forEach(b => {
        const div = document.createElement('div');
        div.className = "note-block";
        div.innerText = b.content;
        container.appendChild(div);
    });
}

function createNewNote() {
    const id = 'note_' + Date.now();
    noteData.notes[id] = {
        title: "未命名筆記",
        blocks: [{ type: "p", content: "點擊開始輸入..." }],
        tags: [],
        updated: new Date().toISOString()
    };
    noteData.activeNoteId = id;
    renderNoteTree();
    uploadNotesToCloud(); // 自動儲存回雲端
}

// 提示泡泡通知
function showToast(message, type = "info") {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.className = `toast visible ${type}`;
    setTimeout(() => {
        toast.className = "toast hidden";
    }, 3000);
}