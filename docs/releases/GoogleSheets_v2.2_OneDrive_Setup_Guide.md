# StockMarketGoogleSheets v2.2 — OneDrive Excel 同步測試

## 目的

v2.2 延續 v2.1 所有行情、籌碼、選擇權 OI / IV 與 Google「總表」功能，
新增 Microsoft Graph 同步：

Google 總表 → OneDrive Excel → `總表同步測試`

採增量更新：
- 相同資料日期：更新原列
- 新交易日：新增／依日期插入一列
- 不會每天重建整份 OneDrive Excel
- 測試階段不修改 OneDrive Excel 原有工作表

測試檔使用目前提供的 OneDrive 副本連結。

---

## A. 先建立 Microsoft Entra App registration

1. 開啟 Microsoft Entra admin center。
2. 進入 **App registrations → New registration**。
3. Name 可填：`Taiwan Market Google Sheets Sync`。
4. Supported account types：
   - 若只使用個人 Outlook / Hotmail / OneDrive：選 **Personal accounts only**。
   - 若未來也可能用公司 Microsoft 365：選 **Any Entra ID Tenant + Personal Microsoft accounts**。
5. 建立後，複製 **Application (client) ID**。
6. 到 **API permissions → Add a permission → Microsoft Graph → Delegated permissions**。
7. 加入：`Files.ReadWrite`。
8. 到 **Authentication → Advanced settings**：
   - `Allow public client flows` 設為 **Yes**。
9. 不需要建立 Client secret。

---

## B. 更新 Apps Script

1. Google 試算表 → **擴充功能 → Apps Script**。
2. 將目前 v2.1 `Code.gs` 全部替換為 `StockMarketGoogleSheets_v2.2_OneDrive.gs`。
3. 儲存。
4. 重新整理 Google 試算表頁面，讓選單更新。

---

## C. 第一次 OneDrive 授權

依序執行：

1. **台股行情工具 → OneDrive：設定 Microsoft Client ID**
   - 貼上步驟 A 的 Application (client) ID。

2. **OneDrive：開始授權**
   - Apps Script 會顯示 Microsoft 驗證網址與一次性代碼。

3. 在瀏覽器完成 Microsoft 登入與授權。
   - 請使用擁有／可編輯該 OneDrive 測試 Excel 的帳號。

4. 回 Google 試算表：
   **OneDrive：完成授權**

成功後，程式會：
- 解析 OneDrive 測試檔案
- 建立（若尚未存在）`總表同步測試`
- 寫入與 Google 總表相同的 67 欄雙層表頭

---

## D. 第一次同步測試

執行：

**台股行情工具 → OneDrive：同步最新總表列**

預期結果：
- OneDrive Excel 出現工作表 `總表同步測試`
- 最新一個交易日資料寫入第 3 列
- 再執行一次不會新增重複日期，而是更新同一列

---

## E. 每日自動同步

Microsoft 授權成功後，原本的 `updateMarketData()` 排程會變成：

1. 擷取行情
2. 更新 Google 原始資料表
3. 增量更新 Google「總表」
4. 增量同步本次日期到 OneDrive Excel

不需要另外建立 OneDrive 排程。

若 OneDrive 同步失敗：
- Google Sheets 的行情資料仍會保留
- 「執行紀錄」會顯示 `OneDrive同步：...` 錯誤訊息
- 不會因 OneDrive 失敗而刪除或回滾 Google 資料

---

## F. 安全性

- Apps Script 只要求 Microsoft Graph `Files.ReadWrite` delegated permission。
- OAuth 使用 Device Code Flow，不需要 Client secret。
- Refresh token 存在 Apps Script 的 **User Properties**，不是試算表儲存格。
- 測試工作表名稱：`總表同步測試`，避免覆寫既有 OneDrive Excel 內容。
- 若之後確認無誤，再把 `CONFIG.ONEDRIVE_WORKSHEET` 改成正式工作表名稱。

---

## G. 若 OneDrive 連結無法解析

目前程式會先使用你提供的 `doc.aspx?...` 連結透過 Microsoft Graph Shares API 解析。

若顯示無法解析：
1. 在 OneDrive 開啟測試 Excel。
2. 選 **共用 / Share → 複製連結 / Copy link**。
3. 將該 sharing URL 替換程式中的 `CONFIG.ONEDRIVE_SHARE_URL`。
4. 清除 OneDrive 授權快取後重新測試連線。

---

## H. 測試順序建議

1. OneDrive：設定 Microsoft Client ID
2. OneDrive：開始授權
3. Microsoft 網頁完成登入
4. OneDrive：完成授權
5. OneDrive：測試連線
6. OneDrive：同步最新總表列
7. 開 OneDrive Excel 確認 `總表同步測試`
8. 再執行一次同步，確認同日期不重複
