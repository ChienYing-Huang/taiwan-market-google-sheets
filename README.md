# Taiwan Market Google Sheets Updater

Google Apps Script 專案，用於自動蒐集並整合臺灣股市／期貨／選擇權資料至 Google Sheets。

## Current stable release

**v2.1.5**

主要功能：

- 大盤現貨 OHLC、成交量與 K 棒衍生欄位
- 台指期日盤近月 OHLC 與正逆價差
- 小台／微台散戶多空比
- 臺指選擇權 Put/Call 未平倉量比
- 大額／法人台指期未平倉資料
- 月選、週三序列、週五序列的 Call/Put 最大 OI
- 價平履約價、Call/Put 成交價與 Black–Scholes IV
- 每日增量更新與歷史區間重新抓取／修復
- 週三序列採 `W1 → W2 → 當月月選 → W4 → W5`；到期日當天切換下一契約

## Repository structure

- `src/Code.gs`：目前正式版程式碼
- `archive/releases/`：所有正式歷史版本的完整程式碼副本
- `docs/releases/`：各版本升級說明／重建 release note
- `docs/VERSION_HISTORY.md`：完整版本沿革
- `docs/DECISIONS.md`：重要設計決策與被修正的歷史決策
- `docs/experiments/`：未採用實驗功能的紀錄
- `references/`：版型／資料設計參考檔
- `manifests/SHA256SUMS.txt`：來源檔案雜湊值

Git history 另外保留每個正式版本的 commit 與 tag，可直接在 GitHub 切換版本查看。

## Setup

1. 在 Google Sheets 開啟「擴充功能 → Apps Script」。
2. 將 `src/Code.gs` 貼入 Apps Script 的 `Code.gs`。
3. 儲存並依目前版本文件執行初始化／更新函式。
4. 每日排程沿用 `updateMarketData()`。

詳細升級資訊請見 `docs/releases/`。

## Versioning policy

- 正式版使用既有版本號：`v1.0` ～ `v2.1.4`。
- `main` 永遠指向目前採用的正式版。
- 未採用的功能放在 experimental branch，不讓實驗功能混入正式主線。
- 修復既有規則時，不覆寫舊版本；新增版本並在 changelog 中說明 superseded 關係。

## Data sources

專案主要使用臺灣證券交易所、臺灣期貨交易所官方資料，另有部分籌碼資料來源於公開網站。實際來源、備援順序與解析邏輯以各版本程式碼為準。

## License

目前尚未指定開源授權。若 repository 未來設為 public，建議在確認授權需求後再加入 LICENSE。

## v2.1.5 驗證

升級與歷史回填方式請見 [v2.1.5 升級說明](docs/releases/v2.1.5-upgrade.md)。

離線回歸測試：`node tests/regression.cjs`（使用 tests/fixtures 官方行情快照，不寫入線上試算表）。
