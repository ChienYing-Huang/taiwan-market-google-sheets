# Push This Reconstructed Repository to GitHub

建議 GitHub repository 名稱：`taiwan-market-google-sheets`

為保留所有 commit、branch 與 tag，請不要只用 GitHub 網頁逐檔上傳。

## 方法 A：使用完整 repository ZIP

1. 解壓 `taiwan-market-google-sheets-repository-with-history.zip`。
2. 在解壓後資料夾開啟終端機。
3. 在 GitHub 建立一個**空白 repository**（先不要建立 README / .gitignore / LICENSE）。
4. 執行：

```bash
git remote add origin https://github.com/<YOUR_ACCOUNT>/taiwan-market-google-sheets.git
git push -u origin main
git push origin experimental/onedrive-v2.2
git push origin --tags
```

## 方法 B：使用 Git bundle

```bash
git clone taiwan-market-google-sheets-history.bundle taiwan-market-google-sheets
cd taiwan-market-google-sheets
git remote remove origin
git remote add origin https://github.com/<YOUR_ACCOUNT>/taiwan-market-google-sheets.git
git push -u origin main
git push origin experimental/onedrive-v2.2
git push origin --tags
```

## Push 後應看到

Branches:
- `main`
- `experimental/onedrive-v2.2`

Stable tags:
- `v1.0` ～ `v2.1.4`

Experimental tag:
- `experimental-v2.2-onedrive`

Current source:
- `src/Code.gs` = v2.1.4

## Repository visibility

建議第一次先建立 **Private repository**。確認程式、參考檔與授權內容均適合公開後，再視需要改為 Public。
