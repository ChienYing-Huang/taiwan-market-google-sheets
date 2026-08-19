# Version History

> 本檔在建立 GitHub 版本庫時，依保留的原始 `.gs`、升級說明與開發紀錄整理。  
> v1.1、v1.2 因未保留獨立升級說明，內容標示為「依原始碼差異重建」。

## Stable line

### v1.0 — Initial Google Sheets updater
- 建立 Google Apps Script 台股行情更新器。
- 擷取大盤現貨 OHLC。
- 擷取台指期近月 OHLC。
- 建立「每日行情」與「執行紀錄」。
- 建立每日約 20:00（Asia/Taipei）時間觸發器。

### v1.1 — TAIFEX API robustness（依原始碼差異重建）
- 台指期來源改為官方 OpenAPI JSON 優先。
- 加入官方 CSV 備援。
- 強化 JSON／CSV 欄位名稱、編碼與分隔符解析容錯。

### v1.2 — TAIFEX website day-session priority（依原始碼差異重建）
- 台指期改為期交所官網日盤行情頁優先。
- 明確驗證 08:45–13:45 一般交易時段，避免抓到夜盤。
- OpenAPI／CSV 保留為備援來源。

### v1.3 — Market positioning/chip data
- 新增「每日籌碼」。
- 新增小台／微台散戶多空比、Put/Call OI ratio。
- 新增前五大、前十大、前五特法、前十特法、外資、投信、自營商。
- 各來源以其實際資料日期寫入，避免不同日期資料混用。

### v1.4 — Retail ratio from official TAIFEX data
- 因原散戶多空比網站對 Apps Script 回傳 HTTP 403，改以期交所官方 OI 資料推算。
- 散戶多／空單 = 全市場 OI − 三大法人 OI。
- 加入日期一致性與負值防護。

### v1.5 — Unique-date key and duplicate repair
- 修正 Google Sheets Date object 與文字日期比較造成的重複列。
- 所有籌碼資料日期統一為 `yyyy-MM-dd` 唯一鍵。
- 新增既有重複列合併／修復功能。

### v1.6 — Option maximum OI
- 新增「選擇權OI」工作表。
- 記錄月選、週三 W、週五 F 契約的 Call/Put 最大 OI 履約價與 OI。
- 使用完整日盤行情與實際掛牌契約代碼。
- 並列最大 OI 履約價以 `／` 保留全部值。

### v1.7 — Integrated summary table
- 參考 `大盤每日紀錄_亮東(1).ods` 建立雙層分區總表。
- 整合每日行情、每日籌碼與選擇權 OI。
- 新增現貨漲跌與期現貨正逆價差。

### v1.8 — Incremental summary update
- 總表由每日完整重建改為增量更新。
- 新交易日新增；同日重跑更新原列。
- 保留手動完整重建功能作為修復工具。

### v1.9 — ATM price and implied volatility
- 新增月選／W／F 的價平履約價、Call/Put 最後成交價與 IV。
- 初版價平履約價以 100 點四捨五入。
- IV 使用 Black–Scholes 反推，初版存續期間使用日曆日／365。
- IV > 35% 加入條件格式。

### v2.0 — Summary layout redesign and volume
- 將 W/F/月選 OI 與 IV 拆成六個獨立總表區塊。
- 移除總表中的更新時間、狀態、資料來源欄位。
- 新增大盤成交量（張）、上影線、下影線、十字線、K棒長度。
- K 棒公式依原參考表邏輯實作。

### v2.1 — 50-point ATM and trading-day IV
- 價平履約價改為每 50 點四捨五入。
- IV 存續期間改採交易日年化。
- 加入當日交易日權重參數 `IV_CURRENT_TRADING_DAY_WEIGHT = 0.63`。
- IV 與總表成交價統一使用一般交易時段最後成交價。

### v2.1.1 — Summary columns refinement
- OI 與 IV 六個區塊移除「到期日」欄位。
- IV 欄位順序調整為：契約 → Call IV → Call 成交價 → 價平履約價 → Put 成交價 → Put IV。
- 總表由 67 欄縮減為 61 欄。

### v2.1.2 — Expiry-day rollover
- 契約選擇改為僅接受 `expiryDate > dataDate`。
- 到期日當天即切換下一個尚未到期契約。
- 月選、W、F 的 OI 與 IV 共用契約選擇結果。
- **後續 v2.1.4 修正第三週週三序列的處理方式。**

### v2.1.3 — Historical interval repair
- 新增指定起訖日期的歷史重新抓取／修復。
- 逐來源重新驗證，只有日期完全吻合且成功取得才覆寫。
- 新增「歷史修復紀錄」。
- 採小批次＋一次性觸發器續跑，降低 Apps Script timeout 風險。

### v2.1.4 — W3 position handled by monthly contract
- 修正週三到期序列：`W1 → W2 → 當月月選 → W4 → W5`。
- 因 W3 不存在，第三個週三由當月月選 `YYYYMM` 承接。
- 到期日當天仍直接切換下一個週三序列。
- W(OI) 與 W(IV) 共用同一週三序列選擇。
- 歷史修復同步套用此規則。

## Experimental branch

### experimental/onedrive-v2.2 — OneDrive Excel sync（未採用）
- 嘗試 Microsoft Graph + Device Code OAuth，把 Google 總表增量同步至 OneDrive Excel。
- 後續因 API／整合成本考量，決定不納入正式主線。
- 實驗程式仍保留於 Git branch，以保存完整開發歷史。
- GitHub 版本已遮罩原測試 OneDrive URL，避免暴露個人資源識別。
