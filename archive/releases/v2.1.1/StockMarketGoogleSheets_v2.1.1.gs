/**
 * 台股現貨與台指期每日行情更新器
 * 資料來源：
 * 1. 臺灣證券交易所：發行量加權股價指數歷史資料
 * 2. 臺灣期貨交易所官網：期貨每日交易行情（日盤）
 * 3. 臺灣期貨交易所：小台指／微台指散戶多空比（由官方未平倉資料推算）
 * 4. 臺灣期貨交易所：臺指選擇權 Put/Call 比
 * 5. 聚財網：台指期大額與法人未平倉資料
 * 6. 臺灣期貨交易所：臺指選擇權完整日盤行情（各契約最大 OI 履約價）
 *
 * 使用方式：
 * 1. 在 Google 試算表開啟「擴充功能 → Apps Script」
 * 2. 將本檔完整貼到 Code.gs
 * 3. 儲存後執行 setupMarketUpdater()
 * 4. 首次執行需授權
 *
 * v2.1.1：只調整「總表」版型，不變更 v2.1 的擷取與 IV 計算。
 *         1) W/F/月選 OI 與 IV 區塊移除到期日。
 *         2) IV 欄位順序改為：
 *            契約、Call IV(>35)、Call成交價、價平履約價、Put成交價、Put IV(>35)。
 *         總表由 67 欄縮減為 61 欄，第一次升級會重建一次總表完成遷移。
 *
 * v2.1：價平履約價改為每 50 點四捨五入；IV 改採期交所說明的交易日
 *       年化方式，權利金採一般交易時段最後成交價。加入可調式當日權重，
 *       以降低近到期週五契約因日曆日年化造成的 IV 高估。
 *
 * v2.0：重新配置總表欄位，將 W／F／月選的 OI 與 IV 分成六個獨立區塊，
 *       移除總表中的更新時間、狀態與資料來源；大盤區新增成交量、上影線、
 *       下影線、十字線及 K 棒長度。日常仍採增量更新。
 *
 * v1.9：新增月選、W 週選、F 週選的價平履約價、Call／Put 最後成交價與
 *       Black-Scholes 估算 IV。價平履約價於 5–9 月採台指期日盤收盤價，
 *       其他月份採大盤現貨收盤價，四捨五入至百位；IV > 35 以條件格式標示。
 *
 * v1.8：總表改採增量更新。每日排程只新增或更新本次取得之資料日期，
 *       不再重建所有歷史資料；同日重跑會更新既有列，不會重複新增。
 *       「重建總表」仍保留為手動修復／首次匯入歷史資料用途。
 *
 * v1.7：新增依附件「亮東調整」邏輯設計的總表，將每日行情、選擇權 OI、
 *       P/C 比、散戶多空比及大額法人未平倉依資料日期整合為單一列。
 *
 * v1.6：新增臺指選擇權月選、週三到期 W 契約、週五到期 F 契約的
 *       Call／Put 最大未平倉量履約價與最大 OI。
 *       契約選擇直接依期交所實際掛牌代碼、契約到期日及正數 OI 判定，
 *       不自行推算週別，可處理 W3 由月選取代及休市順延等情況。
 *       延續 v1.5 的日期唯一鍵與重複列自動合併機制。
 */

const CONFIG = {
  TIMEZONE: 'Asia/Taipei',
  DATA_SHEET: '每日行情',
  CHIP_SHEET: '每日籌碼',
  OPTION_OI_SHEET: '選擇權OI',
  SUMMARY_SHEET: '總表',
  LOG_SHEET: '執行紀錄',
  TRIGGER_HOUR: 20,
  TRIGGER_MINUTE: 0,

  // 價平履約價每 50 點四捨五入。
  ATM_STRIKE_INTERVAL: 50,

  // IV 使用 Black-Scholes 反推，權利金與總表「成交價」一致，皆採
  // 期交所一般交易時段的最後成交價，以貼近券商畫面常見計算方式。
  // 結算價仍會解析保留，但不代替最後成交價。
  IV_USE_SETTLEMENT_PRICE: false,
  IV_RISK_FREE_RATE: 0.0,
  IV_DIVIDEND_YIELD: 0.0,
  IV_ALERT_THRESHOLD: 35,

  // 期交所理論價格計算頁說明：存續期間應以交易日數年化，分母為當年
  // 總交易日數。券商對「計算當日」剩餘天期的細節通常未公開；0.63 是依
  // 使用者提供之券商參考值設定的近似權重，可視實際券商結果微調 0~1。
  IV_CURRENT_TRADING_DAY_WEIGHT: 0.63,
  IV_MIN_TRADING_DAY_UNITS: 0.5,

  TWSE_HOLIDAY_URL:
    'https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&queryYear=',
  TWSE_HOLIDAY_OPENAPI_URL:
    'https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule',

  TWSE_URL:
    'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date=',

  // 每日市場成交資訊；成交股數除以 1,000 後以「張」寫入。
  TWSE_VOLUME_URL:
    'https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?response=json&date=',

  TWSE_VOLUME_OPENAPI_URL:
    'https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK',

  // 官網的 Excel 外部資料頁通常比 OpenAPI 更早提供當日日盤行情。
  TAIFEX_WEB_URL:
    'https://www.taifex.com.tw/cht/3/futDailyMarketExcel?commodity_id=TX',

  TAIFEX_OPENAPI_URL:
    'https://openapi.taifex.com.tw/v1/DailyMarketReportFut',

  TAIFEX_CSV_URL:
    'https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyMarketReportFut',

  // 小台指／微台指全市場未平倉量（日盤行情頁）。
  TAIFEX_RETAIL_DAILY_URL:
    'https://www.taifex.com.tw/cht/3/futDailyMarketExcel?commodity_id=',

  // 三大法人各期貨契約未平倉部位。
  TAIFEX_INSTITUTIONAL_URL:
    'https://www.taifex.com.tw/cht/3/futContractsDate',

  TAIFEX_PC_RATIO_URL:
    'https://www.taifex.com.tw/cht/3/pcRatio',

  WEARN_TAIFEX_URL:
    'https://stock.wearn.com/taifexphoto.asp',

  // 臺指選擇權完整日盤行情。官網通常較 OpenAPI 早提供當日資料。
  TAIFEX_OPTION_WEB_URL:
    'https://www.taifex.com.tw/cht/3/optDailyMarketExcel?commodity_id=TXO',

  TAIFEX_OPTION_OPENAPI_URL:
    'https://openapi.taifex.com.tw/v1/DailyMarketReportOpt',

  TAIFEX_OPTION_CSV_URL:
    'https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyMarketReportOpt',
};

const DATA_HEADERS = [
  '資料日期',
  '商品',
  '契約月份',
  '開盤',
  '最高',
  '最低',
  '收盤',
  '資料來源',
  '更新時間',
  '狀態',
  '成交量(張)',
];


const CHIP_HEADERS = [
  '資料日期',
  '小台指散戶多空比(%)',
  '微台指散戶多空比(%)',
  '買賣權未平倉量比率(%)',
  '前五大',
  '前十大',
  '前五特法',
  '前十特法',
  '外資',
  '投信',
  '自營商',
  '資料來源',
  '更新時間',
  '狀態',
];

const CHIP_FIELD_COLUMNS = {
  miniRetailRatio: 1,
  microRetailRatio: 2,
  pcOpenInterestRatio: 3,
  top5: 4,
  top10: 5,
  top5Special: 6,
  top10Special: 7,
  foreign: 8,
  investmentTrust: 9,
  dealer: 10,
};


const OPTION_OI_HEADERS = [
  '資料日期',
  '月選契約',
  '月選到期日',
  '月選買權最大OI履約價',
  '月選買權最大OI',
  '月選賣權最大OI履約價',
  '月選賣權最大OI',
  'W契約',
  'W到期日',
  'W買權最大OI履約價',
  'W買權最大OI',
  'W賣權最大OI履約價',
  'W賣權最大OI',
  'F契約',
  'F到期日',
  'F買權最大OI履約價',
  'F買權最大OI',
  'F賣權最大OI履約價',
  'F賣權最大OI',
  '資料來源',
  '更新時間',
  '狀態',
  // v1.9 新欄位附加於既有欄位之後，避免升級時破壞舊資料欄位位置。
  '月選價平履約價',
  '月選Call成交價',
  '月選Call IV(%)',
  '月選Put成交價',
  '月選Put IV(%)',
  'W價平履約價',
  'W Call成交價',
  'W Call IV(%)',
  'W Put成交價',
  'W Put IV(%)',
  'F價平履約價',
  'F Call成交價',
  'F Call IV(%)',
  'F Put成交價',
  'F Put IV(%)',
];

const LOG_HEADERS = ['執行時間', '結果', '訊息'];


// 「總表」採用分區式雙層表頭；OI 與 IV 分成六個獨立區塊。
const SUMMARY_SUB_HEADERS = [
  '資料日期',
  '星期',
  // 大盤現貨指數
  '開盤',
  '最高',
  '最低',
  '收盤',
  '漲跌',
  '成交量(張)',
  '上影線',
  '下影線',
  '十字線',
  'K棒長度',
  // 台指期貨指數
  '契約月份',
  '開盤',
  '最高',
  '最低',
  '收盤',
  '正逆價差',
  // W／F／月選 OI：移除到期日
  '契約',
  'Call最大OI履約價',
  'Call最大OI',
  'Put最大OI履約價',
  'Put最大OI',
  '契約',
  'Call最大OI履約價',
  'Call最大OI',
  'Put最大OI履約價',
  'Put最大OI',
  '契約',
  'Call最大OI履約價',
  'Call最大OI',
  'Put最大OI履約價',
  'Put最大OI',
  // W／F／月選 IV：契約 + Call IV、Call成交價、價平、Put成交價、Put IV
  '契約',
  'Call IV(>35)',
  'Call成交價',
  '價平履約價',
  'Put成交價',
  'Put IV(>35)',
  '契約',
  'Call IV(>35)',
  'Call成交價',
  '價平履約價',
  'Put成交價',
  'Put IV(>35)',
  '契約',
  'Call IV(>35)',
  'Call成交價',
  '價平履約價',
  'Put成交價',
  'Put IV(>35)',
  // 籌碼與未平倉
  'P/C未平倉量比(%)',
  '小台散戶多空比(%)',
  '微台散戶多空比(%)',
  '前五大',
  '前十大',
  '前五特法',
  '前十特法',
  '外資',
  '投信',
  '自營商',
];

const SUMMARY_GROUPS = [
  { start: 1, end: 1, label: '資料日期', fill: '#E7E6E6' },
  { start: 2, end: 2, label: '星期', fill: '#E7E6E6' },
  { start: 3, end: 12, label: '大盤現貨指數', fill: '#FFF2CC' },
  { start: 13, end: 18, label: '台指期貨指數', fill: '#FCE4D6' },
  { start: 19, end: 23, label: '週選擇權 W (OI)', fill: '#DDEBF7' },
  { start: 24, end: 28, label: '週選擇權 F (OI)', fill: '#D9EAD3' },
  { start: 29, end: 33, label: '月選擇權 (OI)', fill: '#E4DFEC' },
  { start: 34, end: 39, label: '週選擇權 W (IV)', fill: '#BDD7EE' },
  { start: 40, end: 45, label: '週選擇權 F (IV)', fill: '#C6E0B4' },
  { start: 46, end: 51, label: '月選擇權 (IV)', fill: '#D9E1F2' },
  { start: 52, end: 54, label: '市場籌碼', fill: '#E2F0D9' },
  { start: 55, end: 61, label: '台指期未平倉（大額近月、法人所有月）', fill: '#F4B183' },
];

/**
 * 開啟試算表時新增功能選單。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('台股行情工具')
    .addItem('立即更新', 'updateMarketData')
    .addItem('建立／重建排程', 'createDailyTrigger')
    .addItem('初始化工作表', 'initializeSheets')
    .addItem('合併重複籌碼列', 'repairChipSheetDuplicates')
    .addItem('整理選擇權 OI 重複列', 'repairOptionOiSheetDuplicates')
    .addItem('更新最近資料至總表', 'updateLatestSummaryRows')
    .addItem('重建總表（手動修復）', 'rebuildSummaryTable')
    .addToUi();
}

/**
 * 第一次使用時執行此函式。
 * 會初始化工作表、建立排程，並立即測試更新一次。
 */
function setupMarketUpdater() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  initializeSheets();
  createDailyTrigger();
  updateMarketData();
}

/**
 * 建立資料工作表與執行紀錄工作表。
 */
function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  const dataSheet = getOrCreateSheet_(ss, CONFIG.DATA_SHEET);
  ensureSheetColumnCount_(dataSheet, DATA_HEADERS.length);
  initializeHeader_(dataSheet, DATA_HEADERS);
  dataSheet.setFrozenRows(1);
  dataSheet.getRange('A:A').setNumberFormat('@');
  dataSheet.getRange('D:G').setNumberFormat('#,##0.00');
  dataSheet.getRange('I:I').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  dataSheet.getRange('K:K').setNumberFormat('#,##0');
  dataSheet.autoResizeColumns(1, DATA_HEADERS.length);

  const chipSheet = getOrCreateSheet_(ss, CONFIG.CHIP_SHEET);
  initializeHeader_(chipSheet, CHIP_HEADERS);
  chipSheet.setFrozenRows(1);
  chipSheet.getRange('A:A').setNumberFormat('@');
  chipSheet.getRange('B:D').setNumberFormat('0.00');
  chipSheet.getRange('E:K').setNumberFormat('#,##0');
  chipSheet.getRange('M:M').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  chipSheet.autoResizeColumns(1, CHIP_HEADERS.length);

  const optionOiSheet = getOrCreateSheet_(ss, CONFIG.OPTION_OI_SHEET);
  ensureSheetColumnCount_(optionOiSheet, OPTION_OI_HEADERS.length);
  initializeHeader_(optionOiSheet, OPTION_OI_HEADERS);
  optionOiSheet.setFrozenRows(1);
  formatOptionOiSheet_(optionOiSheet);

  ensureSummarySheet_();

  const logSheet = getOrCreateSheet_(ss, CONFIG.LOG_SHEET);
  initializeHeader_(logSheet, LOG_HEADERS);
  logSheet.setFrozenRows(1);
  logSheet.getRange('A:A').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  logSheet.autoResizeColumns(1, LOG_HEADERS.length);
}

/**
 * 建立每天約 20:00 執行的時間觸發器。
 * 程式會自行略過週六、週日；國定休市日不會新增錯誤交易日。
 */
function createDailyTrigger() {
  deleteTriggersByHandler_('updateMarketData');

  ScriptApp.newTrigger('updateMarketData')
    .timeBased()
    .atHour(CONFIG.TRIGGER_HOUR)
    .nearMinute(CONFIG.TRIGGER_MINUTE)
    .everyDays(1)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  writeLog_('成功', '已建立每日約 20:00（台北時間）更新排程。');
}

/**
 * 每日主要執行函式。
 */
function updateMarketData() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(30000)) {
    writeLog_('略過', '已有另一個更新程序正在執行。');
    return;
  }

  try {
    initializeSheets();

    const now = new Date();
    const weekday = Number(
      Utilities.formatDate(now, CONFIG.TIMEZONE, 'u')
    );

    if (weekday >= 6) {
      writeLog_('略過', '今日為週末，未執行行情更新。');
      return;
    }

    const today = Utilities.formatDate(
      now,
      CONFIG.TIMEZONE,
      'yyyy-MM-dd'
    );

    const results = [];
    const errors = [];
    // 僅更新本次實際取得的資料日期，避免每日重建整份總表。
    const summaryDates = new Set();

    try {
      const spot = fetchTwseTaiex_();
      spot.status =
        spot.date === today ? '當日資料' : '最近可用交易日';
      upsertMarketRow_(spot);
      summaryDates.add(spot.date);
      results.push(`大盤現貨 ${spot.date}`);
    } catch (error) {
      errors.push(`大盤現貨：${error.message}`);
    }

    try {
      const future = fetchTaifexTx_();
      future.status =
        future.date === today ? '當日資料' : '最近可用交易日';
      upsertMarketRow_(future);
      summaryDates.add(future.date);
      results.push(`台指期 ${future.date} ${future.contractMonth}`);
    } catch (error) {
      errors.push(`台指期：${error.message}`);
    }

    try {
      const retailRatios = fetchTaifexRetailRatios_();

      upsertChipFields_({
        date: retailRatios.mini.date,
        miniRetailRatio: retailRatios.mini.ratio,
        source: '臺灣期貨交易所－官方未平倉資料推算（小台指）',
        status:
          retailRatios.mini.date === today
            ? '當日資料'
            : '最近可用交易日',
      });
      summaryDates.add(retailRatios.mini.date);
      results.push(`小台散戶比 ${retailRatios.mini.date}`);

      upsertChipFields_({
        date: retailRatios.micro.date,
        microRetailRatio: retailRatios.micro.ratio,
        source: '臺灣期貨交易所－官方未平倉資料推算（微台指）',
        status:
          retailRatios.micro.date === today
            ? '當日資料'
            : '最近可用交易日',
      });
      summaryDates.add(retailRatios.micro.date);
      results.push(`微台散戶比 ${retailRatios.micro.date}`);
    } catch (error) {
      errors.push(`散戶多空比：${error.message}`);
    }

    try {
      const pcRatio = fetchTaifexPcRatio_();
      upsertChipFields_({
        date: pcRatio.date,
        pcOpenInterestRatio: pcRatio.openInterestRatio,
        source: '臺灣期貨交易所－臺指選擇權 Put/Call 比',
        status:
          pcRatio.date === today ? '當日資料' : '最近可用交易日',
      });
      summaryDates.add(pcRatio.date);
      results.push(`P/C未平倉比 ${pcRatio.date}`);
    } catch (error) {
      errors.push(`P/C未平倉比：${error.message}`);
    }

    try {
      const positions = fetchWearnTaifexPositions_();
      upsertChipFields_({
        date: positions.date,
        top5: positions.top5,
        top10: positions.top10,
        top5Special: positions.top5Special,
        top10Special: positions.top10Special,
        foreign: positions.foreign,
        investmentTrust: positions.investmentTrust,
        dealer: positions.dealer,
        source: '聚財網－台指期未平倉（大額近月、法人所有月）',
        status:
          positions.date === today ? '當日資料' : '最近可用交易日',
      });
      summaryDates.add(positions.date);
      results.push(`大額法人未平倉 ${positions.date}`);
    } catch (error) {
      errors.push(`大額法人未平倉：${error.message}`);
    }

    try {
      const optionOi = fetchTaifexOptionOiMaxima_();
      const optionDateStatus =
        optionOi.date === today ? '當日資料' : '最近可用交易日';
      optionOi.status = optionOi.atmComplete
        ? optionDateStatus
        : `${optionDateStatus}／價平成交價或IV部分缺漏`;
      upsertOptionOiRow_(optionOi);
      summaryDates.add(optionOi.date);
      results.push(
        `選擇權OI ${optionOi.date} ` +
        `${optionOi.monthly.contract}／` +
        `${optionOi.weeklyWednesday.contract}／` +
        `${optionOi.weeklyFriday.contract}`
      );
    } catch (error) {
      errors.push(`選擇權OI：${error.message}`);
    }

    if (summaryDates.size > 0) {
      try {
        const summaryResult = upsertSummaryDates_(Array.from(summaryDates));
        results.push(
          `總表新增 ${summaryResult.added} 列、更新 ${summaryResult.updated} 列`
        );
      } catch (error) {
        errors.push(`總表：${error.message}`);
      }
    }

    if (errors.length > 0 && results.length === 0) {
      throw new Error(errors.join('；'));
    }

    const message = [
      results.length ? `完成：${results.join('、')}` : '',
      errors.length ? `部分失敗：${errors.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('。');

    writeLog_(errors.length ? '部分成功' : '成功', message);
  } catch (error) {
    writeLog_('失敗', error.stack || error.message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 取得臺灣加權指數最近可用交易日的 OHLC。
 * 會同時查詢本月與上月，以處理月初連假或休市情況。
 */
function fetchTwseTaiex_() {
  const now = new Date();
  const queryMonths = [
    monthStartKey_(now),
    monthStartKey_(
      new Date(now.getFullYear(), now.getMonth() - 1, 1)
    ),
  ];

  const records = [];

  queryMonths.forEach((monthKey) => {
    const url = CONFIG.TWSE_URL + monthKey;
    const response = fetchUrl_(url);
    const json = JSON.parse(response.getContentText('UTF-8'));

    if (!Array.isArray(json.data) || !Array.isArray(json.fields)) {
      return;
    }

    const dateIndex = findHeaderIndex_(
      json.fields,
      ['日期']
    );
    const openIndex = findHeaderIndex_(
      json.fields,
      ['開盤指數', '開盤']
    );
    const highIndex = findHeaderIndex_(
      json.fields,
      ['最高指數', '最高']
    );
    const lowIndex = findHeaderIndex_(
      json.fields,
      ['最低指數', '最低']
    );
    const closeIndex = findHeaderIndex_(
      json.fields,
      ['收盤指數', '收盤']
    );

    json.data.forEach((row) => {
      const date = parseTwseDate_(row[dateIndex]);
      const open = parseNumber_(row[openIndex]);
      const high = parseNumber_(row[highIndex]);
      const low = parseNumber_(row[lowIndex]);
      const close = parseNumber_(row[closeIndex]);

      if (
        date &&
        [open, high, low, close].every(Number.isFinite)
      ) {
        records.push({ date, open, high, low, close });
      }
    });
  });

  if (records.length === 0) {
    throw new Error('證交所未回傳可用的加權指數資料。');
  }

  records.sort((a, b) => b.date.localeCompare(a.date));
  const latest = records[0];
  const volume = fetchTwseTradeVolume_(latest.date);

  return {
    ...latest,
    volume,
    product: '大盤現貨指數',
    contractMonth: '',
    source: '臺灣證券交易所',
  };
}

/**
 * 取得指定交易日之大盤成交量，單位轉為「張」。
 * 優先使用證交所月彙總端點；若當日頁面暫時異常，再以 OpenAPI 備援。
 */
function fetchTwseTradeVolume_(dateText) {
  const compactDate = String(dateText || '').replace(/-/g, '');
  const errors = [];

  try {
    const response = fetchUrl_(CONFIG.TWSE_VOLUME_URL + compactDate);
    const json = JSON.parse(response.getContentText('UTF-8'));
    const rows = [];
    const containers = [];

    if (Array.isArray(json.fields) && Array.isArray(json.data)) {
      containers.push(json);
    }
    (json.tables || []).forEach((table) => containers.push(table));

    containers.forEach((table) => {
      const fields = Array.isArray(table.fields) ? table.fields : [];
      const dateIndex = findHeaderIndex_(fields, ['日期', 'Date'], false);
      const volumeIndex = findHeaderIndex_(
        fields,
        ['成交股數', '成交股數(股)', 'TradeVolume'],
        false
      );

      if (dateIndex < 0 || volumeIndex < 0 || !Array.isArray(table.data)) {
        return;
      }

      table.data.forEach((row) => {
        rows.push({
          date: parseTwseDate_(row[dateIndex]),
          shares: parseNumber_(row[volumeIndex]),
        });
      });
    });

    const matched = rows.find(
      (item) => item.date === dateText && Number.isFinite(item.shares)
    );

    if (matched) {
      return Math.round(matched.shares / 1000);
    }

    throw new Error(`月成交資訊未包含 ${dateText}`);
  } catch (error) {
    errors.push(`官網：${error.message}`);
  }

  try {
    const response = fetchUrl_(CONFIG.TWSE_VOLUME_OPENAPI_URL);
    const data = JSON.parse(response.getContentText('UTF-8'));
    const rows = Array.isArray(data) ? data : [];
    const matched = rows.find((row) => {
      const rowDate = parseTwseDate_(
        getObjectField_(row, ['Date', '日期'])
      );
      return rowDate === dateText;
    });

    if (!matched) {
      throw new Error(`OpenAPI 未包含 ${dateText}`);
    }

    const shares = parseNumber_(
      getObjectField_(matched, ['TradeVolume', '成交股數'])
    );

    if (!Number.isFinite(shares)) {
      throw new Error('OpenAPI 成交股數無法解析');
    }

    return Math.round(shares / 1000);
  } catch (error) {
    errors.push(`OpenAPI：${error.message}`);
  }

  throw new Error(`無法取得大盤成交量（${errors.join('；')}）`);
}

/**
 * 取得臺股期貨 TX 最近可用之一般交易時段近月契約 OHLC。
 */
function fetchTaifexTx_() {
  const errors = [];

  // 優先讀取期交所官網的日盤行情頁；通常可較早取得當日資料。
  try {
    return fetchTaifexTxFromWebsite_();
  } catch (error) {
    errors.push(`官網：${error.message}`);
  }

  // 官網結構暫時異常時，退回官方 OpenAPI。
  try {
    return fetchTaifexTxFromOpenApi_();
  } catch (error) {
    errors.push(`OpenAPI：${error.message}`);
  }

  // 最後再嘗試官方 CSV 下載檔。
  try {
    return fetchTaifexTxFromCsv_();
  } catch (error) {
    errors.push(`CSV：${error.message}`);
  }

  throw new Error(errors.join('；'));
}

/**
 * 從期交所官網「期貨每日交易行情查詢」頁取得 TX 日盤資料。
 * 頁面會明確標示 08:45~13:45 一般交易時段，避免誤抓夜盤。
 */
function fetchTaifexTxFromWebsite_() {
  // 加入時間戳避免中介快取回傳前一次內容。
  const separator = CONFIG.TAIFEX_WEB_URL.includes('?') ? '&' : '?';
  const url =
    CONFIG.TAIFEX_WEB_URL + separator + '_ts=' + new Date().getTime();
  const response = fetchUrl_(url);

  let html = response.getContentText('UTF-8');

  if (!html || html.length < 500) {
    throw new Error('官網回傳內容為空或過短。');
  }

  // 確認頁面是日盤一般交易時段，而非盤後交易時段。
  const plainText = normalizeWhitespace_(decodeHtmlEntities_(stripHtml_(html)));

  if (!/08:45\s*[~～-]\s*13:45/.test(plainText) ||
      !/一般交易時段/.test(plainText)) {
    throw new Error('頁面未確認為 08:45–13:45 一般交易時段。');
  }

  const dateMatch = plainText.match(
    /日期[：:]?\s*(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/
  );

  if (!dateMatch) {
    throw new Error('找不到官網行情日期。');
  }

  const pageDate = formatDateParts_(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3])
  );

  const rows = [];
  const rowMatches = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  rowMatches.forEach((rowHtml) => {
    const cells = [];
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;

    while ((match = cellRegex.exec(rowHtml)) !== null) {
      cells.push(
        normalizeWhitespace_(
          decodeHtmlEntities_(stripHtml_(match[1]))
        )
      );
    }

    // 單式契約列格式：TX、YYYYMM、開、高、低、最後成交價……
    if (
      cells.length >= 6 &&
      cells[0].toUpperCase() === 'TX' &&
      /^\d{6}$/.test(cells[1])
    ) {
      rows.push({
        date: pageDate,
        contract: 'TX',
        contractMonth: cells[1],
        open: parseNumber_(cells[2]),
        high: parseNumber_(cells[3]),
        low: parseNumber_(cells[4]),
        close: parseNumber_(cells[5]),
        session: '一般交易時段',
      });
    }
  });

  if (rows.length === 0) {
    throw new Error('官網頁面中找不到 TX 單式契約行情列。');
  }

  const result = selectLatestTaifexTx_(rows);
  result.source = '臺灣期貨交易所官網（日盤行情頁）';
  return result;
}

/**
 * 從期交所官方 OpenAPI JSON 取得資料。
 */
function fetchTaifexTxFromOpenApi_() {
  const response = fetchUrl_(CONFIG.TAIFEX_OPENAPI_URL);
  const text = response
    .getContentText('UTF-8')
    .replace(/^\uFEFF/, '')
    .trim();

  if (!text) {
    throw new Error('回傳內容為空。');
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error('回傳內容不是有效 JSON。');
  }

  const rows = extractArrayFromJson_(json);

  if (rows.length === 0) {
    throw new Error('JSON 中沒有行情資料列。');
  }

  const normalizedRows = rows
    .filter(
      (row) => row && typeof row === 'object' && !Array.isArray(row)
    )
    .map((row) => ({
      date: parseGenericDate_(
        getObjectField_(row, [
          'Date',
          'TradeDate',
          'TradingDate',
          '交易日期',
          '日期',
        ])
      ),
      contract: String(
        getObjectField_(row, [
          'Contract',
          'ContractCode',
          '商品契約代號',
          '契約',
          '商品代號',
        ]) || ''
      )
        .trim()
        .toUpperCase(),
      contractMonth: String(
        getObjectField_(row, [
          'ContractMonth(Week)',
          'Contract Month(Week)',
          'ContractMonthWeek',
          'ExpiryMonthWeek',
          '到期月份(週別)',
          '到期月份週別',
          '到期月份',
        ]) || ''
      )
        .trim()
        .replace(/\s/g, ''),
      open: parseNumber_(
        getObjectField_(row, ['Open', 'OpenPrice', '開盤價'])
      ),
      high: parseNumber_(
        getObjectField_(row, ['High', 'HighPrice', '最高價'])
      ),
      low: parseNumber_(
        getObjectField_(row, ['Low', 'LowPrice', '最低價'])
      ),
      close: parseNumber_(
        getObjectField_(row, [
          'Last',
          'LastPrice',
          'Close',
          'ClosePrice',
          '最後成交價',
          '收盤價',
        ])
      ),
      session: String(
        getObjectField_(row, [
          'TradingSession',
          'Trading Session',
          'Session',
          '交易時段',
        ]) || ''
      ).trim(),
    }));

  return selectLatestTaifexTx_(normalizedRows);
}

/**
 * 從期交所官方 CSV 下載檔取得資料。
 * 可容忍標題列前的空白／說明列，以及 UTF-8、Big5、逗號或 Tab 格式。
 */
function fetchTaifexTxFromCsv_() {
  const response = fetchUrl_(CONFIG.TAIFEX_CSV_URL);
  const attempts = [];

  ['UTF-8', 'Big5'].forEach((encoding) => {
    let text;

    try {
      text = response
        .getContentText(encoding)
        .replace(/^\uFEFF/, '')
        .trim();
    } catch (error) {
      return;
    }

    if (!text) {
      return;
    }

    [',', '\t', ';'].forEach((delimiter) => {
      try {
        const table = Utilities.parseCsv(text, delimiter);

        if (!Array.isArray(table) || table.length < 2) {
          return;
        }

        const headerRowIndex = findTaifexHeaderRow_(table);

        if (headerRowIndex < 0) {
          return;
        }

        attempts.push({ table, headerRowIndex });
      } catch (error) {
        // 繼續嘗試其他編碼或分隔符號。
      }
    });
  });

  if (attempts.length === 0) {
    throw new Error('找不到可辨識的期交所 CSV 標題列。');
  }

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const table = attempt.table;
      const headerRowIndex = attempt.headerRowIndex;
      const headers = table[headerRowIndex].map(normalizeHeader_);
      const dataRows = table.slice(headerRowIndex + 1);

      const dateIndex = findHeaderIndex_(headers, [
        '交易日期',
        '日期',
        'Date',
        'TradeDate',
      ]);
      const contractIndex = findHeaderIndex_(headers, [
        '商品契約代號',
        '契約',
        '商品代號',
        'Contract',
        'ContractCode',
      ]);
      const expiryIndex = findHeaderIndex_(headers, [
        '到期月份(週別)',
        '到期月份週別',
        '到期月份',
        'ContractMonth(Week)',
        'ContractMonthWeek',
      ]);
      const openIndex = findHeaderIndex_(headers, [
        '開盤價',
        'Open',
        'OpenPrice',
      ]);
      const highIndex = findHeaderIndex_(headers, [
        '最高價',
        'High',
        'HighPrice',
      ]);
      const lowIndex = findHeaderIndex_(headers, [
        '最低價',
        'Low',
        'LowPrice',
      ]);
      const closeIndex = findHeaderIndex_(headers, [
        '最後成交價',
        '收盤價',
        'Last',
        'LastPrice',
        'Close',
      ]);
      const sessionIndex = findHeaderIndex_(
        headers,
        ['交易時段', 'TradingSession', 'Session'],
        false
      );

      const normalizedRows = dataRows.map((row) => ({
        date: parseGenericDate_(row[dateIndex]),
        contract: String(row[contractIndex] || '')
          .trim()
          .toUpperCase(),
        contractMonth: String(row[expiryIndex] || '')
          .trim()
          .replace(/\s/g, ''),
        open: parseNumber_(row[openIndex]),
        high: parseNumber_(row[highIndex]),
        low: parseNumber_(row[lowIndex]),
        close: parseNumber_(row[closeIndex]),
        session:
          sessionIndex >= 0
            ? String(row[sessionIndex] || '').trim()
            : '',
      }));

      return selectLatestTaifexTx_(normalizedRows);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('CSV 中沒有可用的 TX 行情。');
}


/**
 * 由期交所官方資料推算小台指與微台指散戶多空比。
 *
 * 計算方式：
 * 散戶多單 = 全市場未平倉量 - 三大法人多方未平倉量
 * 散戶空單 = 全市場未平倉量 - 三大法人空方未平倉量
 * 散戶多空比 = (散戶多單 - 散戶空單) / 全市場未平倉量 × 100%
 *              = (法人空方未平倉量 - 法人多方未平倉量)
 *                / 全市場未平倉量 × 100%
 */
function fetchTaifexRetailRatios_() {
  const institutions = fetchTaifexInstitutionalOpenInterest_();
  const miniMarket = fetchTaifexTotalOpenInterest_('MTX');
  const microMarket = fetchTaifexTotalOpenInterest_('TMF');

  const mini = calculateRetailRatio_(
    miniMarket,
    institutions.MTX,
    '小台指'
  );
  const micro = calculateRetailRatio_(
    microMarket,
    institutions.TMF,
    '微台指'
  );

  return { mini, micro };
}

/**
 * 取得指定商品的全市場未平倉量。
 * 會加總所有單式月份／週契約，排除跨月價差列。
 */
function fetchTaifexTotalOpenInterest_(contractCode) {
  const baseUrl =
    CONFIG.TAIFEX_RETAIL_DAILY_URL +
    encodeURIComponent(contractCode);
  const html = fetchHtmlWithCacheBust_(baseUrl, ['UTF-8']);
  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );

  if (
    !/08:45\s*[~～-]\s*13:45/.test(plainText) ||
    !plainText.includes('一般交易時段')
  ) {
    throw new Error(`${contractCode} 行情頁不是一般交易時段資料。`);
  }

  const dateMatch = plainText.match(
    /日期[：:]?\s*(\d{4})[\/. -](\d{1,2})[\/. -](\d{1,2})/
  );

  if (!dateMatch) {
    throw new Error(`${contractCode} 行情頁找不到資料日期。`);
  }

  const date = formatDateParts_(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3])
  );
  const rows = extractHtmlTableRows_(html);
  let totalOpenInterest = 0;
  let matchedRows = 0;

  rows.forEach((cells) => {
    if (
      cells.length < 13 ||
      String(cells[0] || '').trim().toUpperCase() !== contractCode ||
      !cells[1] ||
      String(cells[1]).includes('/')
    ) {
      return;
    }

    const openInterest = parseNumber_(cells[12]);

    if (Number.isFinite(openInterest)) {
      totalOpenInterest += openInterest;
      matchedRows += 1;
    }
  });

  if (matchedRows === 0 || totalOpenInterest <= 0) {
    throw new Error(`${contractCode} 行情頁找不到未平倉量。`);
  }

  return {
    date,
    contractCode,
    totalOpenInterest,
  };
}

/**
 * 取得期交所三大法人中 MTX、TMF 的多方與空方未平倉口數合計。
 */
function fetchTaifexInstitutionalOpenInterest_() {
  const html = fetchHtmlWithCacheBust_(
    CONFIG.TAIFEX_INSTITUTIONAL_URL,
    ['UTF-8']
  );
  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );
  const dateMatch = plainText.match(
    /日期\s*(\d{4})[\/. -](\d{1,2})[\/. -](\d{1,2})/
  );

  if (!dateMatch) {
    throw new Error('三大法人頁面找不到資料日期。');
  }

  const date = formatDateParts_(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3])
  );
  const rows = extractHtmlTableRows_(html);
  const productMap = {
    小型臺指期貨: 'MTX',
    小型台指期貨: 'MTX',
    微型臺指期貨: 'TMF',
    微型台指期貨: 'TMF',
  };
  const result = {
    MTX: {
      date,
      contractCode: 'MTX',
      institutionalLong: 0,
      institutionalShort: 0,
      identities: 0,
    },
    TMF: {
      date,
      contractCode: 'TMF',
      institutionalLong: 0,
      institutionalShort: 0,
      identities: 0,
    },
  };
  let currentCode = '';

  rows.forEach((cells) => {
    if (!cells || cells.length === 0) {
      return;
    }

    let identity = '';
    let longOiIndex = -1;
    let shortOiIndex = -1;

    // 每個商品的第一列：序號、商品名稱、身份別、後續數值。
    // 遇到非目標商品時要清空 currentCode，避免把下一列投信／外資
    // 誤算到前一個 MTX 或 TMF 商品。
    if (
      cells.length >= 15 &&
      /^(自營商|投信|外資)/.test(String(cells[2] || '').trim())
    ) {
      const productName = normalizeWhitespace_(cells[1]);
      currentCode = productMap[productName] || '';

      if (!currentCode) {
        return;
      }

      identity = String(cells[2] || '').trim();
      longOiIndex = 9;
      shortOiIndex = 11;
    } else if (
      currentCode &&
      cells.length >= 13 &&
      /^(自營商|投信|外資)/.test(String(cells[0] || '').trim())
    ) {
      // 同一商品的後續列因 rowspan 不再重複商品名稱。
      identity = String(cells[0] || '').trim();
      longOiIndex = 7;
      shortOiIndex = 9;
    } else {
      return;
    }

    if (!/^(自營商|投信|外資)/.test(identity)) {
      return;
    }

    const longOi = parseNumber_(cells[longOiIndex]);
    const shortOi = parseNumber_(cells[shortOiIndex]);

    if (!Number.isFinite(longOi) || !Number.isFinite(shortOi)) {
      return;
    }

    result[currentCode].institutionalLong += longOi;
    result[currentCode].institutionalShort += shortOi;
    result[currentCode].identities += 1;
  });

  ['MTX', 'TMF'].forEach((code) => {
    if (result[code].identities < 3) {
      throw new Error(`${code} 三大法人未平倉資料不完整。`);
    }
  });

  return result;
}

function calculateRetailRatio_(market, institution, label) {
  if (!market || !institution) {
    throw new Error(`${label} 缺少未平倉資料。`);
  }

  if (market.date !== institution.date) {
    throw new Error(
      `${label} 日期不一致：全市場 ${market.date}、三大法人 ${institution.date}`
    );
  }

  const total = market.totalOpenInterest;
  const retailLong = total - institution.institutionalLong;
  const retailShort = total - institution.institutionalShort;

  if (total <= 0 || retailLong < 0 || retailShort < 0) {
    throw new Error(`${label} 推算結果不合理，已停止寫入。`);
  }

  const ratio = roundTo_(
    ((retailLong - retailShort) / total) * 100,
    2
  );

  return {
    date: market.date,
    ratio,
    totalOpenInterest: total,
    retailLong,
    retailShort,
    institutionalLong: institution.institutionalLong,
    institutionalShort: institution.institutionalShort,
  };
}

function roundTo_(value, digits) {
  const factor = Math.pow(10, digits);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * 取得期交所臺指選擇權 Put/Call 未平倉量比率。
 */
function fetchTaifexPcRatio_() {
  const html = fetchHtmlWithCacheBust_(
    CONFIG.TAIFEX_PC_RATIO_URL,
    ['UTF-8']
  );
  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );

  if (!plainText.includes('買賣權未平倉量比率')) {
    throw new Error('頁面中找不到買賣權未平倉量比率欄位。');
  }

  const rows = extractHtmlTableRows_(html);
  const candidates = rows
    .filter((cells) => cells.length >= 7)
    .map((cells) => ({
      date: parseGenericDate_(cells[0]),
      openInterestRatio: parseNumber_(cells[6]),
    }))
    .filter(
      (row) =>
        row.date && Number.isFinite(row.openInterestRatio)
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  if (candidates.length === 0) {
    throw new Error('找不到可用的 Put/Call 未平倉量比資料列。');
  }

  return candidates[0];
}

/**
 * 取得聚財網台指期大額與三大法人未平倉資料。
 * 網頁日期為民國年，parseGenericDate_ 會自動轉為西元日期。
 */
function fetchWearnTaifexPositions_() {
  const html = fetchHtmlWithCacheBust_(
    CONFIG.WEARN_TAIFEX_URL,
    ['UTF-8', 'Big5'],
    ['前五大', '前十大', '外資', '投信', '自營商']
  );
  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );

  if (
    !plainText.includes('前五大') ||
    !plainText.includes('前十大') ||
    !plainText.includes('外資')
  ) {
    throw new Error('頁面中找不到大額／法人未平倉欄位。');
  }

  const rows = extractHtmlTableRows_(html);
  const candidates = rows
    .filter((cells) => cells.length >= 9)
    .map((cells) => ({
      date: parseGenericDate_(cells[0]),
      top5: parseNumber_(cells[1]),
      top10: parseNumber_(cells[2]),
      top5Special: parseNumber_(cells[3]),
      top10Special: parseNumber_(cells[4]),
      foreign: parseNumber_(cells[5]),
      investmentTrust: parseNumber_(cells[6]),
      dealer: parseNumber_(cells[7]),
    }))
    .filter(
      (row) =>
        row.date &&
        [
          row.top5,
          row.top10,
          row.top5Special,
          row.top10Special,
          row.foreign,
          row.investmentTrust,
          row.dealer,
        ].every(Number.isFinite)
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  if (candidates.length === 0) {
    throw new Error('找不到可用的大額／法人未平倉資料列。');
  }

  return candidates[0];
}


/**
 * 取得臺指選擇權月選、W 週三選及 F 週五選的最大 OI 履約價。
 * 優先讀取期交所官網完整日盤行情，OpenAPI 與 CSV 僅作備援。
 */
function fetchTaifexOptionOiMaxima_() {
  const errors = [];

  try {
    return fetchTaifexOptionOiFromWebsite_();
  } catch (error) {
    errors.push(`官網：${error.message}`);
  }

  try {
    return fetchTaifexOptionOiFromOpenApi_();
  } catch (error) {
    errors.push(`OpenAPI：${error.message}`);
  }

  try {
    return fetchTaifexOptionOiFromCsv_();
  } catch (error) {
    errors.push(`CSV：${error.message}`);
  }

  throw new Error(errors.join('；'));
}

/**
 * 從期交所官網「選擇權每日交易行情查詢」完整表取得 TXO 日盤資料。
 * 不使用行情簡表，避免最大 OI 履約價落在簡表揭露範圍之外。
 */
function fetchTaifexOptionOiFromWebsite_() {
  const html = fetchHtmlWithCacheBust_(
    CONFIG.TAIFEX_OPTION_WEB_URL,
    ['UTF-8'],
    ['臺指選擇權', '未沖銷契約量']
  );

  if (!html || html.length < 1000) {
    throw new Error('官網回傳內容為空或過短。');
  }

  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );

  if (
    !/08:45\s*[~～-]\s*13:45/.test(plainText) ||
    !/一般交易時段/.test(plainText)
  ) {
    throw new Error('頁面未確認為 08:45–13:45 一般交易時段。');
  }

  const dateMatch = plainText.match(
    /日期[：:]?\s*(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})/
  );

  if (!dateMatch) {
    throw new Error('找不到選擇權官網行情日期。');
  }

  const pageDate = formatDateParts_(
    Number(dateMatch[1]),
    Number(dateMatch[2]),
    Number(dateMatch[3])
  );
  const tableRows = extractHtmlTableRows_(html);
  const headerRowIndex = findTaifexOptionHeaderRow_(tableRows);

  if (headerRowIndex < 0) {
    throw new Error('找不到選擇權完整行情表標題列。');
  }

  const headers = tableRows[headerRowIndex].map(normalizeHeader_);
  const indices = getTaifexOptionColumnIndices_(headers);
  const maxIndex = Math.max(...Object.values(indices));
  const normalizedRows = [];

  tableRows.slice(headerRowIndex + 1).forEach((cells) => {
    if (!Array.isArray(cells) || cells.length <= maxIndex) {
      return;
    }

    const contract = String(cells[indices.contract] || '')
      .trim()
      .toUpperCase();
    const contractMonth = String(cells[indices.contractMonth] || '')
      .trim()
      .replace(/\s/g, '')
      .toUpperCase();

    if (contract !== 'TXO' || !isTrackedTxoContract_(contractMonth)) {
      return;
    }

    const strike = parseNumber_(cells[indices.strike]);
    const side = normalizeOptionSide_(cells[indices.side]);
    const parsedOi = parseNumber_(cells[indices.openInterest]);
    const parsedLastPrice =
      indices.lastPrice >= 0
        ? parseNumber_(cells[indices.lastPrice])
        : NaN;
    const parsedSettlementPrice =
      indices.settlementPrice >= 0
        ? parseNumber_(cells[indices.settlementPrice])
        : NaN;

    if (!Number.isFinite(strike) || !side) {
      return;
    }

    normalizedRows.push({
      date: pageDate,
      contract,
      contractMonth,
      expiryDate:
        indices.expiryDate >= 0
          ? parseGenericDate_(cells[indices.expiryDate])
          : '',
      strike,
      side,
      openInterest: Number.isFinite(parsedOi) ? parsedOi : 0,
      lastPrice: Number.isFinite(parsedLastPrice) ? parsedLastPrice : NaN,
      settlementPrice: Number.isFinite(parsedSettlementPrice)
        ? parsedSettlementPrice
        : NaN,
      session: '一般交易時段',
    });
  });

  const result = buildTaifexOptionOiSummary_(normalizedRows);
  result.source =
    '臺灣期貨交易所官網－選擇權完整日盤行情；' +
    'IV依Black-Scholes反推（交易日年化、最後成交價）';
  return result;
}

/**
 * 從期交所 OpenAPI 取得選擇權每日行情。
 */
function fetchTaifexOptionOiFromOpenApi_() {
  const response = fetchUrl_(CONFIG.TAIFEX_OPTION_OPENAPI_URL);
  const text = response
    .getContentText('UTF-8')
    .replace(/^\uFEFF/, '')
    .trim();

  if (!text) {
    throw new Error('OpenAPI 回傳內容為空。');
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error('OpenAPI 回傳內容不是有效 JSON。');
  }

  const rows = extractArrayFromJson_(json);

  if (rows.length === 0) {
    throw new Error('OpenAPI 中沒有選擇權行情資料列。');
  }

  const normalizedRows = rows
    .filter(
      (row) => row && typeof row === 'object' && !Array.isArray(row)
    )
    .map((row) => {
      const parsedOi = parseNumber_(
        getObjectField_(row, [
          'OpenInterest',
          'Open Interest',
          'OpenInterestVolume',
          '未沖銷契約量',
          '未平倉量',
        ])
      );
      const parsedLastPrice = parseNumber_(
        getObjectField_(row, [
          'Last',
          'LastPrice',
          'Last Price',
          '最後成交價',
          '收盤價',
        ])
      );
      const parsedSettlementPrice = parseNumber_(
        getObjectField_(row, [
          'SettlementPrice',
          'Settlement Price',
          'Settlement',
          '結算價',
        ])
      );

      return {
        date: parseGenericDate_(
          getObjectField_(row, [
            'Date',
            'TradeDate',
            'TradingDate',
            '交易日期',
            '日期',
          ])
        ),
        contract: String(
          getObjectField_(row, [
            'Contract',
            'ContractCode',
            '商品契約代號',
            '契約',
          ]) || ''
        )
          .trim()
          .toUpperCase(),
        contractMonth: String(
          getObjectField_(row, [
            'ContractMonth(Week)',
            'Contract Month(Week)',
            'ContractMonthWeek',
            '到期月份(週別)',
            '到期月份週別',
            '到期月份',
          ]) || ''
        )
          .trim()
          .replace(/\s/g, '')
          .toUpperCase(),
        expiryDate: parseGenericDate_(
          getObjectField_(row, [
            'ContractExpiryDate',
            'Contract Expiry Date',
            'ExpiryDate',
            'ExpirationDate',
            '契約到期日',
          ])
        ),
        strike: parseNumber_(
          getObjectField_(row, [
            'StrikePrice',
            'Strike Price',
            '履約價',
          ])
        ),
        side: normalizeOptionSide_(
          getObjectField_(row, [
            'CallPut',
            'Call/Put',
            'PutCall',
            '買賣權',
          ])
        ),
        openInterest: Number.isFinite(parsedOi) ? parsedOi : 0,
        lastPrice: Number.isFinite(parsedLastPrice) ? parsedLastPrice : NaN,
        settlementPrice: Number.isFinite(parsedSettlementPrice)
          ? parsedSettlementPrice
          : NaN,
        session: String(
          getObjectField_(row, [
            'TradingSession',
            'Trading Session',
            'Session',
            '交易時段',
          ]) || ''
        ).trim(),
      };
    });

  const result = buildTaifexOptionOiSummary_(normalizedRows);
  result.source =
    '臺灣期貨交易所 OpenAPI－選擇權每日交易行情；' +
    'IV依Black-Scholes反推（交易日年化、最後成交價）';
  return result;
}

/**
 * 從期交所官方 CSV 備援資料取得選擇權每日行情。
 */
function fetchTaifexOptionOiFromCsv_() {
  const response = fetchUrl_(CONFIG.TAIFEX_OPTION_CSV_URL);
  const attempts = [];

  ['UTF-8', 'Big5'].forEach((encoding) => {
    let text = '';

    try {
      text = response
        .getContentText(encoding)
        .replace(/^\uFEFF/, '')
        .trim();
    } catch (error) {
      return;
    }

    if (!text) {
      return;
    }

    [',', '\t', ';'].forEach((delimiter) => {
      try {
        const table = Utilities.parseCsv(text, delimiter);
        const headerRowIndex = findTaifexOptionHeaderRow_(table);

        if (headerRowIndex >= 0) {
          attempts.push({ table, headerRowIndex });
        }
      } catch (error) {
        // 繼續嘗試其他編碼或分隔符號。
      }
    });
  });

  if (attempts.length === 0) {
    throw new Error('找不到可辨識的選擇權 CSV 標題列。');
  }

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const headers = attempt.table[attempt.headerRowIndex].map(
        normalizeHeader_
      );
      const indices = getTaifexOptionColumnIndices_(headers);

      if (indices.date < 0) {
        throw new Error('選擇權 CSV 找不到交易日期欄位。');
      }

      const normalizedRows = attempt.table
        .slice(attempt.headerRowIndex + 1)
        .map((row) => {
          const parsedOi = parseNumber_(row[indices.openInterest]);
          const parsedLastPrice =
            indices.lastPrice >= 0
              ? parseNumber_(row[indices.lastPrice])
              : NaN;
          const parsedSettlementPrice =
            indices.settlementPrice >= 0
              ? parseNumber_(row[indices.settlementPrice])
              : NaN;

          return {
            date: parseGenericDate_(row[indices.date]),
            contract: String(row[indices.contract] || '')
              .trim()
              .toUpperCase(),
            contractMonth: String(row[indices.contractMonth] || '')
              .trim()
              .replace(/\s/g, '')
              .toUpperCase(),
            expiryDate:
              indices.expiryDate >= 0
                ? parseGenericDate_(row[indices.expiryDate])
                : '',
            strike: parseNumber_(row[indices.strike]),
            side: normalizeOptionSide_(row[indices.side]),
            openInterest: Number.isFinite(parsedOi) ? parsedOi : 0,
            lastPrice: Number.isFinite(parsedLastPrice) ? parsedLastPrice : NaN,
            settlementPrice: Number.isFinite(parsedSettlementPrice)
              ? parsedSettlementPrice
              : NaN,
            session:
              indices.session >= 0
                ? String(row[indices.session] || '').trim()
                : '',
          };
        });

      const result = buildTaifexOptionOiSummary_(normalizedRows);
      result.source =
        '臺灣期貨交易所 CSV－選擇權每日交易行情；' +
        'IV依Black-Scholes反推（交易日年化、最後成交價）';
      return result;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('CSV 中沒有可用的 TXO 行情。');
}

/**
 * 從所有標準化 TXO 資料列，找出最近交易日的月選、W 與 F 前端有效契約。
 * 「有效」優先定義為該契約至少有一個正數未平倉量；若全部為零，才退回
 * 該類別最早到期的已掛牌契約。
 */
function buildTaifexOptionOiSummary_(rows) {
  const candidates = rows
    .filter((row) => row.contract === 'TXO')
    .filter((row) => isRegularSession_(row.session))
    .filter((row) => isTrackedTxoContract_(row.contractMonth))
    .filter(
      (row) =>
        row.date &&
        Number.isFinite(row.strike) &&
        row.side &&
        Number.isFinite(row.openInterest)
    );

  if (candidates.length === 0) {
    throw new Error('找不到 TXO 一般交易時段的有效 OI 資料。');
  }

  const latestDate = candidates
    .map((row) => row.date)
    .sort()
    .reverse()[0];
  const latestRows = candidates.filter((row) => row.date === latestDate);

  const monthly = selectOptionContractSummary_(
    latestRows,
    /^\d{6}$/,
    '月選'
  );
  const weeklyWednesday = selectOptionContractSummary_(
    latestRows,
    /^\d{6}W[1245]$/,
    'W 週三選'
  );
  const weeklyFriday = selectOptionContractSummary_(
    latestRows,
    /^\d{6}F[1-5]$/,
    'F 週五選'
  );

  let atmWarning = '';
  try {
    const atmContext = getOptionAtmContext_(latestDate);
    attachOptionAtmMetrics_(monthly, latestRows, atmContext, latestDate);
    attachOptionAtmMetrics_(weeklyWednesday, latestRows, atmContext, latestDate);
    attachOptionAtmMetrics_(weeklyFriday, latestRows, atmContext, latestDate);
  } catch (error) {
    atmWarning = error.message;
  }

  const atmComplete = [monthly, weeklyWednesday, weeklyFriday].every(
    hasCompleteOptionAtmMetrics_
  );

  return {
    date: latestDate,
    monthly,
    weeklyWednesday,
    weeklyFriday,
    atmComplete,
    atmWarning,
    source:
      '臺灣期貨交易所－選擇權完整日盤行情；' +
      'IV依Black-Scholes反推（交易日年化、最後成交價）',
  };
}

function selectOptionContractSummary_(rows, pattern, label) {
  const groups = new Map();

  rows
    .filter((row) => pattern.test(row.contractMonth))
    .forEach((row) => {
      if (!groups.has(row.contractMonth)) {
        groups.set(row.contractMonth, {
          contract: row.contractMonth,
          expiryDate: row.expiryDate || '',
          rows: [],
          positiveOiTotal: 0,
        });
      }

      const group = groups.get(row.contractMonth);
      group.rows.push(row);

      if (!group.expiryDate && row.expiryDate) {
        group.expiryDate = row.expiryDate;
      }

      if (row.openInterest > 0) {
        group.positiveOiTotal += row.openInterest;
      }
    });

  const allGroups = Array.from(groups.values());

  if (allGroups.length === 0) {
    throw new Error(`找不到 ${label} 契約。`);
  }

  const groupsWithOi = allGroups.filter(
    (group) => group.positiveOiTotal > 0
  );
  const pool = groupsWithOi.length > 0 ? groupsWithOi : allGroups;
  const selected = pool.sort(compareOptionContractGroups_)[0];
  const call = findMaxOptionOi_(selected.rows, 'Call');
  const put = findMaxOptionOi_(selected.rows, 'Put');

  if (!call.strike || !put.strike) {
    throw new Error(
      `${label} ${selected.contract} 缺少正數 Call 或 Put 未平倉量。`
    );
  }

  return {
    contract: selected.contract,
    expiryDate: selected.expiryDate,
    callStrike: call.strike,
    callOpenInterest: call.openInterest,
    putStrike: put.strike,
    putOpenInterest: put.openInterest,
  };
}


/**
 * 依使用者規則選擇價平基準：5–9 月採台指期日盤收盤，其餘月份採大盤收盤。
 */
function getOptionAtmContext_(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`無法辨識價平計算日期：${date}`);
  }

  const month = Number(match[2]);
  const useFuture = month >= 5 && month <= 9;
  const atmMarket = findMarketRecordForDate_(
    date,
    useFuture ? '台指期貨' : '大盤現貨'
  );
  const spotMarket = findMarketRecordForDate_(date, '大盤現貨');

  if (!atmMarket || !Number.isFinite(Number(atmMarket.close))) {
    throw new Error(
      `${date} 缺少${useFuture ? '台指期日盤' : '大盤現貨'}收盤價，無法計算價平。`
    );
  }
  if (!spotMarket || !Number.isFinite(Number(spotMarket.close))) {
    throw new Error(`${date} 缺少大盤現貨收盤價，無法估算選擇權 IV。`);
  }

  const atmReferencePrice = Number(atmMarket.close);
  return {
    atmReferencePrice,
    // TXO 的 Black-Scholes 標的採大盤現貨指數；5–9 月期貨收盤只用於選定價平履約價。
    ivUnderlyingPrice: Number(spotMarket.close),
    atmStrike:
      Math.round(atmReferencePrice / CONFIG.ATM_STRIKE_INTERVAL) *
      CONFIG.ATM_STRIKE_INTERVAL,
    sourceLabel: useFuture ? '台指期日盤收盤' : '大盤現貨收盤',
  };
}

function findMarketRecordForDate_(date, productKeyword) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    CONFIG.DATA_SHEET
  );
  if (!sheet || sheet.getLastRow() <= 1) return null;

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, DATA_HEADERS.length)
    .getValues();
  let found = null;

  rows.forEach((row) => {
    if (
      normalizeSheetDate_(row[0]) === date &&
      String(row[1] || '').includes(productKeyword) &&
      isFiniteNumber_(row[6])
    ) {
      found = {
        contract: row[2],
        close: Number(row[6]),
      };
    }
  });

  return found;
}

function attachOptionAtmMetrics_(summary, rows, atmContext, tradeDate) {
  summary.atmStrike = atmContext.atmStrike;
  summary.atmUnderlying = atmContext.atmReferencePrice;
  summary.ivUnderlying = atmContext.ivUnderlyingPrice;
  summary.atmUnderlyingSource = atmContext.sourceLabel;

  const contractRows = rows.filter(
    (row) => row.contractMonth === summary.contract
  );
  const callRow = contractRows.find(
    (row) => row.side === 'Call' && Number(row.strike) === summary.atmStrike
  );
  const putRow = contractRows.find(
    (row) => row.side === 'Put' && Number(row.strike) === summary.atmStrike
  );

  // 總表的「成交價」仍記錄最後成交價。
  summary.callLastPrice = getPositivePrice_(callRow, 'lastPrice');
  summary.putLastPrice = getPositivePrice_(putRow, 'lastPrice');

  // IV 權利金採最後成交價，與總表的成交價欄一致。
  summary.callIvPrice = chooseOptionIvPremium_(callRow);
  summary.putIvPrice = chooseOptionIvPremium_(putRow);
  summary.ivPremiumSource = CONFIG.IV_USE_SETTLEMENT_PRICE
    ? '每日結算價優先'
    : '最後成交價';

  const timeContext = optionTimeToExpiryContext_(
    tradeDate,
    summary.expiryDate
  );
  summary.ivTradingDayUnits = timeContext.tradingDayUnits;
  summary.ivAnnualTradingDays = timeContext.annualTradingDays;

  summary.callIv = isFiniteNumber_(summary.callIvPrice)
    ? impliedVolatilityPercent_(
        'Call',
        atmContext.ivUnderlyingPrice,
        summary.atmStrike,
        Number(summary.callIvPrice),
        timeContext.years
      )
    : '';
  summary.putIv = isFiniteNumber_(summary.putIvPrice)
    ? impliedVolatilityPercent_(
        'Put',
        atmContext.ivUnderlyingPrice,
        summary.atmStrike,
        Number(summary.putIvPrice),
        timeContext.years
      )
    : '';
}

function getPositivePrice_(row, fieldName) {
  if (!row) return '';
  const value = Number(row[fieldName]);
  return Number.isFinite(value) && value > 0 ? value : '';
}

function chooseOptionIvPremium_(row) {
  if (!row) return '';

  if (CONFIG.IV_USE_SETTLEMENT_PRICE) {
    const settlement = getPositivePrice_(row, 'settlementPrice');
    if (isFiniteNumber_(settlement)) return settlement;
  }

  return getPositivePrice_(row, 'lastPrice');
}

function hasCompleteOptionAtmMetrics_(summary) {
  return (
    summary &&
    isFiniteNumber_(summary.atmStrike) &&
    isFiniteNumber_(summary.callLastPrice) &&
    isFiniteNumber_(summary.callIv) &&
    isFiniteNumber_(summary.putLastPrice) &&
    isFiniteNumber_(summary.putIv)
  );
}

/**
 * 依期交所理論價格計算頁說明，以「剩餘交易日數 ÷ 當年總交易日數」年化。
 * 計算日採可調式權重，其後交易日至到期日均以完整交易日計。
 */
function optionTimeToExpiryContext_(tradeDate, expiryDate) {
  const trade = parseIsoDateAtNoon_(tradeDate);
  const expiry = parseIsoDateAtNoon_(expiryDate);

  if (!trade || !expiry || expiry.getTime() < trade.getTime()) {
    throw new Error(`缺少或無法辨識契約到期日：${expiryDate}`);
  }

  let cursor = new Date(trade.getTime());
  let years = 0;
  let tradingDayUnits = 0;
  let firstTradingDate = true;
  const annualCounts = {};

  while (cursor.getTime() <= expiry.getTime()) {
    if (isTwseTradingDate_(cursor)) {
      const year = cursor.getFullYear();
      const annualTradingDays = getTwseAnnualTradingDayCount_(year);
      annualCounts[year] = annualTradingDays;

      const unit = firstTradingDate
        ? clampNumber_(
            Number(CONFIG.IV_CURRENT_TRADING_DAY_WEIGHT),
            0,
            1,
            0.63
          )
        : 1;

      tradingDayUnits += unit;
      years += unit / annualTradingDays;
      firstTradingDate = false;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  const minUnits = Math.max(
    Number(CONFIG.IV_MIN_TRADING_DAY_UNITS) || 0.5,
    0.0001
  );

  if (tradingDayUnits < minUnits) {
    const annualTradingDays = getTwseAnnualTradingDayCount_(trade.getFullYear());
    years = minUnits / annualTradingDays;
    tradingDayUnits = minUnits;
    annualCounts[trade.getFullYear()] = annualTradingDays;
  }

  return {
    years,
    tradingDayUnits: Math.round(tradingDayUnits * 100) / 100,
    annualTradingDays: Object.values(annualCounts).join('/'),
  };
}

function isTwseTradingDate_(date) {
  const weekday = date.getDay();
  if (weekday === 0 || weekday === 6) return false;

  const year = date.getFullYear();
  const dateKey = Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  return !getTwseClosedDateSet_(year)[dateKey];
}

function getTwseAnnualTradingDayCount_(year) {
  const closedDates = getTwseClosedDateSet_(year);
  let count = 0;
  const cursor = new Date(year, 0, 1, 12, 0, 0);
  const end = new Date(year, 11, 31, 12, 0, 0);

  while (cursor.getTime() <= end.getTime()) {
    const weekday = cursor.getDay();
    const dateKey = Utilities.formatDate(cursor, CONFIG.TIMEZONE, 'yyyy-MM-dd');
    if (weekday !== 0 && weekday !== 6 && !closedDates[dateKey]) {
      count += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  // 若休市資料暫時抓取失敗，正常年份的平日數仍約 260；此檢查可避免
  // HTML／JSON 異常造成極端錯誤。
  if (count < 220 || count > 265) {
    throw new Error(`${year} 年總交易日數異常：${count}`);
  }

  return count;
}

function getTwseClosedDateSet_(year) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `twse_closed_dates_${year}`;
  const cached = cache.get(cacheKey);

  if (cached) {
    return JSON.parse(cached);
  }

  const urls = [
    CONFIG.TWSE_HOLIDAY_URL + year,
    CONFIG.TWSE_HOLIDAY_URL + (year - 1911),
    CONFIG.TWSE_HOLIDAY_OPENAPI_URL,
  ];
  let lastError = null;

  for (const url of urls) {
    try {
      const response = fetchUrl_(url);
      const payload = JSON.parse(
        response.getContentText('UTF-8').replace(/^\uFEFF/, '')
      );
      const rows = Array.isArray(payload.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];
      const closed = {};

      rows.forEach((row) => {
        const cells = Array.isArray(row)
          ? row
          : [
              row.Date || row.date || row.日期,
              row.Name || row.name || row.名稱,
              row.Description || row.description || row.說明,
            ];
        const dateKey = parseGenericDate_(cells[0]);
        const description = `${cells[1] || ''} ${cells[2] || ''}`;

        if (!dateKey) return;
        if (/開始交易|最後交易/.test(description)) return;

        const parsed = parseIsoDateAtNoon_(dateKey);
        if (!parsed || parsed.getDay() === 0 || parsed.getDay() === 6) return;
        closed[dateKey] = true;
      });

      // 至少應辨識到數個平日休市日；否則繼續嘗試另一種年份參數。
      if (Object.keys(closed).length >= 3) {
        cache.put(cacheKey, JSON.stringify(closed), 21600);
        return closed;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `無法取得 ${year} 年證交所休市日：${lastError ? lastError.message : '格式不明'}`
  );
}

function clampNumber_(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseIsoDateAtNoon_(dateText) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0
  );
}

function impliedVolatilityPercent_(side, s, k, marketPrice, t) {
  if (
    ![s, k, marketPrice, t].every(Number.isFinite) ||
    s <= 0 ||
    k <= 0 ||
    marketPrice <= 0 ||
    t <= 0
  ) {
    return '';
  }

  const r = Number(CONFIG.IV_RISK_FREE_RATE) || 0;
  const q = Number(CONFIG.IV_DIVIDEND_YIELD) || 0;
  const discountedS = s * Math.exp(-q * t);
  const discountedK = k * Math.exp(-r * t);
  const intrinsic =
    side === 'Call'
      ? Math.max(0, discountedS - discountedK)
      : Math.max(0, discountedK - discountedS);
  const upper = side === 'Call' ? discountedS : discountedK;
  const tolerance = 1e-7;

  if (marketPrice < intrinsic - tolerance || marketPrice >= upper) {
    return '';
  }

  let low = 0.000001;
  let high = 5.0;
  const highPrice = blackScholesPrice_(side, s, k, r, q, high, t);
  if (marketPrice > highPrice + tolerance) {
    return '';
  }

  for (let index = 0; index < 100; index += 1) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice_(side, s, k, r, q, mid, t);
    if (price > marketPrice) high = mid;
    else low = mid;
  }

  return Math.round(((low + high) / 2) * 10000) / 100;
}

function blackScholesPrice_(side, s, k, r, q, sigma, t) {
  const rootT = Math.sqrt(t);
  const d1 =
    (Math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) /
    (sigma * rootT);
  const d2 = d1 - sigma * rootT;

  if (side === 'Call') {
    return (
      s * Math.exp(-q * t) * normalCdf_(d1) -
      k * Math.exp(-r * t) * normalCdf_(d2)
    );
  }

  return (
    k * Math.exp(-r * t) * normalCdf_(-d2) -
    s * Math.exp(-q * t) * normalCdf_(-d1)
  );
}

function normalCdf_(x) {
  // Abramowitz-Stegun 常態分布累積函數近似。
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * absX);
  const density = Math.exp(-0.5 * absX * absX) / Math.sqrt(2 * Math.PI);
  const polynomial =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const value = 1 - density * polynomial;
  return x >= 0 ? value : 1 - value;
}

function compareOptionContractGroups_(a, b) {
  const expiryA = a.expiryDate || '9999-12-31';
  const expiryB = b.expiryDate || '9999-12-31';

  if (expiryA !== expiryB) {
    return expiryA.localeCompare(expiryB);
  }

  return a.contract.localeCompare(b.contract);
}

/**
 * 若多個履約價並列最大 OI，全部以「／」串接，避免任意丟棄其中一個。
 */
function findMaxOptionOi_(rows, side) {
  const candidates = rows.filter(
    (row) => row.side === side && row.openInterest > 0
  );

  if (candidates.length === 0) {
    return { strike: '', openInterest: 0 };
  }

  const maxOi = Math.max(...candidates.map((row) => row.openInterest));
  const strikes = Array.from(
    new Set(
      candidates
        .filter((row) => row.openInterest === maxOi)
        .map((row) => row.strike)
    )
  ).sort((a, b) => a - b);

  return {
    strike:
      strikes.length === 1
        ? strikes[0]
        : strikes.map(formatStrikeValue_).join('／'),
    openInterest: maxOi,
  };
}

function formatStrikeValue_(value) {
  return Number.isInteger(value) ? String(value) : String(value);
}

function normalizeOptionSide_(value) {
  const normalized = normalizeFieldKey_(value);

  if (['call', 'c', '買權'].includes(normalized)) {
    return 'Call';
  }

  if (['put', 'p', '賣權'].includes(normalized)) {
    return 'Put';
  }

  return '';
}

function isTrackedTxoContract_(value) {
  return /^\d{6}(?:W[1245]|F[1-5])?$/.test(
    String(value || '').trim().toUpperCase()
  );
}

function findTaifexOptionHeaderRow_(table) {
  const maxRows = Math.min(table.length, 200);

  for (let index = 0; index < maxRows; index += 1) {
    const headers = (table[index] || []).map(normalizeHeader_);

    const hasContract =
      findHeaderIndex_(
        headers,
        ['契約', '商品契約代號', 'Contract', 'ContractCode'],
        false
      ) >= 0;
    const hasContractMonth =
      findHeaderIndex_(
        headers,
        [
          '到期月份(週別)',
          '到期月份(週期)',
          '到期月份週別',
          '到期月份',
          'ContractMonth(Week)',
          'ContractMonthWeek',
        ],
        false
      ) >= 0;
    const hasStrike =
      findHeaderIndex_(
        headers,
        ['履約價', 'StrikePrice', 'Strike Price'],
        false
      ) >= 0;
    const hasSide =
      findHeaderIndex_(
        headers,
        ['買賣權', 'CallPut', 'Call/Put', 'PutCall'],
        false
      ) >= 0;
    const hasOi =
      findHeaderIndex_(
        headers,
        [
          '未沖銷契約量',
          '未平倉量',
          '未平倉',
          'OpenInterest',
          'Open Interest',
        ],
        false
      ) >= 0;

    if (hasContract && hasContractMonth && hasStrike && hasSide && hasOi) {
      return index;
    }
  }

  return -1;
}

function getTaifexOptionColumnIndices_(headers) {
  return {
    date: findHeaderIndex_(
      headers,
      ['交易日期', '日期', 'Date', 'TradeDate'],
      false
    ),
    contract: findHeaderIndex_(headers, [
      '契約',
      '商品契約代號',
      'Contract',
      'ContractCode',
    ]),
    contractMonth: findHeaderIndex_(headers, [
      '到期月份(週別)',
      '到期月份(週期)',
      '到期月份週別',
      '到期月份',
      'ContractMonth(Week)',
      'ContractMonthWeek',
    ]),
    expiryDate: findHeaderIndex_(
      headers,
      [
        '契約到期日',
        'ContractExpiryDate',
        'Contract Expiry Date',
        'ExpiryDate',
      ],
      false
    ),
    strike: findHeaderIndex_(headers, [
      '履約價',
      'StrikePrice',
      'Strike Price',
    ]),
    side: findHeaderIndex_(headers, [
      '買賣權',
      'CallPut',
      'Call/Put',
      'PutCall',
    ]),
    openInterest: findHeaderIndex_(headers, [
      '未沖銷契約量',
      '未平倉量',
      '未平倉',
      'OpenInterest',
      'Open Interest',
    ]),
    lastPrice: findHeaderIndex_(
      headers,
      ['最後成交價', '最後成交', 'Last', 'LastPrice', 'Last Price'],
      false
    ),
    settlementPrice: findHeaderIndex_(
      headers,
      ['結算價', 'SettlementPrice', 'Settlement Price', 'Settlement'],
      false
    ),
    session: findHeaderIndex_(
      headers,
      ['交易時段', 'TradingSession', 'Trading Session', 'Session'],
      false
    ),
  };
}

/**
 * 抓取 HTML，加入時間戳避免快取；必要時依序嘗試不同編碼。
 */
function fetchHtmlWithCacheBust_(
  baseUrl,
  encodings = ['UTF-8'],
  requiredKeywords = []
) {
  const separator = baseUrl.includes('?') ? '&' : '?';
  const url = `${baseUrl}${separator}_ts=${new Date().getTime()}`;
  const response = fetchUrl_(url);
  let fallback = '';

  for (const encoding of encodings) {
    let text = '';

    try {
      text = response.getContentText(encoding);
    } catch (error) {
      continue;
    }

    if (!text) {
      continue;
    }

    if (!fallback) {
      fallback = text;
    }

    const plainText = normalizeWhitespace_(
      decodeHtmlEntities_(stripHtml_(text))
    );
    const containsKeywords = requiredKeywords.every((keyword) =>
      plainText.includes(keyword)
    );

    if (containsKeywords) {
      return text;
    }
  }

  if (fallback) {
    return fallback;
  }

  throw new Error('網頁回傳內容為空。');
}

/**
 * 將 HTML 中所有表格列轉為純文字儲存格陣列。
 */
function extractHtmlTableRows_(html) {
  const rows = [];
  const rowMatches =
    String(html || '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  rowMatches.forEach((rowHtml) => {
    const cells = [];
    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;

    while ((match = cellRegex.exec(rowHtml)) !== null) {
      cells.push(
        normalizeWhitespace_(
          decodeHtmlEntities_(stripHtml_(match[1]))
        )
      );
    }

    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  return rows;
}

/**
 * 從標準化資料列挑選最新交易日的 TX 一般交易時段近月契約。
 */
function selectLatestTaifexTx_(rows) {
  const candidates = rows
    .filter((row) => row.contract === 'TX')
    .filter((row) => isRegularSession_(row.session))
    // 僅保留六碼月份契約，排除週契約與跨月價差契約。
    .filter((row) => /^\d{6}$/.test(row.contractMonth))
    .filter(
      (row) =>
        row.date &&
        [row.open, row.high, row.low, row.close].every(
          Number.isFinite
        )
    );

  if (candidates.length === 0) {
    throw new Error(
      '找不到 TX 一般交易時段的有效近月契約資料。'
    );
  }

  const latestDate = candidates
    .map((row) => row.date)
    .sort()
    .reverse()[0];

  const latest = candidates
    .filter((row) => row.date === latestDate)
    .sort((a, b) =>
      a.contractMonth.localeCompare(b.contractMonth)
    )[0];

  return {
    date: latest.date,
    product: '台指期貨指數（日盤）',
    contractMonth: latest.contractMonth,
    open: latest.open,
    high: latest.high,
    low: latest.low,
    close: latest.close,
    source: '臺灣期貨交易所',
  };
}

function isRegularSession_(value) {
  const session = String(value || '').trim();

  if (!session) {
    return true;
  }

  return (
    /一般|日盤|regular/i.test(session) ||
    session === '0'
  );
}

/**
 * 尋找真正的 CSV 標題列，不再假設第一列一定是標題。
 */
function findTaifexHeaderRow_(table) {
  const maxRows = Math.min(table.length, 20);

  for (let index = 0; index < maxRows; index += 1) {
    const headers = (table[index] || []).map(normalizeHeader_);

    const hasContract =
      findHeaderIndex_(
        headers,
        [
          '商品契約代號',
          '契約',
          '商品代號',
          'Contract',
          'ContractCode',
        ],
        false
      ) >= 0;

    const hasOpen =
      findHeaderIndex_(
        headers,
        ['開盤價', 'Open', 'OpenPrice'],
        false
      ) >= 0;

    const hasClose =
      findHeaderIndex_(
        headers,
        ['最後成交價', '收盤價', 'Last', 'Close'],
        false
      ) >= 0;

    if (hasContract && hasOpen && hasClose) {
      return index;
    }
  }

  return -1;
}

function extractArrayFromJson_(json) {
  if (Array.isArray(json)) {
    return json;
  }

  if (!json || typeof json !== 'object') {
    return [];
  }

  const preferredKeys = [
    'data',
    'Data',
    'result',
    'Result',
    'records',
    'Records',
    'items',
    'Items',
  ];

  for (const key of preferredKeys) {
    if (Array.isArray(json[key])) {
      return json[key];
    }
  }

  for (const value of Object.values(json)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function getObjectField_(object, aliases) {
  const keyMap = new Map(
    Object.keys(object).map((key) => [normalizeFieldKey_(key), key])
  );

  for (const alias of aliases) {
    const actualKey = keyMap.get(normalizeFieldKey_(alias));

    if (actualKey !== undefined) {
      return object[actualKey];
    }
  }

  return '';
}

/**
 * 以「資料日期＋商品」作為唯一鍵：
 * 已存在則更新，不存在則新增。
 */
function upsertMarketRow_(record) {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
      CONFIG.DATA_SHEET
    );

  const lastRow = sheet.getLastRow();
  const data =
    lastRow > 1
      ? sheet
          .getRange(2, 1, lastRow - 1, DATA_HEADERS.length)
          .getValues()
      : [];

  const existingIndex = data.findIndex(
    (row) =>
      String(row[0]).trim() === record.date &&
      String(row[1]).trim() === record.product
  );

  const values = [
    record.date,
    record.product,
    record.contractMonth || '',
    record.open,
    record.high,
    record.low,
    record.close,
    record.source,
    new Date(),
    record.status || '成功',
    valueOrBlank_(record.volume),
  ];

  if (existingIndex >= 0) {
    sheet
      .getRange(existingIndex + 2, 1, 1, values.length)
      .setValues([values]);
  } else {
    sheet.appendRow(values);
  }

  sortDataSheet_(sheet);
}


/**
 * 依資料日期合併寫入「每日籌碼」。
 * 不同來源若更新日期不同，會寫入各自日期的資料列，不會錯誤混併。
 */
function upsertChipFields_(record) {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
      CONFIG.CHIP_SHEET
    );

  // 先清理舊版可能留下的同日重複列。
  consolidateDuplicateChipRows_(sheet);

  const normalizedRecordDate = normalizeSheetDate_(record.date);

  if (!normalizedRecordDate) {
    throw new Error(`無法辨識籌碼資料日期：${record.date}`);
  }

  const lastRow = sheet.getLastRow();
  const data =
    lastRow > 1
      ? sheet
          .getRange(2, 1, lastRow - 1, CHIP_HEADERS.length)
          .getValues()
      : [];

  const existingIndex = data.findIndex(
    (row) => normalizeSheetDate_(row[0]) === normalizedRecordDate
  );
  const values =
    existingIndex >= 0
      ? data[existingIndex].slice()
      : new Array(CHIP_HEADERS.length).fill('');

  // 日期一律以文字 yyyy-MM-dd 寫入，避免 Sheets 自動轉為日期物件。
  values[0] = normalizedRecordDate;

  Object.keys(CHIP_FIELD_COLUMNS).forEach((field) => {
    if (
      Object.prototype.hasOwnProperty.call(record, field) &&
      record[field] !== '' &&
      record[field] !== null &&
      record[field] !== undefined
    ) {
      values[CHIP_FIELD_COLUMNS[field]] = record[field];
    }
  });

  values[11] = mergeUniqueText_(values[11], record.source, '；');
  values[12] = new Date();
  values[13] = mergeUniqueText_(values[13], record.status, '／');

  if (existingIndex >= 0) {
    sheet
      .getRange(existingIndex + 2, 1, 1, values.length)
      .setValues([values]);
  } else {
    sheet.appendRow(values);
  }

  sortChipSheet_(sheet);
}


/**
 * 依資料日期寫入「選擇權OI」，同一交易日只保留一列。
 */
function upsertOptionOiRow_(record) {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
      CONFIG.OPTION_OI_SHEET
    );

  consolidateDuplicateOptionOiRows_(sheet);

  const normalizedDate = normalizeSheetDate_(record.date);

  if (!normalizedDate) {
    throw new Error(`無法辨識選擇權 OI 日期：${record.date}`);
  }

  const lastRow = sheet.getLastRow();
  const data =
    lastRow > 1
      ? sheet
          .getRange(2, 1, lastRow - 1, OPTION_OI_HEADERS.length)
          .getValues()
      : [];
  const existingIndex = data.findIndex(
    (row) => normalizeSheetDate_(row[0]) === normalizedDate
  );

  const values = [
    normalizedDate,
    record.monthly.contract,
    record.monthly.expiryDate,
    record.monthly.callStrike,
    record.monthly.callOpenInterest,
    record.monthly.putStrike,
    record.monthly.putOpenInterest,
    record.weeklyWednesday.contract,
    record.weeklyWednesday.expiryDate,
    record.weeklyWednesday.callStrike,
    record.weeklyWednesday.callOpenInterest,
    record.weeklyWednesday.putStrike,
    record.weeklyWednesday.putOpenInterest,
    record.weeklyFriday.contract,
    record.weeklyFriday.expiryDate,
    record.weeklyFriday.callStrike,
    record.weeklyFriday.callOpenInterest,
    record.weeklyFriday.putStrike,
    record.weeklyFriday.putOpenInterest,
    record.source,
    new Date(),
    record.status || '成功',
    valueOrBlank_(record.monthly.atmStrike),
    valueOrBlank_(record.monthly.callLastPrice),
    valueOrBlank_(record.monthly.callIv),
    valueOrBlank_(record.monthly.putLastPrice),
    valueOrBlank_(record.monthly.putIv),
    valueOrBlank_(record.weeklyWednesday.atmStrike),
    valueOrBlank_(record.weeklyWednesday.callLastPrice),
    valueOrBlank_(record.weeklyWednesday.callIv),
    valueOrBlank_(record.weeklyWednesday.putLastPrice),
    valueOrBlank_(record.weeklyWednesday.putIv),
    valueOrBlank_(record.weeklyFriday.atmStrike),
    valueOrBlank_(record.weeklyFriday.callLastPrice),
    valueOrBlank_(record.weeklyFriday.callIv),
    valueOrBlank_(record.weeklyFriday.putLastPrice),
    valueOrBlank_(record.weeklyFriday.putIv),
  ];

  if (existingIndex >= 0) {
    sheet
      .getRange(existingIndex + 2, 1, 1, values.length)
      .setValues([values]);
  } else {
    sheet.appendRow(values);
  }

  sortOptionOiSheet_(sheet);
}

/**
 * 手動整理「選擇權OI」中同日期的重複列。
 */
function repairOptionOiSheetDuplicates() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  const sheet = getOrCreateSheet_(ss, CONFIG.OPTION_OI_SHEET);
  ensureSheetColumnCount_(sheet, OPTION_OI_HEADERS.length);
  initializeHeader_(sheet, OPTION_OI_HEADERS);
  const result = consolidateDuplicateOptionOiRows_(sheet);

  ensureSheetColumnCount_(sheet, OPTION_OI_HEADERS.length);
  formatOptionOiSheet_(sheet);

  writeLog_(
    '成功',
    `選擇權 OI 重複列整理完成：合併 ${result.mergedCount} 列，保留 ${result.rowCount} 個日期。`
  );
}

function consolidateDuplicateOptionOiRows_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return { mergedCount: 0, rowCount: 0 };
  }

  const rowCount = lastRow - 1;
  const data = sheet
    .getRange(2, 1, rowCount, OPTION_OI_HEADERS.length)
    .getValues();
  const grouped = new Map();
  const unrecognizedRows = [];

  data.forEach((row) => {
    const dateKey = normalizeSheetDate_(row[0]);

    if (!dateKey) {
      if (row.some((value) => value !== '' && value !== null)) {
        unrecognizedRows.push(row.slice());
      }
      return;
    }

    if (!grouped.has(dateKey)) {
      const initial = new Array(OPTION_OI_HEADERS.length).fill('');
      initial[0] = dateKey;
      grouped.set(dateKey, initial);
    }

    const merged = grouped.get(dateKey);

    // 契約及 OI 欄位：較晚列的非空值覆蓋舊值。
    for (let column = 1; column <= 19; column += 1) {
      if (row[column] !== '' && row[column] !== null) {
        merged[column] = row[column];
      }
    }

    const existingUpdate = toTimestamp_(merged[20]);
    const incomingUpdate = toTimestamp_(row[20]);

    if (incomingUpdate >= existingUpdate && row[20]) {
      merged[20] = row[20];
      merged[21] = row[21];
    } else if (!merged[21] && row[21]) {
      merged[21] = row[21];
    }

    // v1.9 價平、成交價及 IV 欄位：較晚列非空值覆蓋舊值。
    for (let column = 22; column < OPTION_OI_HEADERS.length; column += 1) {
      if (row[column] !== '' && row[column] !== null) {
        merged[column] = row[column];
      }
    }
  });

  const mergedRows = Array.from(grouped.values()).sort((a, b) =>
    String(b[0]).localeCompare(String(a[0]))
  );
  const outputRows = mergedRows.concat(unrecognizedRows);

  sheet
    .getRange(2, 1, rowCount, OPTION_OI_HEADERS.length)
    .clearContent();

  if (outputRows.length > 0) {
    sheet
      .getRange(2, 1, outputRows.length, OPTION_OI_HEADERS.length)
      .setValues(outputRows);
  }

  return {
    mergedCount: Math.max(0, data.length - outputRows.length),
    rowCount: mergedRows.length,
  };
}


function ensureSheetColumnCount_(sheet, requiredColumns) {
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      requiredColumns - sheet.getMaxColumns()
    );
  }
}

function formatOptionOiSheet_(sheet) {
  sheet.getRange('A:C').setNumberFormat('@');
  sheet.getRange('D:D').setNumberFormat('@');
  sheet.getRange('E:E').setNumberFormat('#,##0');
  sheet.getRange('F:F').setNumberFormat('@');
  sheet.getRange('G:G').setNumberFormat('#,##0');
  sheet.getRange('H:J').setNumberFormat('@');
  sheet.getRange('K:K').setNumberFormat('#,##0');
  sheet.getRange('L:L').setNumberFormat('@');
  sheet.getRange('M:M').setNumberFormat('#,##0');
  sheet.getRange('N:P').setNumberFormat('@');
  sheet.getRange('Q:Q').setNumberFormat('#,##0');
  sheet.getRange('R:R').setNumberFormat('@');
  sheet.getRange('S:S').setNumberFormat('#,##0');
  sheet.getRange('T:T').setNumberFormat('@');
  sheet.getRange('U:U').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  sheet.getRange('V:V').setNumberFormat('@');
  sheet.getRange('W:W').setNumberFormat('#,##0');
  sheet.getRange('X:X').setNumberFormat('#,##0.00');
  sheet.getRange('Y:Y').setNumberFormat('0.00');
  sheet.getRange('Z:Z').setNumberFormat('#,##0.00');
  sheet.getRange('AA:AA').setNumberFormat('0.00');
  sheet.getRange('AB:AB').setNumberFormat('#,##0');
  sheet.getRange('AC:AC').setNumberFormat('#,##0.00');
  sheet.getRange('AD:AD').setNumberFormat('0.00');
  sheet.getRange('AE:AE').setNumberFormat('#,##0.00');
  sheet.getRange('AF:AF').setNumberFormat('0.00');
  sheet.getRange('AG:AG').setNumberFormat('#,##0');
  sheet.getRange('AH:AH').setNumberFormat('#,##0.00');
  sheet.getRange('AI:AI').setNumberFormat('0.00');
  sheet.getRange('AJ:AJ').setNumberFormat('#,##0.00');
  sheet.getRange('AK:AK').setNumberFormat('0.00');
  sheet.autoResizeColumns(1, OPTION_OI_HEADERS.length);

  const ivRanges = [
    sheet.getRange('Y2:Y'),
    sheet.getRange('AA2:AA'),
    sheet.getRange('AD2:AD'),
    sheet.getRange('AF2:AF'),
    sheet.getRange('AI2:AI'),
    sheet.getRange('AK2:AK'),
  ];
  const rules = sheet
    .getConditionalFormatRules()
    .filter((rule) => {
      const a1 = rule.getRanges().map((range) => range.getA1Notation()).join(',');
      return !/^(Y2:Y|AA2:AA|AD2:AD|AF2:AF|AI2:AI|AK2:AK)(,|$)/.test(a1);
    });
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(CONFIG.IV_ALERT_THRESHOLD)
      .setBackground('#F4CCCC')
      .setFontColor('#C00000')
      .setBold(true)
      .setRanges(ivRanges)
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

function sortOptionOiSheet_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 2) {
    return;
  }

  sheet
    .getRange(2, 1, lastRow - 1, OPTION_OI_HEADERS.length)
    .sort([{ column: 1, ascending: false }]);
}

/**
 * 手動執行入口：合併「每日籌碼」中同一資料日期的重複列。
 */
function repairChipSheetDuplicates() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  const sheet = getOrCreateSheet_(ss, CONFIG.CHIP_SHEET);
  initializeHeader_(sheet, CHIP_HEADERS);

  const result = consolidateDuplicateChipRows_(sheet);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('B:D').setNumberFormat('0.00');
  sheet.getRange('E:K').setNumberFormat('#,##0');
  sheet.getRange('M:M').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  sheet.autoResizeColumns(1, CHIP_HEADERS.length);

  writeLog_(
    '成功',
    `每日籌碼重複列整理完成：合併 ${result.mergedCount} 列，保留 ${result.rowCount} 個日期。`
  );
}

/**
 * 將「每日籌碼」中日期顯示相同、但底層型別不同的列合併。
 * 例如：Date 物件 2026/08/06 與文字 2026-08-06。
 */
function consolidateDuplicateChipRows_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return { mergedCount: 0, rowCount: 0 };
  }

  const rowCount = lastRow - 1;
  const data = sheet
    .getRange(2, 1, rowCount, CHIP_HEADERS.length)
    .getValues();

  const grouped = new Map();
  const unrecognizedRows = [];

  data.forEach((row) => {
    const dateKey = normalizeSheetDate_(row[0]);

    if (!dateKey) {
      // 保留非空但無法辨識日期的列，避免無聲刪除使用者資料。
      if (row.some((value) => value !== '' && value !== null)) {
        unrecognizedRows.push(row.slice());
      }
      return;
    }

    if (!grouped.has(dateKey)) {
      const initial = new Array(CHIP_HEADERS.length).fill('');
      initial[0] = dateKey;
      grouped.set(dateKey, initial);
    }

    const merged = grouped.get(dateKey);

    // B:K 指標欄：以較晚更新列中的非空值覆蓋舊值。
    for (let column = 1; column <= 10; column += 1) {
      if (row[column] !== '' && row[column] !== null) {
        merged[column] = row[column];
      }
    }

    merged[11] = mergeUniqueText_(merged[11], row[11], '；');

    const existingUpdate = toTimestamp_(merged[12]);
    const incomingUpdate = toTimestamp_(row[12]);

    if (incomingUpdate >= existingUpdate && row[12]) {
      merged[12] = row[12];
    }

    merged[13] = mergeUniqueText_(merged[13], row[13], '／');
  });

  const mergedRows = Array.from(grouped.values()).sort((a, b) =>
    String(b[0]).localeCompare(String(a[0]))
  );
  const outputRows = mergedRows.concat(unrecognizedRows);

  sheet
    .getRange(2, 1, rowCount, CHIP_HEADERS.length)
    .clearContent();

  if (outputRows.length > 0) {
    sheet
      .getRange(2, 1, outputRows.length, CHIP_HEADERS.length)
      .setValues(outputRows);
  }

  const mergedCount = Math.max(0, data.length - outputRows.length);

  return {
    mergedCount,
    rowCount: mergedRows.length,
  };
}

/**
 * 將 Sheets 日期物件、文字日期或民國日期統一成 yyyy-MM-dd。
 */
function normalizeSheetDate_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(
      value,
      CONFIG.TIMEZONE,
      'yyyy-MM-dd'
    );
  }

  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  return parseGenericDate_(text);
}

function toTimestamp_(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.getTime();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function mergeUniqueText_(existing, incoming, separator) {
  const values = String(existing || '')
    .split(separator)
    .map((value) => value.trim())
    .filter(Boolean);
  const incomingValues = String(incoming || '')
    .split(separator)
    .map((value) => value.trim())
    .filter(Boolean);

  incomingValues.forEach((value) => {
    if (!values.includes(value)) {
      values.push(value);
    }
  });

  return values.join(separator);
}

function sortChipSheet_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 2) {
    return;
  }

  sheet
    .getRange(2, 1, lastRow - 1, CHIP_HEADERS.length)
    .sort([{ column: 1, ascending: false }]);
}


/**
 * 確認總表已完成初始化。正常每日執行不重做表頭與全欄格式。
 */
function ensureSummarySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SUMMARY_SHEET);
  const properties = PropertiesService.getDocumentProperties();
  const versionReady =
    properties.getProperty('SUMMARY_V211_READY') === '1';
  const ready =
    sheet &&
    sheet.getMaxColumns() >= SUMMARY_SUB_HEADERS.length &&
    sheet.getRange('A1').getDisplayValue() === '資料日期' &&
    sheet.getRange('C1').getDisplayValue() === '大盤現貨指數' &&
    sheet.getRange('S1').getDisplayValue() === '週選擇權 W (OI)' &&
    sheet.getRange('AH1').getDisplayValue() === '週選擇權 W (IV)' &&
    sheet.getRange('BC1').getDisplayValue() ===
      '台指期未平倉（大額近月、法人所有月）';

  if (!ready || !versionReady) {
    const hasHistoricalRows = sheet && sheet.getLastRow() > 2;
    if (hasHistoricalRows) {
      // v2.1.1 首次升級重建一次總表，將 67 欄遷移為 61 欄。
      syncSummaryTable_();
    } else {
      initializeSummarySheet_();
    }
    properties.setProperty('SUMMARY_V211_READY', '1');
  }

  ensureIncrementalSummaryMode_();
}

/**
 * v1.8 一次性遷移：移除只適合整表重建的 Banding，改採逐列底色。
 * 完成後每日只需設定新增／更新列的格式。
 */
function ensureIncrementalSummaryMode_() {
  const properties = PropertiesService.getDocumentProperties();
  const key = 'SUMMARY_INCREMENTAL_V18_READY';

  if (properties.getProperty(key) === '1') {
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    CONFIG.SUMMARY_SHEET
  );

  if (!sheet) {
    return;
  }

  sheet.getBandings().forEach((banding) => banding.remove());
  const rowCount = Math.max(sheet.getLastRow() - 2, 0);

  if (rowCount > 0) {
    applySummaryRowStyles_(sheet, 3, rowCount);
  }

  properties.setProperty(key, '1');
}

/**
 * 建立／更新「總表」雙層表頭及格式。
 * 總表資料列自第 3 列開始，一個交易日一列。
 */
function initializeSummarySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, CONFIG.SUMMARY_SHEET);
  const columnCount = SUMMARY_SUB_HEADERS.length;
  const legacyColumnCount = 67;

  if (sheet.getMaxColumns() < columnCount) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      columnCount - sheet.getMaxColumns()
    );
  }

  // v2.1.1 由 67 欄縮減為 61 欄；先解除舊雙層表頭合併並清除殘留欄位。
  const headerClearWidth = Math.min(
    Math.max(columnCount, legacyColumnCount),
    sheet.getMaxColumns()
  );
  sheet.getRange(1, 1, 2, headerClearWidth).breakApart();
  sheet.getRange(1, 1, 2, headerClearWidth).clearContent().clearFormat();

  SUMMARY_GROUPS.forEach((group) => {
    const width = group.end - group.start + 1;

    if (width === 1 && group.start <= 2) {
      sheet.getRange(1, group.start, 2, 1).merge();
      sheet.getRange(1, group.start).setValue(group.label);
    } else {
      sheet.getRange(1, group.start, 1, width).merge();
      sheet.getRange(1, group.start).setValue(group.label);
    }

    sheet
      .getRange(1, group.start, 1, width)
      .setBackground(group.fill)
      .setFontWeight('bold')
      .setHorizontalAlignment('center')
      .setVerticalAlignment('middle');
  });

  SUMMARY_GROUPS.forEach((group) => {
    const width = group.end - group.start + 1;
    const isVerticalMerge = width === 1 && group.start <= 2;

    if (!isVerticalMerge) {
      sheet
        .getRange(2, group.start, 1, width)
        .setValues([
          SUMMARY_SUB_HEADERS.slice(group.start - 1, group.end),
        ])
        .setBackground(group.fill);
    }
  });

  sheet
    .getRange(1, 1, 2, columnCount)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true)
    .setBorder(
      true,
      true,
      true,
      true,
      true,
      true,
      '#808080',
      SpreadsheetApp.BorderStyle.SOLID
    );

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(2);
  sheet.setRowHeight(1, 30);
  sheet.setRowHeight(2, 44);
  sheet.setTabColor('#4472C4');

  // 基本欄寬。
  sheet.setColumnWidth(1, 92);
  sheet.setColumnWidth(2, 52);
  sheet.setColumnWidths(3, 16, 82);
  sheet.setColumnWidth(8, 100);
  sheet.setColumnWidths(19, 15, 98);
  sheet.setColumnWidths(34, 18, 94);
  sheet.setColumnWidths(52, 3, 96);
  sheet.setColumnWidths(55, 7, 94);

  // 大盤現貨 C:L。
  sheet.getRange('A:B').setNumberFormat('@');
  sheet.getRange('C:G').setNumberFormat('#,##0.00');
  sheet.getRange('H:H').setNumberFormat('#,##0');
  sheet.getRange('I:L').setNumberFormat('#,##0.00');

  // 台指期 M:R。
  sheet.getRange('M:M').setNumberFormat('@');
  sheet.getRange('N:R').setNumberFormat('#,##0.00');

  // OI：W S:W、F X:AB、月 AC:AG。
  [
    ['S', 'T', 'U', 'V', 'W'],
    ['X', 'Y', 'Z', 'AA', 'AB'],
    ['AC', 'AD', 'AE', 'AF', 'AG'],
  ].forEach((cols) => {
    sheet.getRange(`${cols[0]}:${cols[0]}`).setNumberFormat('@');
    sheet.getRange(`${cols[1]}:${cols[1]}`).setNumberFormat('@');
    sheet.getRange(`${cols[2]}:${cols[2]}`).setNumberFormat('#,##0');
    sheet.getRange(`${cols[3]}:${cols[3]}`).setNumberFormat('@');
    sheet.getRange(`${cols[4]}:${cols[4]}`).setNumberFormat('#,##0');
  });

  // IV：
  // W AH:AM、F AN:AS、月 AT:AY。
  // 欄位：契約、Call IV、Call成交價、價平履約價、Put成交價、Put IV。
  [
    ['AH', 'AI', 'AJ', 'AK', 'AL', 'AM'],
    ['AN', 'AO', 'AP', 'AQ', 'AR', 'AS'],
    ['AT', 'AU', 'AV', 'AW', 'AX', 'AY'],
  ].forEach((cols) => {
    sheet.getRange(`${cols[0]}:${cols[0]}`).setNumberFormat('@');
    sheet.getRange(`${cols[1]}:${cols[1]}`).setNumberFormat('0.00');
    sheet.getRange(`${cols[2]}:${cols[2]}`).setNumberFormat('#,##0.00');
    sheet.getRange(`${cols[3]}:${cols[3]}`).setNumberFormat('#,##0');
    sheet.getRange(`${cols[4]}:${cols[4]}`).setNumberFormat('#,##0.00');
    sheet.getRange(`${cols[5]}:${cols[5]}`).setNumberFormat('0.00');
  });

  // 市場籌碼 AZ:BB；大額／法人 BC:BI。
  sheet.getRange('AZ:BB').setNumberFormat('0.00');
  sheet.getRange('BC:BI').setNumberFormat('#,##0');

  const directionalRanges = [
    sheet.getRange('G3:G'),
    sheet.getRange('L3:L'),
    sheet.getRange('R3:R'),
    sheet.getRange('BC3:BI'),
  ];
  const ivRanges = [
    sheet.getRange('AI3:AI'),
    sheet.getRange('AM3:AM'),
    sheet.getRange('AO3:AO'),
    sheet.getRange('AS3:AS'),
    sheet.getRange('AU3:AU'),
    sheet.getRange('AY3:AY'),
  ];
  const rules = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(0)
      .setFontColor('#C00000')
      .setRanges(directionalRanges)
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0)
      .setFontColor('#008000')
      .setRanges(directionalRanges)
      .build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThan(CONFIG.IV_ALERT_THRESHOLD)
      .setBackground('#F4CCCC')
      .setFontColor('#C00000')
      .setBold(true)
      .setRanges(ivRanges)
      .build(),
  ];
  sheet.setConditionalFormatRules(rules);
}

/**
 * 自訂選單使用的公開包裝函式。
 */
function rebuildSummaryTable() {
  const count = syncSummaryTable_();
  writeLog_('成功', `已重建總表，共 ${count} 筆交易日資料。`);
}

/**
 * 自訂選單使用：將三張來源表目前最新的資料日期增量寫入總表。
 */
function updateLatestSummaryRows() {
  const dates = collectLatestSourceDates_();
  const result = upsertSummaryDates_(dates);
  writeLog_(
    '成功',
    `總表增量更新完成：新增 ${result.added} 列、更新 ${result.updated} 列。`
  );
}

/**
 * 取得各來源工作表目前最新日期。日期不一致時全部納入，避免漏補資料。
 */
function collectLatestSourceDates_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dates = new Set();

  [CONFIG.DATA_SHEET, CONFIG.CHIP_SHEET, CONFIG.OPTION_OI_SHEET].forEach(
    (sheetName) => {
      const sheet = ss.getSheetByName(sheetName);
      if (!sheet || sheet.getLastRow() <= 1) return;

      const values = sheet
        .getRange(2, 1, sheet.getLastRow() - 1, 1)
        .getValues();
      const normalized = values
        .map((row) => normalizeSheetDate_(row[0]))
        .filter(Boolean)
        .sort();

      if (normalized.length) {
        dates.add(normalized[normalized.length - 1]);
      }
    }
  );

  return Array.from(dates).sort();
}

/**
 * 只新增／更新指定資料日期，不掃描或覆寫整份總表。
 * @param {string[]} rawDates
 * @return {{added:number, updated:number, dates:string[]}}
 */
function upsertSummaryDates_(rawDates) {
  ensureSummarySheet_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    CONFIG.SUMMARY_SHEET
  );
  const dates = Array.from(
    new Set((rawDates || []).map(normalizeSheetDate_).filter(Boolean))
  ).sort();
  let added = 0;
  let updated = 0;

  dates.forEach((date) => {
    const record = collectSummaryRecordForDate_(date);

    if (!record) {
      return;
    }

    const previousSpotClose = findPreviousSpotClose_(date);
    const rowValues = buildSummaryRow_(record, previousSpotClose);
    const existingRow = findSummaryRowByDate_(sheet, date);
    let targetRow = existingRow;
    let insertedBeforeExisting = false;

    if (targetRow > 0) {
      updated += 1;
    } else {
      targetRow = findSummaryInsertRow_(sheet, date);

      if (targetRow <= sheet.getLastRow()) {
        sheet.insertRowBefore(targetRow);
        insertedBeforeExisting = true;
      }

      added += 1;
    }

    sheet
      .getRange(targetRow, 1, 1, SUMMARY_SUB_HEADERS.length)
      .setValues([rowValues]);

    if (insertedBeforeExisting) {
      applySummaryRowStyles_(
        sheet,
        targetRow,
        sheet.getLastRow() - targetRow + 1
      );
    } else {
      applySummaryRowStyles_(sheet, targetRow, 1);
    }

    // 若補寫／修正歷史日期，下一個交易日的漲跌也要同步修正。
    refreshNextSummarySpotChange_(sheet, date);
  });

  return { added, updated, dates };
}

/**
 * 從三張來源表只讀取指定日期的列，組成一筆總表資料。
 */
function collectSummaryRecordForDate_(date) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const record = {
    date,
    sources: [],
    sourceStatuses: [],
    updateTimes: [],
  };
  let hasAnyData = false;

  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  findRowsForDate_(dataSheet, date, DATA_HEADERS.length).forEach((row) => {
    hasAnyData = true;
    const market = {
      contract: row[2],
      open: row[3],
      high: row[4],
      low: row[5],
      close: row[6],
      volume: row[10],
    };
    const product = String(row[1] || '');

    if (product.includes('大盤現貨')) {
      record.spot = market;
    } else if (product.includes('台指期貨')) {
      record.future = market;
    }

    addSummaryMeta_(record, row[7], row[8], row[9]);
  });

  const chipSheet = ss.getSheetByName(CONFIG.CHIP_SHEET);
  findRowsForDate_(chipSheet, date, CHIP_HEADERS.length).forEach((row) => {
    hasAnyData = true;
    record.chip = {
      miniRetailRatio: row[1],
      microRetailRatio: row[2],
      pcOpenInterestRatio: row[3],
      top5: row[4],
      top10: row[5],
      top5Special: row[6],
      top10Special: row[7],
      foreign: row[8],
      investmentTrust: row[9],
      dealer: row[10],
    };
    addSummaryMeta_(record, row[11], row[12], row[13]);
  });

  const optionSheet = ss.getSheetByName(CONFIG.OPTION_OI_SHEET);
  findRowsForDate_(optionSheet, date, OPTION_OI_HEADERS.length).forEach(
    (row) => {
      hasAnyData = true;
      record.option = {
        monthly: {
          contract: row[1],
          expiry: row[2],
          callStrike: row[3],
          callOi: row[4],
          putStrike: row[5],
          putOi: row[6],
          atmStrike: row[22],
          callLastPrice: row[23],
          callIv: row[24],
          putLastPrice: row[25],
          putIv: row[26],
        },
        weeklyWednesday: {
          contract: row[7],
          expiry: row[8],
          callStrike: row[9],
          callOi: row[10],
          putStrike: row[11],
          putOi: row[12],
          atmStrike: row[27],
          callLastPrice: row[28],
          callIv: row[29],
          putLastPrice: row[30],
          putIv: row[31],
        },
        weeklyFriday: {
          contract: row[13],
          expiry: row[14],
          callStrike: row[15],
          callOi: row[16],
          putStrike: row[17],
          putOi: row[18],
          atmStrike: row[32],
          callLastPrice: row[33],
          callIv: row[34],
          putLastPrice: row[35],
          putIv: row[36],
        },
      };
      addSummaryMeta_(record, row[19], row[20], row[21]);
    }
  );

  return hasAnyData ? record : null;
}

/**
 * 只掃描日期欄，再讀取符合日期的完整列。
 */
function findRowsForDate_(sheet, date, columnCount) {
  if (!sheet || sheet.getLastRow() <= 1) {
    return [];
  }

  const dateValues = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 1)
    .getValues();
  const rowNumbers = [];

  dateValues.forEach((row, index) => {
    if (normalizeSheetDate_(row[0]) === date) {
      rowNumbers.push(index + 2);
    }
  });

  return rowNumbers.map((rowNumber) =>
    sheet.getRange(rowNumber, 1, 1, columnCount).getValues()[0]
  );
}

/**
 * 將單日資料轉為總表 61 欄。
 */
function buildSummaryRow_(record, previousSpotClose) {
  const spot = record.spot || {};
  const future = record.future || {};
  const chip = record.chip || {};
  const option = record.option || {};
  const weeklyW = option.weeklyWednesday || {};
  const weeklyF = option.weeklyFriday || {};
  const monthly = option.monthly || {};
  const spotChange =
    isFiniteNumber_(spot.close) && isFiniteNumber_(previousSpotClose)
      ? roundMarketValue_(Number(spot.close) - Number(previousSpotClose))
      : '';
  const basis =
    isFiniteNumber_(future.close) && isFiniteNumber_(spot.close)
      ? roundMarketValue_(Number(future.close) - Number(spot.close))
      : '';
  const candle = calculateCandlestickMetrics_(spot);

  return [
    record.date,
    weekdayZh_(record.date),
    valueOrBlank_(spot.open),
    valueOrBlank_(spot.high),
    valueOrBlank_(spot.low),
    valueOrBlank_(spot.close),
    spotChange,
    valueOrBlank_(spot.volume),
    candle.upperShadow,
    candle.lowerShadow,
    candle.crossLine,
    candle.kBarLength,
    valueOrBlank_(future.contract),
    valueOrBlank_(future.open),
    valueOrBlank_(future.high),
    valueOrBlank_(future.low),
    valueOrBlank_(future.close),
    basis,

    // W／F／月選 OI：不輸出到期日。
    valueOrBlank_(weeklyW.contract),
    valueOrBlank_(weeklyW.callStrike),
    valueOrBlank_(weeklyW.callOi),
    valueOrBlank_(weeklyW.putStrike),
    valueOrBlank_(weeklyW.putOi),

    valueOrBlank_(weeklyF.contract),
    valueOrBlank_(weeklyF.callStrike),
    valueOrBlank_(weeklyF.callOi),
    valueOrBlank_(weeklyF.putStrike),
    valueOrBlank_(weeklyF.putOi),

    valueOrBlank_(monthly.contract),
    valueOrBlank_(monthly.callStrike),
    valueOrBlank_(monthly.callOi),
    valueOrBlank_(monthly.putStrike),
    valueOrBlank_(monthly.putOi),

    // W／F／月選 IV：
    // 契約、Call IV、Call成交價、價平履約價、Put成交價、Put IV。
    valueOrBlank_(weeklyW.contract),
    valueOrBlank_(weeklyW.callIv),
    valueOrBlank_(weeklyW.callLastPrice),
    valueOrBlank_(weeklyW.atmStrike),
    valueOrBlank_(weeklyW.putLastPrice),
    valueOrBlank_(weeklyW.putIv),

    valueOrBlank_(weeklyF.contract),
    valueOrBlank_(weeklyF.callIv),
    valueOrBlank_(weeklyF.callLastPrice),
    valueOrBlank_(weeklyF.atmStrike),
    valueOrBlank_(weeklyF.putLastPrice),
    valueOrBlank_(weeklyF.putIv),

    valueOrBlank_(monthly.contract),
    valueOrBlank_(monthly.callIv),
    valueOrBlank_(monthly.callLastPrice),
    valueOrBlank_(monthly.atmStrike),
    valueOrBlank_(monthly.putLastPrice),
    valueOrBlank_(monthly.putIv),

    valueOrBlank_(chip.pcOpenInterestRatio),
    valueOrBlank_(chip.miniRetailRatio),
    valueOrBlank_(chip.microRetailRatio),
    valueOrBlank_(chip.top5),
    valueOrBlank_(chip.top10),
    valueOrBlank_(chip.top5Special),
    valueOrBlank_(chip.top10Special),
    valueOrBlank_(chip.foreign),
    valueOrBlank_(chip.investmentTrust),
    valueOrBlank_(chip.dealer),
  ];
}

/**
 * K 棒計算沿用參考表公式：
 * 上影線 = 高 - MAX(收, 開)
 * 下影線 = MIN(收, 開) - 低
 * 十字線 = ABS(收 - 開)
 * K棒長度 = 收 - 開 - 上影線 + 下影線
 */
function calculateCandlestickMetrics_(spot) {
  if (!hasSummaryMarket_(spot)) {
    return {
      upperShadow: '',
      lowerShadow: '',
      crossLine: '',
      kBarLength: '',
    };
  }

  const open = Number(spot.open);
  const high = Number(spot.high);
  const low = Number(spot.low);
  const close = Number(spot.close);
  const upperShadow = high - Math.max(close, open);
  const lowerShadow = Math.min(close, open) - low;
  const crossLine = Math.abs(close - open);
  const kBarLength = close - open - upperShadow + lowerShadow;

  return {
    upperShadow: roundMarketValue_(upperShadow),
    lowerShadow: roundMarketValue_(lowerShadow),
    crossLine: roundMarketValue_(crossLine),
    kBarLength: roundMarketValue_(kBarLength),
  };
}

function roundMarketValue_(value) {
  return Number.isFinite(Number(value))
    ? Math.round(Number(value) * 100) / 100
    : '';
}

function findSummaryRowByDate_(sheet, date) {
  if (!sheet || sheet.getLastRow() <= 2) return -1;
  const values = sheet
    .getRange(3, 1, sheet.getLastRow() - 2, 1)
    .getValues();

  for (let index = 0; index < values.length; index += 1) {
    if (normalizeSheetDate_(values[index][0]) === date) {
      return index + 3;
    }
  }

  return -1;
}

/**
 * 正常情況新交易日直接附加到底部；若補歷史日期則插入正確位置。
 */
function findSummaryInsertRow_(sheet, date) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 2) return 3;

  const values = sheet.getRange(3, 1, lastRow - 2, 1).getValues();
  for (let index = 0; index < values.length; index += 1) {
    const existingDate = normalizeSheetDate_(values[index][0]);
    if (existingDate && existingDate > date) {
      return index + 3;
    }
  }

  return lastRow + 1;
}

/**
 * 由每日行情表找出指定日期之前最近一個現貨收盤價。
 */
function findPreviousSpotClose_(date) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(
    CONFIG.DATA_SHEET
  );
  if (!sheet || sheet.getLastRow() <= 1) return '';

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 7)
    .getValues();
  let bestDate = '';
  let close = '';

  rows.forEach((row) => {
    const rowDate = normalizeSheetDate_(row[0]);
    const product = String(row[1] || '');

    if (
      rowDate &&
      rowDate < date &&
      rowDate > bestDate &&
      product.includes('大盤現貨') &&
      isFiniteNumber_(row[6])
    ) {
      bestDate = rowDate;
      close = Number(row[6]);
    }
  });

  return close;
}

/**
 * 若歷史資料被補寫，更新下一個交易日的現貨漲跌欄。
 */
function refreshNextSummarySpotChange_(sheet, date) {
  if (!sheet || sheet.getLastRow() <= 2) return;
  const values = sheet
    .getRange(3, 1, sheet.getLastRow() - 2, 1)
    .getValues()
    .map((row, index) => ({
      date: normalizeSheetDate_(row[0]),
      row: index + 3,
    }))
    .filter((item) => item.date && item.date > date)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!values.length) return;
  const next = values[0];
  const nextClose = sheet.getRange(next.row, 6).getValue();
  const previousClose = findPreviousSpotClose_(next.date);
  const change =
    isFiniteNumber_(nextClose) && isFiniteNumber_(previousClose)
      ? Number(nextClose) - Number(previousClose)
      : '';

  sheet.getRange(next.row, 7).setValue(change);
}

/**
 * 只格式化新增／更新列。灰白相間底色以資料列序號決定。
 */
function applySummaryRowStyles_(sheet, startRow, rowCount) {
  if (!sheet || rowCount <= 0) return;

  const range = sheet.getRange(
    startRow,
    1,
    rowCount,
    SUMMARY_SUB_HEADERS.length
  );
  const backgrounds = [];

  for (let offset = 0; offset < rowCount; offset += 1) {
    const color = (startRow + offset - 3) % 2 === 0 ? '#FFFFFF' : '#F2F2F2';
    backgrounds.push(Array(SUMMARY_SUB_HEADERS.length).fill(color));
  }

  range
    .setBackgrounds(backgrounds)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setBorder(
      true,
      true,
      true,
      true,
      true,
      true,
      '#D9D9D9',
      SpreadsheetApp.BorderStyle.SOLID
    );
}

/**
 * 從「每日行情」「每日籌碼」「選擇權OI」重建總表。
 * 以資料日期為唯一鍵，因此來源日期不同時不會互相錯填。
 * @return {number} 總表資料列數。
 */
function syncSummaryTable_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  initializeSummarySheet_();
  const summarySheet = ss.getSheetByName(CONFIG.SUMMARY_SHEET);
  const records = new Map();

  const ensureRecord = (rawDate) => {
    const date = normalizeSheetDate_(rawDate);

    if (!date) {
      return null;
    }

    if (!records.has(date)) {
      records.set(date, {
        date,
        sources: [],
        sourceStatuses: [],
        updateTimes: [],
      });
    }

    return records.get(date);
  };

  const dataSheet = ss.getSheetByName(CONFIG.DATA_SHEET);
  if (dataSheet && dataSheet.getLastRow() > 1) {
    const rows = dataSheet
      .getRange(2, 1, dataSheet.getLastRow() - 1, DATA_HEADERS.length)
      .getValues();

    rows.forEach((row) => {
      const record = ensureRecord(row[0]);
      if (!record) return;

      const market = {
        contract: row[2],
        open: row[3],
        high: row[4],
        low: row[5],
        close: row[6],
        volume: row[10],
      };
      const product = String(row[1] || '');

      if (product.includes('大盤現貨')) {
        record.spot = market;
      } else if (product.includes('台指期貨')) {
        record.future = market;
      }

      addSummaryMeta_(record, row[7], row[8], row[9]);
    });
  }

  const chipSheet = ss.getSheetByName(CONFIG.CHIP_SHEET);
  if (chipSheet && chipSheet.getLastRow() > 1) {
    const rows = chipSheet
      .getRange(2, 1, chipSheet.getLastRow() - 1, CHIP_HEADERS.length)
      .getValues();

    rows.forEach((row) => {
      const record = ensureRecord(row[0]);
      if (!record) return;

      record.chip = {
        miniRetailRatio: row[1],
        microRetailRatio: row[2],
        pcOpenInterestRatio: row[3],
        top5: row[4],
        top10: row[5],
        top5Special: row[6],
        top10Special: row[7],
        foreign: row[8],
        investmentTrust: row[9],
        dealer: row[10],
      };

      addSummaryMeta_(record, row[11], row[12], row[13]);
    });
  }

  const optionSheet = ss.getSheetByName(CONFIG.OPTION_OI_SHEET);
  if (optionSheet && optionSheet.getLastRow() > 1) {
    const rows = optionSheet
      .getRange(2, 1, optionSheet.getLastRow() - 1, OPTION_OI_HEADERS.length)
      .getValues();

    rows.forEach((row) => {
      const record = ensureRecord(row[0]);
      if (!record) return;

      record.option = {
        monthly: {
          contract: row[1],
          expiry: row[2],
          callStrike: row[3],
          callOi: row[4],
          putStrike: row[5],
          putOi: row[6],
          atmStrike: row[22],
          callLastPrice: row[23],
          callIv: row[24],
          putLastPrice: row[25],
          putIv: row[26],
        },
        weeklyWednesday: {
          contract: row[7],
          expiry: row[8],
          callStrike: row[9],
          callOi: row[10],
          putStrike: row[11],
          putOi: row[12],
          atmStrike: row[27],
          callLastPrice: row[28],
          callIv: row[29],
          putLastPrice: row[30],
          putIv: row[31],
        },
        weeklyFriday: {
          contract: row[13],
          expiry: row[14],
          callStrike: row[15],
          callOi: row[16],
          putStrike: row[17],
          putOi: row[18],
          atmStrike: row[32],
          callLastPrice: row[33],
          callIv: row[34],
          putLastPrice: row[35],
          putIv: row[36],
        },
      };

      addSummaryMeta_(record, row[19], row[20], row[21]);
    });
  }

  const dates = Array.from(records.keys()).sort();
  const output = [];
  let previousSpotClose = '';

  dates.forEach((date) => {
    const record = records.get(date);
    output.push(buildSummaryRow_(record, previousSpotClose));

    const spot = record.spot || {};
    if (isFiniteNumber_(spot.close)) {
      previousSpotClose = Number(spot.close);
    }
  });

  const oldRowCount = Math.max(summarySheet.getLastRow() - 2, 0);
  if (oldRowCount > 0) {
    // v2.1.1 遷移時連同舊版 67 欄資料一併清除，避免 BJ:BO 殘留。
    const clearWidth = Math.min(67, summarySheet.getMaxColumns());
    summarySheet
      .getRange(3, 1, oldRowCount, clearWidth)
      .clearContent();
  }

  summarySheet.getBandings().forEach((banding) => banding.remove());

  if (output.length > 0) {
    summarySheet
      .getRange(3, 1, output.length, SUMMARY_SUB_HEADERS.length)
      .setValues(output);
    applySummaryRowStyles_(summarySheet, 3, output.length);
  }

  PropertiesService.getDocumentProperties().setProperty(
    'SUMMARY_INCREMENTAL_V18_READY',
    '1'
  );
  PropertiesService.getDocumentProperties().setProperty(
    'SUMMARY_V20_READY',
    '1'
  );
  PropertiesService.getDocumentProperties().setProperty(
    'SUMMARY_V211_READY',
    '1'
  );

  return output.length;
}

function addSummaryMeta_(record, source, updateTime, status) {
  if (source) {
    String(source)
      .split('；')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (!record.sources.includes(item)) record.sources.push(item);
      });
  }

  if (updateTime instanceof Date && !isNaN(updateTime.getTime())) {
    record.updateTimes.push(updateTime);
  }

  if (status) {
    String(status)
      .split('／')
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((item) => {
        if (!record.sourceStatuses.includes(item)) record.sourceStatuses.push(item);
      });
  }
}

function weekdayZh_(dateText) {
  const parts = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return '';
  const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), 12, 0, 0);
  const names = ['日', '一', '二', '三', '四', '五', '六'];
  return names[date.getDay()];
}

function valueOrBlank_(value) {
  return value === null || value === undefined ? '' : value;
}

function isFiniteNumber_(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function hasSummaryMarket_(market) {
  return ['open', 'high', 'low', 'close'].every((field) => isFiniteNumber_(market[field]));
}

function hasSummaryChip_(chip) {
  return [
    'miniRetailRatio',
    'microRetailRatio',
    'pcOpenInterestRatio',
    'top5',
    'top10',
    'top5Special',
    'top10Special',
    'foreign',
    'investmentTrust',
    'dealer',
  ].every((field) => chip[field] !== '' && chip[field] !== null && chip[field] !== undefined);
}

function hasSummaryOptions_(option) {
  return ['monthly', 'weeklyWednesday', 'weeklyFriday'].every((group) => {
    const item = option[group] || {};
    return (
      item.contract &&
      item.callStrike !== '' &&
      item.callOi !== '' &&
      item.putStrike !== '' &&
      item.putOi !== '' &&
      isFiniteNumber_(item.atmStrike) &&
      isFiniteNumber_(item.callLastPrice) &&
      isFiniteNumber_(item.callIv) &&
      isFiniteNumber_(item.putLastPrice) &&
      isFiniteNumber_(item.putIv)
    );
  });
}

/**
 * 使用相同授權與基本 HTTP 設定抓取網址。
 */
function fetchUrl_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Accept: 'application/json,text/csv,text/plain,*/*',
      'User-Agent':
        'Mozilla/5.0 (compatible; GoogleAppsScript MarketUpdater)',
    },
    followRedirects: true,
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();

  if (code < 200 || code >= 300) {
    throw new Error(`HTTP ${code}：${url}`);
  }

  return response;
}

function getOrCreateSheet_(spreadsheet, name) {
  return (
    spreadsheet.getSheetByName(name) ||
    spreadsheet.insertSheet(name)
  );
}

function initializeHeader_(sheet, headers) {
  const current = sheet
    .getRange(1, 1, 1, headers.length)
    .getValues()[0];

  const matches = headers.every(
    (header, index) => current[index] === header
  );

  if (!matches) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers]);
  }

  sheet
    .getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
}

function sortDataSheet_(sheet) {
  const lastRow = sheet.getLastRow();

  if (lastRow <= 2) {
    return;
  }

  sheet
    .getRange(2, 1, lastRow - 1, DATA_HEADERS.length)
    .sort([
      { column: 1, ascending: false },
      { column: 2, ascending: true },
    ]);
}

function writeLog_(result, message) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getOrCreateSheet_(ss, CONFIG.LOG_SHEET);

  if (sheet.getLastRow() === 0) {
    initializeHeader_(sheet, LOG_HEADERS);
  }

  sheet.appendRow([new Date(), result, message]);
}

function deleteTriggersByHandler_(handlerName) {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function findHeaderIndex_(
  headers,
  aliases,
  required = true
) {
  const normalizedHeaders = headers.map(normalizeHeader_);
  const normalizedAliases = aliases.map(normalizeHeader_);

  const index = normalizedHeaders.findIndex((header) =>
    normalizedAliases.includes(header)
  );

  if (index < 0 && required) {
    throw new Error(
      `找不到欄位：${aliases.join('／')}`
    );
  }

  return index;
}

function normalizeHeader_(value) {
  return normalizeFieldKey_(value);
}

function normalizeFieldKey_(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[\s_*＊\-－—()（）\[\]【】%％./／\\:：]/g, '')
    .trim();
}

/**
 * 移除 HTML 標籤與 script/style 區塊。
 */
function stripHtml_(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * 解碼本頁解析會遇到的常見 HTML entity。
 */
function decodeHtmlEntities_(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCharCode(Number(code))
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(parseInt(code, 16))
    );
}

function normalizeWhitespace_(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNumber_(value) {
  const cleaned = String(value ?? '')
    .replace(/,/g, '')
    .replace(/[▲▼%]/g, '')
    .trim();

  if (!cleaned || cleaned === '-') {
    return NaN;
  }

  return Number(cleaned);
}

function parseTwseDate_(value) {
  const text = String(value || '').trim();
  let match = text.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})$/);

  if (match) {
    const year = Number(match[1]) + 1911;
    return formatDateParts_(
      year,
      Number(match[2]),
      Number(match[3])
    );
  }

  return parseGenericDate_(text);
}

function parseGenericDate_(value) {
  const text = String(value || '').trim();

  // 西元日期：2026/8/6、2026-08-06。
  let match = text.match(
    /^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/
  );

  if (match) {
    return formatDateParts_(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
  }

  // 西元緊湊格式：20260806。
  match = text.match(/^(\d{4})(\d{2})(\d{2})$/);

  if (match) {
    return formatDateParts_(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
  }

  // 民國日期：115/08/06。
  match = text.match(
    /^(\d{2,3})[\/-](\d{1,2})[\/-](\d{1,2})$/
  );

  if (match) {
    return formatDateParts_(
      Number(match[1]) + 1911,
      Number(match[2]),
      Number(match[3])
    );
  }

  // 民國緊湊格式：1150806。
  match = text.match(/^(\d{3})(\d{2})(\d{2})$/);

  if (match) {
    return formatDateParts_(
      Number(match[1]) + 1911,
      Number(match[2]),
      Number(match[3])
    );
  }

  return '';
}

function formatDateParts_(year, month, day) {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

function monthStartKey_(date) {
  return Utilities.formatDate(
    date,
    CONFIG.TIMEZONE,
    'yyyyMM'
  ) + '01';
}
