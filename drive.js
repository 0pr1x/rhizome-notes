/* Google Drive 儲存層 — 配合 config.js 使用 */
'use strict';

window.RhizomeDrive = (() => {
    const SCOPES = 'https://www.googleapis.com/auth/drive.file';
    const FOLDER_MIME = 'application/vnd.google-apps.folder';
    const LS_WORKSPACE = 'rhizome_workspace_id';
    const LS_TOKEN = 'rhizome_drive_token';
    const LS_TOKEN_EXP = 'rhizome_drive_token_exp';

    let accessToken = null;
    let tokenClient = null;
    let workspaceFolderId = null;
    let imageFolderId = null;
    /** fileId (path) → { id, name } */
    const fileRegistry = {};
    /** driveFileId → blob URL cache */
    const imageUrlCache = {};

    function cfg() {
        return window.RHIZOME_CONFIG || {};
    }

    function getToken() {
        const exp = parseInt(localStorage.getItem(LS_TOKEN_EXP) || '0', 10);
        if (accessToken && Date.now() < exp - 60000) return accessToken;
        const stored = localStorage.getItem(LS_TOKEN);
        if (stored && Date.now() < exp - 60000) {
            accessToken = stored;
            return accessToken;
        }
        return null;
    }

    function storeToken(token, expiresIn) {
        accessToken = token;
        const exp = Date.now() + (expiresIn || 3500) * 1000;
        localStorage.setItem(LS_TOKEN, token);
        localStorage.setItem(LS_TOKEN_EXP, String(exp));
    }

    function clearToken() {
        accessToken = null;
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_TOKEN_EXP);
    }

    function isConnected() {
        return !!getToken() && !!workspaceFolderId;
    }

    async function apiFetch(url, options = {}) {
        const token = getToken();
        if (!token) throw new Error('未登入 Google');
        const res = await fetch(url, {
            ...options,
            headers: {
                Authorization: 'Bearer ' + token,
                ...(options.headers || {}),
            },
        });
        if (res.status === 401) {
            clearToken();
            throw new Error('登入已過期，請重新連接');
        }
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || res.statusText);
        }
        if (res.status === 204) return null;
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) return res.json();
        return res;
    }

    function waitForGis() {
        return new Promise((resolve, reject) => {
            if (window.google?.accounts?.oauth2) return resolve();
            let n = 0;
            const t = setInterval(() => {
                if (window.google?.accounts?.oauth2) {
                    clearInterval(t);
                    resolve();
                } else if (++n > 50) {
                    clearInterval(t);
                    reject(new Error('Google Identity Services 載入失敗'));
                }
            }, 100);
        });
    }

    function initTokenClient() {
        const clientId = cfg().GOOGLE_CLIENT_ID;
        if (!clientId || clientId.startsWith('YOUR_')) {
            throw new Error('請在 config.js 設定 GOOGLE_CLIENT_ID');
        }
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: SCOPES,
            callback: () => {},
        });
    }

    function requestToken(prompt) {
        return new Promise((resolve, reject) => {
            tokenClient.callback = (resp) => {
                if (resp.error) {
                    reject(new Error(resp.error));
                    return;
                }
                storeToken(resp.access_token, resp.expires_in);
                resolve(resp.access_token);
            };
            tokenClient.requestAccessToken({ prompt: prompt || '' });
        });
    }

    async function signIn() {
        await waitForGis();
        if (!tokenClient) initTokenClient();
        if (!getToken()) await requestToken('consent');
        workspaceFolderId = localStorage.getItem(LS_WORKSPACE) || null;
        if (workspaceFolderId) {
            try {
                await apiFetch(
                    'https://www.googleapis.com/drive/v3/files/' + workspaceFolderId + '?fields=id,name,trashed'
                );
            } catch {
                workspaceFolderId = null;
                localStorage.removeItem(LS_WORKSPACE);
            }
        }
        if (!workspaceFolderId) {
            workspaceFolderId = await findOrCreateWorkspaceFolder();
            localStorage.setItem(LS_WORKSPACE, workspaceFolderId);
        }
        imageFolderId = await findOrCreateSubfolder(workspaceFolderId, 'image');
        return workspaceFolderId;
    }

    async function findOrCreateWorkspaceFolder() {
        const name = cfg().DRIVE_FOLDER_NAME || 'RhizomeNotes';
        const q = encodeURIComponent(
            "mimeType='" + FOLDER_MIME + "' and name='" + name.replace(/'/g, "\\'") + "' and trashed=false"
        );
        const list = await apiFetch(
            'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&spaces=drive'
        );
        if (list.files?.length) return list.files[0].id;
        const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
        });
        return created.id;
    }

    async function findOrCreateSubfolder(parentId, name) {
        const q = encodeURIComponent(
            "'" + parentId + "' in parents and mimeType='" + FOLDER_MIME + "' and name='" + name + "' and trashed=false"
        );
        const list = await apiFetch(
            'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id)&spaces=drive'
        );
        if (list.files?.length) return list.files[0].id;
        const created = await apiFetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
        });
        return created.id;
    }

    async function listChildren(folderId) {
        const q = encodeURIComponent("'" + folderId + "' in parents and trashed=false");
        const all = [];
        let pageToken = '';
        do {
            let url =
                'https://www.googleapis.com/drive/v3/files?q=' +
                q +
                '&fields=nextPageToken,files(id,name,mimeType)&pageSize=200&spaces=drive';
            if (pageToken) url += '&pageToken=' + pageToken;
            const data = await apiFetch(url);
            all.push(...(data.files || []));
            pageToken = data.nextPageToken || '';
        } while (pageToken);
        return all;
    }

    async function readFileText(driveFileId) {
        const token = getToken();
        const res = await fetch(
            'https://www.googleapis.com/drive/v3/files/' + driveFileId + '?alt=media',
            { headers: { Authorization: 'Bearer ' + token } }
        );
        if (res.status === 401) {
            clearToken();
            throw new Error('登入已過期，請重新連接');
        }
        if (!res.ok) throw new Error(await res.text());
        return res.text();
    }

    async function buildTreeFromDrive(folderId, relPath) {
        const nodes = [];
        const children = await listChildren(folderId);
        for (const f of children) {
            if (f.mimeType === FOLDER_MIME) {
                if (f.name === 'image') continue;
                const subPath = relPath + f.name + '/';
                const subNodes = await buildTreeFromDrive(f.id, subPath);
                nodes.push({ name: f.name, kind: 'directory', children: subNodes, path: relPath + f.name, driveId: f.id });
            } else if (f.name.endsWith('.json')) {
                const fileId = relPath + f.name;
                fileRegistry[fileId] = { id: f.id, name: f.name };
                nodes.push({ name: f.name, kind: 'file', fileId, driveId: f.id });
            }
        }
        nodes.sort((a, b) =>
            a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-TW') : a.kind === 'directory' ? -1 : 1
        );
        return nodes;
    }

    async function loadAllNotes(tree, onNoteLoaded) {
        async function walk(nodes) {
            for (const n of nodes) {
                if (n.kind === 'file') {
                    await onNoteLoaded(n.fileId, n.driveId);
                } else if (n.children) {
                    await walk(n.children);
                }
            }
        }
        await walk(tree);
    }

    async function saveNoteContent(fileId, jsonString) {
        const entry = fileRegistry[fileId];
        if (!entry) throw new Error('找不到檔案: ' + fileId);
        await apiFetch(
            'https://www.googleapis.com/upload/drive/v3/files/' +
                entry.id +
                '?uploadType=media',
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: jsonString,
            }
        );
    }

    async function createNote(relativePath, jsonString) {
        const parts = relativePath.split('/');
        const fileName = parts.pop();
        let parentId = workspaceFolderId;
        let pathAcc = '';
        for (const part of parts) {
            pathAcc += part + '/';
            parentId = await findOrCreateSubfolder(parentId, part);
        }
        const boundary = 'rhizome_' + Date.now();
        const metadata = JSON.stringify({ name: fileName, parents: [parentId], mimeType: 'application/json' });
        const body =
            '--' +
            boundary +
            '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
            metadata +
            '\r\n--' +
            boundary +
            '\r\nContent-Type: application/json\r\n\r\n' +
            jsonString +
            '\r\n--' +
            boundary +
            '--';
        const token = getToken();
        const res = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'multipart/related; boundary=' + boundary,
                },
                body,
            }
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        fileRegistry[relativePath] = { id: data.id, name: fileName };
        return data.id;
    }

    async function deleteNote(fileId) {
        const entry = fileRegistry[fileId];
        if (!entry) return;
        await apiFetch('https://www.googleapis.com/drive/v3/files/' + entry.id, { method: 'DELETE' });
        delete fileRegistry[fileId];
    }

    async function createFolder(folderName) {
        await findOrCreateSubfolder(workspaceFolderId, folderName.trim());
    }

    async function uploadImage(blob, fileName) {
        if (!imageFolderId) imageFolderId = await findOrCreateSubfolder(workspaceFolderId, 'image');
        const boundary = 'rhizome_img_' + Date.now();
        const metadata = JSON.stringify({
            name: fileName,
            parents: [imageFolderId],
            mimeType: blob.type || 'image/png',
        });
        const body =
            '--' +
            boundary +
            '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
            metadata +
            '\r\n--' +
            boundary +
            '\r\nContent-Type: ' +
            (blob.type || 'image/png') +
            '\r\n\r\n';
        const token = getToken();
        const res = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer ' + token,
                    'Content-Type': 'multipart/related; boundary=' + boundary,
                },
                body: new Blob([body, blob, '\r\n--' + boundary + '--']),
            }
        );
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        return { driveId: data.id, src: './image/' + fileName };
    }

    async function getImageBlobUrl(driveFileId) {
        if (imageUrlCache[driveFileId]) return imageUrlCache[driveFileId];
        const token = getToken();
        const res = await fetch(
            'https://www.googleapis.com/drive/v3/files/' + driveFileId + '?alt=media',
            { headers: { Authorization: 'Bearer ' + token } }
        );
        if (!res.ok) throw new Error('無法載入圖片');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        imageUrlCache[driveFileId] = url;
        return url;
    }

    async function resolveImageDriveId(fileName) {
        if (!imageFolderId) return null;
        const q = encodeURIComponent(
            "'" + imageFolderId + "' in parents and name='" + fileName.replace(/'/g, "\\'") + "' and trashed=false"
        );
        const list = await apiFetch(
            'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id)&spaces=drive'
        );
        return list.files?.[0]?.id || null;
    }

    function getFileEntry(fileId) {
        return fileRegistry[fileId] || null;
    }

    function registerFile(fileId, driveId, name) {
        fileRegistry[fileId] = { id: driveId, name: name || fileId.split('/').pop() };
    }

    function clearRegistry() {
        Object.keys(fileRegistry).forEach(k => delete fileRegistry[k]);
        Object.values(imageUrlCache).forEach(u => URL.revokeObjectURL(u));
        Object.keys(imageUrlCache).forEach(k => delete imageUrlCache[k]);
    }

    async function tryRestoreSession() {
        if (!getToken()) return false;
        try {
            await waitForGis();
            initTokenClient();
            workspaceFolderId = localStorage.getItem(LS_WORKSPACE);
            if (!workspaceFolderId) return false;
            await apiFetch(
                'https://www.googleapis.com/drive/v3/files/' + workspaceFolderId + '?fields=id,trashed'
            );
            imageFolderId = await findOrCreateSubfolder(workspaceFolderId, 'image');
            return true;
        } catch {
            clearToken();
            return false;
        }
    }

    async function renameNote(fileId, newFileName) {
        const entry = fileRegistry[fileId];
        if (!entry) throw new Error('找不到檔案');
        await apiFetch('https://www.googleapis.com/drive/v3/files/' + entry.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newFileName }),
        });
        entry.name = newFileName;
    }

    return {
        signIn,
        isConnected,
        getToken,
        clearRegistry,
        buildTreeFromDrive,
        loadAllNotes,
        readFileText,
        saveNoteContent,
        createNote,
        deleteNote,
        createFolder,
        renameNote,
        uploadImage,
        getImageBlobUrl,
        resolveImageDriveId,
        getFileEntry,
        registerFile,
        tryRestoreSession,
        get workspaceFolderId() {
            return workspaceFolderId;
        },
    };
})();
