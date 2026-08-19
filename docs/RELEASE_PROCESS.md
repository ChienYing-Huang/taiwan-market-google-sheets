# Release Process

後續建議每次修改都依以下方式留存：

1. 從 `main` 建立功能／修復 branch。
2. 修改 `src/Code.gs`。
3. 使用 `node --check` 對 `.gs` 內容進行 JavaScript 語法檢查。
4. 更新 `docs/VERSION_HISTORY.md` 與對應 release note。
5. 合併回 `main`。
6. 建立版本 tag，例如 `v2.1.5`。
7. GitHub Release 中附上變更摘要與必要的升級步驟。
8. 不刪除舊 tag，不重新覆寫舊版本程式碼。

版本命名延續目前格式：
- 主要功能／大版型：`v2.2`, `v3.0`
- 小功能／修復：`v2.1.5`, `v2.1.6`
