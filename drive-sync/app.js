// Public browser configuration only. Never put an OAuth client secret here.
const GOOGLE_CONFIG = Object.freeze({
  clientId: '462063782430-uh2oa4j632okceojlqkqq17u5cqrfh09.apps.googleusercontent.com',
  pickerApiKey: 'AIzaSyCOxwENdMDE2vGKll0f8WcC8_RVRZot-Xo',
  projectNumber: '462063782430',
});
const $ = id => document.getElementById(id);
const baselines = new Map();
let token, expires = 0, localRoot, remoteRoot, plan = null, busy = false, cancelled = false, armed = false;
const nativeExports = Object.freeze({
  'application/vnd.google-apps.document': {extension: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  'application/vnd.google-apps.spreadsheet': {extension: '.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  'application/vnd.google-apps.presentation': {extension: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'},
});
const shortcutType = 'application/vnd.google-apps.shortcut';
function localName(file) {
  const extension = nativeExports[file.mimeType]?.extension || (file.mimeType === shortcutType ? '.url' : '');
  return extension && !file.name.toLowerCase().endsWith(extension) ? file.name + extension : file.name;
}
function isRepresentation(file) { return !!nativeExports[file?.mimeType] || file?.mimeType === shortcutType; }
const folderType = 'application/vnd.google-apps.folder';
const log = message => { $('log').textContent += message + '\n'; };
function invalidate() { plan = null; armed = false; $('sync').disabled = true; }
function auth() { if (!token || Date.now() >= expires) throw Error('請重新登入 Google，再預覽與同步。'); }
async function api(path, options = {}) {
  auth();
  const response = await fetch('https://www.googleapis.com/' + path, {...options, headers: {...options.headers, Authorization: 'Bearer ' + token}});
  if (!response.ok) {
    if (response.status === 401) { token = null; armed = false; }
    let message = `Google API ${response.status}`;
    try { message += ': ' + (await response.json()).error.message; } catch {}
    throw Error(message);
  }
  return response.status === 204 ? null : response.json();
}
const quote = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
async function children(parent) {
  let result = [], pageToken;
  do {
    const q = new URLSearchParams({q: `'${quote(parent)}' in parents and trashed = false`, fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)', pageSize: '1000', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true'});
    if (pageToken) q.set('pageToken', pageToken);
    const data = await api('drive/v3/files?' + q);
    result.push(...data.files); pageToken = data.nextPageToken;
  } while (pageToken);
  return result;
}
function checkStop() { if (cancelled) throw Error('已停止；已完成的上傳會保留。'); }
async function digest(file) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function stamp(file) { return [file.id, file.modifiedTime, file.size, JSON.stringify(file.shortcutDetails || null)].join('|'); }
async function remoteFile(file) {
  auth();
  if (file.mimeType === shortcutType) {
    const target = file.shortcutDetails?.targetId;
    if (!target || !/^[A-Za-z0-9_-]+$/.test(target)) throw Error('捷徑目標無效或無法取得。');
    const key = file.shortcutDetails.targetResourceKey;
    const url = 'https://drive.google.com/open?id=' + encodeURIComponent(target) + (key ? '&resourcekey=' + encodeURIComponent(key) : '');
    return new Blob(['[InternetShortcut]\r\nURL=' + url + '\r\n'], {type:'application/internet-shortcut'});
  }
  const format = nativeExports[file.mimeType];
  const path = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(file.id);
  const url = format ? path + '/export?mimeType=' + encodeURIComponent(format.mime) : path + '?alt=media&supportsAllDrives=true';
  const response = await fetch(url, {headers: {Authorization: 'Bearer ' + token}});
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).error?.message || ''; } catch {}
    throw Error((format ? 'Google 文件匯出失敗（Drive 匯出內容上限為 10 MB）' : '下載失敗') + '：Google API ' + response.status + (detail ? ' — ' + detail : ''));
  }
  const blob = await response.blob();
  if (blob.size > 500 * 1024 * 1024) throw Error('下載內容超過單檔 500 MiB 上限。');
  return blob;
}
function validName(name) {
  return name && !/[<>:"/\\|?*\x00-\x1f]/.test(name) && !/[ .]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) && name !== '.' && name !== '..';
}
async function buildPlan() {
  auth();
  if (!localRoot || !remoteRoot) throw Error('請先選擇兩個資料夾。');
  const operations = [];
  async function walk(directory, parent, path) {
    checkStop();
    const existing = parent.id ? await children(parent.id) : [];
    const local = new Map();
    if (directory.handle) for await (const [name, handle] of directory.handle.entries()) local.set(name, handle);
    const names = new Set([...local.keys(), ...existing.map(localName)]);
    const folded = new Map();
    for (const name of names) {
      const key = name.toLowerCase();
      if (folded.has(key) && folded.get(key) !== name) throw Error('Windows 不支援僅大小寫不同的檔名：' + path + name);
      folded.set(key, name);
      if (!validName(name)) throw Error('Windows 不支援此雲端檔名：' + path + name);
    }
    for (const name of names) {
      checkStop();
      const handle = local.get(name), matches = existing.filter(f => localName(f) === name), fullPath = path + name;
      if (matches.length > 1) throw Error('雲端有重複名稱，請先整理：' + fullPath);
      const found = matches[0];
      if (found && handle && (found.mimeType === folderType) !== (handle.kind === 'directory')) throw Error('檔案與資料夾名稱衝突：' + fullPath);
      if (handle?.kind === 'directory' || found?.mimeType === folderType) {
        const child = {id: found?.id}, localChild = {handle};
        if (!found) operations.push({kind: 'folder', name, parent, child, path: fullPath});
        if (!handle) operations.push({kind: 'localFolder', name, directory, localChild, path: fullPath});
        await walk(localChild, child, fullPath + '/');
        continue;
      }
      if (found?.mimeType.startsWith('application/vnd.google-apps.') && !isRepresentation(found)) { operations.push({kind:'skip', path: fullPath, reason:'此 Google 原生檔案類型尚不支援匯出'}); continue; }
      const file = handle ? await handle.getFile() : null;
      // Bound memory use: browser hashing and uploads buffer whole files.
      if ((file?.size || 0) > 500 * 1024 * 1024 || Number(found?.size || 0) > 500 * 1024 * 1024) { operations.push({kind:'skip', path:fullPath, reason:'第一版單檔上限為 500 MiB'}); continue; }
      const hash = file ? await digest(file) : null;
      let kind = !handle ? 'download' : !found ? 'file' : null;
      if (handle && found) {
        const old = baselines.get(fullPath);
        const localChanged = !old || old.hash !== hash;
        const remoteChanged = !old || old.stamp !== stamp(found);
        if (!localChanged && !remoteChanged) continue;
        if (old && localChanged && !remoteChanged) {
          if (isRepresentation(found)) { operations.push({kind:'conflict',path:fullPath,reason:'本機匯出檔或捷徑已修改，保留本機版本；不覆寫 Google 原稿或捷徑'}); continue; }
          kind = 'file';
        }
        else if (old && !localChanged && remoteChanged) kind = 'download';
        else {
          const remoteHash = await digest(await remoteFile(found));
          if (remoteHash === hash) { baselines.set(fullPath, {hash, stamp:stamp(found)}); continue; }
          operations.push({kind:'conflict', path:fullPath, reason:'兩邊內容不同，請手動保留或改名後重新預覽'});
          continue;
        }
      }
      operations.push({kind, name, parent, directory, found, handle, hash, size:file?.size, modified:file?.lastModified, path:fullPath});
    }
  }
  await walk({handle:localRoot}, {id:remoteRoot}, '');
  return operations;
}
async function preview() {
  invalidate(); $('log').textContent = '';
  plan = await buildPlan();
  for (const item of plan) log(`${({folder:'建立雲端資料夾',localFolder:'建立本機資料夾',file:'上傳至雲端',download:'下載至電腦',conflict:'衝突，略過',skip:'不支援，略過'})[item.kind]}：${item.path}${item.found && isRepresentation(item.found) ? (item.found.mimeType === shortcutType ? '（建立網路捷徑，不複製目標內容）' : '（Google 原稿匯出至電腦）') : ''}${item.reason ? ' — ' + item.reason : ''}`);
  $('sync').disabled = !plan.length;
  return `預覽完成：${plan.length} 項變更（包含衝突與略過項目；不會同步刪除）。`;
}
async function sync() {
  if (!plan) throw Error('請先預覽。');
  const pending = plan; plan = null; $('sync').disabled = true;
  let completed = 0, skipped = 0;
  for (const item of pending) {
    checkStop();
    if (item.kind === 'conflict' || item.kind === 'skip') { skipped++; log('略過：' + item.path + ' — ' + item.reason); continue; }
    if (item.kind === 'folder') {
      if ((await children(item.parent.id)).some(f => localName(f) === item.name)) throw Error('雲端資料夾已變更，請重新預覽：' + item.path);
      const result = await api('drive/v3/files?supportsAllDrives=true', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:item.name,mimeType:folderType,parents:[item.parent.id]})});
      item.child.id = result.id;
    } else if (item.kind === 'localFolder') {
      try { await item.directory.handle.getDirectoryHandle(item.name); throw Error('本機資料夾已變更，請重新預覽：' + item.path); }
      catch (e) { if (e.name !== 'NotFoundError') throw e; }
      item.localChild.handle = await item.directory.handle.getDirectoryHandle(item.name,{create:true});
    } else {
      const current = (await children(item.parent.id)).filter(f => localName(f) === item.name);
      if (item.found ? current.length !== 1 || stamp(current[0]) !== stamp(item.found) : current.length !== 0) throw Error('預覽後雲端已變更，請重新預覽：' + item.path);
      let present;
      try { present = await item.directory.handle.getFileHandle(item.name); }
      catch(e) { if (e.name !== 'NotFoundError') throw e; }
      if (item.handle ? !present || await digest(await present.getFile()) !== item.hash : !!present) throw Error('預覽後本機已變更，請重新預覽：' + item.path);
      if (item.kind === 'download') {
        const blob = await remoteFile(item.found);
        const latest = await api('drive/v3/files/' + encodeURIComponent(item.found.id) + '?fields=id,size,modifiedTime,shortcutDetails&supportsAllDrives=true');
        if (stamp(latest) !== stamp(item.found)) throw Error('下載期間雲端已變更：' + item.path);
        // Recheck immediately before writing; edits during the write still require user care.
        if (present && await digest(await present.getFile()) !== item.hash) throw Error('下載期間本機已變更：' + item.path);
        checkStop();
        const target = present || await item.directory.handle.getFileHandle(item.name,{create:true});
        const writable = await target.createWritable();
        try { await writable.write(blob); await writable.close(); } catch(e) { try { await writable.abort(); } catch {} throw e; }
        baselines.set(item.path,{hash:await digest(blob),stamp:stamp(latest)});
      } else {
        const file = await present.getFile();
        const metadata = {name:item.name};
        if (!item.found) metadata.parents = [item.parent.id];
        const boundary = 'sync_' + crypto.randomUUID();
        const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,JSON.stringify(metadata),`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,file,`\r\n--${boundary}--`]);
        checkStop();
        const saved = await api('upload/drive/v3/files' + (item.found ? '/' + encodeURIComponent(item.found.id) : '') + '?uploadType=multipart&supportsAllDrives=true&fields=id,size,modifiedTime', {method:item.found ? 'PATCH':'POST',headers:{'Content-Type':'multipart/related; boundary=' + boundary},body});
        baselines.set(item.path,{hash:item.hash,stamp:stamp(saved)});
      }
    }
    completed++; log('完成：' + item.path);
  }
  armed = !cancelled;
  return `同步完成：${completed} 項；衝突或不支援而略過 ${skipped} 項。`;
}
async function run(action) {
  if (busy) return;
  busy = true; cancelled = false;
  for (const id of ['local','remote','login','preview','sync']) $(id).disabled = true;
  $('status').textContent = '處理中…';
  try { $('status').textContent = await action(); }
  catch (e) { invalidate(); $('status').textContent = e.message; log(e.message); }
  finally { busy = false; for (const id of ['local','remote','login','preview']) $(id).disabled = false; $('sync').disabled = !plan?.length; }
}
$('login').onclick = () => {
  if (!window.google?.accounts) { $('status').textContent = 'Google 登入元件尚未載入，請檢查網路。'; return; }
  if (!GOOGLE_CONFIG.clientId.endsWith('.apps.googleusercontent.com')) { $('status').textContent = '網站的 Google 登入設定尚未完成，請聯絡管理者。'; return; }
  google.accounts.oauth2.initTokenClient({client_id: GOOGLE_CONFIG.clientId, scope: 'https://www.googleapis.com/auth/drive', callback: result => {
    invalidate(); baselines.clear(); remoteRoot = null; $('remoteName').textContent = '尚未選擇';
    if (result.error) { $('status').textContent = result.error; return; }
    token = result.access_token; expires = Date.now() + (Number(result.expires_in) - 60) * 1000;
    $('status').textContent = '已登入，請選擇資料夾。';
  }, error_callback: () => { $('status').textContent = '登入未完成，請檢查彈出視窗與公司授權政策。'; }}).requestAccessToken({prompt: 'consent'});
};
$('local').onclick = () => run(async () => {
  if (!window.showDirectoryPicker) throw Error('請使用桌面 Chrome 或 Edge，並透過 HTTPS 或 localhost 開啟。');
  const selected = await window.showDirectoryPicker({mode: 'readwrite'});
  localRoot = selected; baselines.clear(); invalidate(); $('localName').textContent = selected.name; return '已選擇電腦資料夾。';
});
$('remote').onclick = () => run(async () => {
  auth();
  if (!window.gapi || !GOOGLE_CONFIG.pickerApiKey || !GOOGLE_CONFIG.projectNumber) throw Error('Google 資料夾選擇器尚未就緒，請稍後重試；若持續失敗請聯絡管理者。');
  await new Promise((resolve,reject) => gapi.load('picker', {callback: resolve, onerror: () => reject(Error('Picker 載入失敗')), timeout: 15000, ontimeout: () => reject(Error('Picker 載入逾時'))}));
  return new Promise(resolve => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true);
    new google.picker.PickerBuilder().addView(view).setOAuthToken(token).setDeveloperKey(GOOGLE_CONFIG.pickerApiKey).setAppId(GOOGLE_CONFIG.projectNumber).setOrigin(location.origin).setCallback(data => {
      if (data.action === google.picker.Action.PICKED) { remoteRoot = data.docs[0].id; baselines.clear(); invalidate(); $('remoteName').textContent = data.docs[0].name; resolve('已選擇 Google Drive 目的資料夾。'); }
      if (data.action === google.picker.Action.CANCEL) resolve('已取消選擇。');
    }).build().setVisible(true);
  });
});
$('preview').onclick = () => run(preview);
$('sync').onclick = () => run(sync);
$('stop').onclick = () => { cancelled = true; armed = false; $('auto').checked = false; $('status').textContent = '停止自動同步；進行中的單一請求結束後停止。'; };
setInterval(() => { if ($('auto').checked && armed && !busy) run(async () => { plan = await buildPlan(); return sync(); }); }, 60000);
window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
