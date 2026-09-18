# Development Decision Log

## D001 — Google Sheets as the primary cloud data store
Google Apps Script 負責抓取與整理資料；Google Sheets 作為主要資料來源。這讓更新不依賴本機電腦是否開機。

## D002 — Prefer official TAIFEX/TWSE sources
能由 TWSE／TAIFEX 官方資料取得或推算者，優先使用官方來源。v1.4 因第三方網站阻擋 Apps Script，散戶多空比改由官方 OI 資料推算。

## D003 — Incremental updates instead of rebuilding history daily
自 v1.8 起，正常每日更新只新增／更新本次日期；完整重建保留給手動修復，降低執行時間與不必要寫入。

## D004 — Preserve source-sheet metadata, simplify summary table
自 v2.0 起，更新時間／狀態／資料來源留在來源表，總表只保留分析欄位。

## D005 — IV is an estimate, not a vendor field
期交所日行情沒有直接提供目標欄位的 IV，因此用 Black–Scholes 反推。v2.1 依比較結果把存續期間從日曆日年化改為交易日年化，並保留可調整當日權重。

## D006 — Expiry day is treated as already rolled
自 v2.1.2 起，資料日期等於到期日時不使用即將結算的契約，而使用下一個尚未到期契約。此規則同時用於 OI 與 IV。

## D007 — Third Wednesday belongs to the monthly contract
v2.1.2 曾把 W2 到期後的週三 W 選擇直接跳至 W4。v2.1.4 將此規則修正為：

`W1 → W2 → 當月月選 → W4 → W5`

也就是說，不建立虛構 W3；第三週由當月月選承接 W 區塊的位置。

## D008 — Historical repair must fail safe
歷史修復不以 query string 為唯一依據，而再次檢查來源頁面的實際資料日期。來源抓取失敗或日期不一致時，保留原資料而非寫入空值／錯日資料。

## D009 — OneDrive integration remains experimental
曾完成 Microsoft Graph OneDrive Excel 同步原型，但因整合成本考量未納入正式版。原型保留於 experimental branch，正式主線維持 Google Sheets；本機 Excel／LibreOffice 可改由 Google Sheets 發布 CSV 的方式讀取。

## 2026-09-18：v2.1.5 季節切換與實際掛牌

依本次使用者確認，修訂 v2.1 的「5–9 月用期貨」為「5 月起至 9 月結算前用期貨；9 月結算當日起用現貨」。原決策保留為歷史，不追溯改寫。
保留 50 點目標；目標未掛牌時，依各契約 Call／Put 共同掛牌履約價選距原始基準最近者，等距取高。未成交不作為改選較遠履約價的理由。
本月已有有效 OHLC 時不再查上月；本月請求全面失敗不以舊月掩蓋。只有確實空月份才退回上月。
