# 電腦與 Google Drive 雙向同步

免安裝瀏覽器工具，適用 Windows 桌面 Chrome / Edge。工具必須在 HTTPS 網站或 localhost 執行，不能直接雙擊 HTML。可保留原有郵件頁面，這個工具位於 `drive-sync/`。

## 管理者首次設定

1. 在 Google Cloud 建立專案，啟用 **Google Drive API** 與 **Google Picker API**。
2. 設定 OAuth 同意畫面。測試模式請加入使用者為測試使用者；正式對外使用可能需要 Google 的應用程式驗證。Workspace 管理政策可能禁止授權。
3. 建立「網頁應用程式」OAuth 用戶端，設定網站的 Authorized JavaScript origins，例如本機開發使用 `http://localhost:8000`。正式使用請部署至可信任的 HTTPS 靜態網站，設定其實際 origin。不要填頁面路徑。
4. 建立 Picker 使用的瀏覽器 API 金鑰，限制 HTTP referrers 為該網站，並限制至 Google Picker API。準備同一專案的數字「專案編號」，不是專案 ID。
5. 將 OAuth Client ID、Picker API 金鑰、專案編號填入 `app.js` 頂端的 `GOOGLE_CONFIG` 後部署網站，使用者不需要填寫。這是瀏覽器公開設定，**不需要 OAuth client secret**，也不要把 client secret 填入頁面。

為讀取選定資料夾內既有檔案與子資料夾，本工具使用 `https://www.googleapis.com/auth/drive` 完整 Drive 權限。`drive.file` 不能代表已取得資料夾內全部既有子檔案的授權。請先確認公司允許這項存取權；不要用此工具繞過公司政策。程式沒有分析服務或自建後端，檔案直接傳送到 Google API。

## 使用

1. 開啟 HTTPS 網站上的 `/drive-sync/`，按「登入 Google」完成授權。
2. 選擇電腦資料夾，授予讀取及寫入權限；透過 Google Picker 選擇雲端資料夾。
3. 先預覽再同步。會同步雙方新增檔案和子資料夾；建立比對紀錄後，同一檔案只在一邊修改時會更新另一邊。
4. 可選擇每 60 秒自動同步。必須先完成手動同步。保持網頁開啟和電腦喚醒；背景分頁可能延遲執行，Google 授權過期後需重新登入。

## 保護與限制

- 不同步刪除：單邊刪除會補回，改名會視為新增路徑，舊路徑可能補回。
- 初次遇到兩邊都有的檔案，以 SHA-256 比較內容；相同內容建立基準，不同內容列為衝突。之後本機以內容雜湊、雲端以檔案 ID／大小／修改時間偵測變更。
- 同時修改兩邊會列為衝突並略過。請先把需保留的版本改為另一個檔名，或手動整理成相同內容，再重新預覽。不要靠時間戳猜測哪邊比較重要。
- 基準只存在記憶體，重載網頁、重新登入或重選資料夾會清除。重新連線後的不同內容會重新列為衝突，不會自動選邊覆寫。
- 單檔上限 500 MiB；Google 文件、試算表、簡報分別匯出為 `.docx`、`.xlsx`、`.pptx`；捷徑存成 Windows 可開啟的 `.url`。Google 的 `files.export` 匯出內容限制為 10 MB，與一般檔案的 500 MiB 上限不同；超出時會顯示錯誤並保留既有本機檔案。大量檔案的初次比對可能耗時並消耗下載流量。尚未實作可續傳的大檔上傳。
- 重複雲端檔名、Windows 不支援的檔名及檔案／資料夾衝突會阻止該次預覽。共有雲端硬碟仍受帳號權限與 Picker 支援限制，尚未實帳驗證。
- 寫入前重新檢查變更，但不是跨 Google Drive 與本機檔案系統的原子交易。同步期間請暫停編輯；正式使用前先以測試資料夾驗證並保留備份。
- 停止會等目前請求結束；已完成的變更不會回復。失敗後停止自動同步，重新預覽可確認部分完成的結果。
- 沒有安裝背景服務，不能在關閉網頁後或登出 Windows 後同步。

## Google 原生文件與捷徑

- 原生文件從雲端匯出到電腦。相同登入工作階段內，雲端更新會刷新未修改的本機匯出檔；本機匯出檔已修改則保留並列為衝突，不上傳覆寫 Google 原稿。
- 匯出可能無法保留 Google 專屬功能、註解或全部格式。關閉或重新登入後比對紀錄會清除；Office 匯出檔的內部中繼資料也可能改變，內容雜湊不同時會保守地列為衝突。
- 依原名附加 `.docx`／`.xlsx`／`.pptx`；已有相同副檔名時不重複附加。若轉換後名稱撞到另一個雲端檔案，停止預覽，請先改名。
- Drive 檔案或資料夾捷徑均存成 `.url`，開啟時連到原目標，仍需相應 Google 存取權限。同步不沿著捷徑下載目標內容，避免循環與跨出所選資料夾。修改本機 `.url` 會列為衝突，不回寫雲端捷徑。
- 其他 Google 原生類型（例如 Google 表單）仍會明確列為略過。

## 開發驗證

在儲存庫根目錄執行：

```sh
python3 -m http.server 8000 --bind 127.0.0.1
node --test drive-sync/sync.test.cjs
```

本機開發開啟 `http://localhost:8000/drive-sync/`。正式使用者只需開啟已部署網站，不必安裝 Python。網路需允許 `accounts.google.com`、`apis.google.com`、`www.googleapis.com`、`drive.google.com` 及 Google 元件的必要靜態資源（例如 `www.gstatic.com`）。

自動測試使用模擬檔案系統與 Google API；不登入真實帳號、不上傳私人資料。真實 Google OAuth、Picker 與 Drive 雙向傳輸須在設定完成後另行驗證。
