/**
 * 台股現貨與台指期每日行情更新器
 * 資料來源：
 * 1. 臺灣證券交易所：發行量加權股價指數歷史資料
 * 2. 臺灣期貨交易所：期貨每日交易行情
 *
 * 使用方式：
 * 1. 在 Google 試算表開啟「擴充功能 → Apps Script」
 * 2. 將本檔完整貼到 Code.gs
 * 3. 儲存後執行 setupMarketUpdater()
 * 4. 首次執行需授權
 */

const CONFIG = {
  TIMEZONE: 'Asia/Taipei',
  DATA_SHEET: '每日行情',
  LOG_SHEET: '執行紀錄',
  TRIGGER_HOUR: 20,
  TRIGGER_MINUTE: 0,

  TWSE_URL:
    'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date=',

  TAIFEX_URL:
    'https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyMarketReportFut',
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
];

const LOG_HEADERS = ['執行時間', '結果', '訊息'];

/**
 * 開啟試算表時新增功能選單。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('台股行情工具')
    .addItem('立即更新', 'updateMarketData')
    .addItem('建立／重建排程', 'createDailyTrigger')
    .addItem('初始化工作表', 'initializeSheets')
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
  initializeHeader_(dataSheet, DATA_HEADERS);
  dataSheet.setFrozenRows(1);
  dataSheet.getRange('A:A').setNumberFormat('@');
  dataSheet.getRange('D:G').setNumberFormat('#,##0.00');
  dataSheet.getRange('I:I').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  dataSheet.autoResizeColumns(1, DATA_HEADERS.length);

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

    try {
      const spot = fetchTwseTaiex_();
      spot.status =
        spot.date === today ? '當日資料' : '最近可用交易日';
      upsertMarketRow_(spot);
      results.push(`大盤現貨 ${spot.date}`);
    } catch (error) {
      errors.push(`大盤現貨：${error.message}`);
    }

    try {
      const future = fetchTaifexTx_();
      future.status =
        future.date === today ? '當日資料' : '最近可用交易日';
      upsertMarketRow_(future);
      results.push(`台指期 ${future.date} ${future.contractMonth}`);
    } catch (error) {
      errors.push(`台指期：${error.message}`);
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

  return {
    ...latest,
    product: '大盤現貨指數',
    contractMonth: '',
    source: '臺灣證券交易所',
  };
}

/**
 * 取得臺股期貨 TX 最近可用之一般交易時段近月契約 OHLC。
 */
function fetchTaifexTx_() {
  const response = fetchUrl_(CONFIG.TAIFEX_URL);

  let text = response
    .getContentText('UTF-8')
    .replace(/^\uFEFF/, '');

  // 若 UTF-8 解碼後欄位異常，嘗試 Big5。
  if (
    !text.includes('契約') &&
    !text.includes('交易日期') &&
    !text.includes('日期')
  ) {
    text = response
      .getContentText('Big5')
      .replace(/^\uFEFF/, '');
  }

  const table = Utilities.parseCsv(text);

  if (!Array.isArray(table) || table.length < 2) {
    throw new Error('期交所 CSV 無有效資料。');
  }

  const headers = table[0].map(normalizeHeader_);
  const dataRows = table.slice(1);

  const dateIndex = findHeaderIndex_(
    headers,
    ['交易日期', '日期']
  );
  const contractIndex = findHeaderIndex_(
    headers,
    ['契約', '商品代號']
  );
  const expiryIndex = findHeaderIndex_(
    headers,
    ['到期月份(週別)', '到期月份週別', '到期月份']
  );
  const openIndex = findHeaderIndex_(
    headers,
    ['開盤價']
  );
  const highIndex = findHeaderIndex_(
    headers,
    ['最高價']
  );
  const lowIndex = findHeaderIndex_(
    headers,
    ['最低價']
  );
  const closeIndex = findHeaderIndex_(
    headers,
    ['最後成交價', '收盤價']
  );
  const sessionIndex = findHeaderIndex_(
    headers,
    ['交易時段'],
    false
  );

  const candidates = dataRows
    .map((row) => {
      const session =
        sessionIndex >= 0 ? String(row[sessionIndex]).trim() : '';

      return {
        date: parseGenericDate_(row[dateIndex]),
        contract: String(row[contractIndex] || '').trim(),
        contractMonth: String(row[expiryIndex] || '')
          .trim()
          .replace(/\s/g, ''),
        open: parseNumber_(row[openIndex]),
        high: parseNumber_(row[highIndex]),
        low: parseNumber_(row[lowIndex]),
        close: parseNumber_(row[closeIndex]),
        session,
      };
    })
    .filter((row) => row.contract === 'TX')
    .filter(
      (row) =>
        !row.session ||
        row.session.includes('一般')
    )
    .filter(
      (row) =>
        row.contractMonth &&
        !row.contractMonth.includes('/')
    )
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

  const latestCandidates = candidates
    .filter((row) => row.date === latestDate)
    .sort((a, b) =>
      a.contractMonth.localeCompare(b.contractMonth)
    );

  const latest = latestCandidates[0];

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
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\*/g, '')
    .replace(/\s+/g, '')
    .trim();
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

  let match = text.match(
    /^(\d{4})[\/-]?(\d{2})[\/-]?(\d{2})$/
  );

  if (match) {
    return formatDateParts_(
      Number(match[1]),
      Number(match[2]),
      Number(match[3])
    );
  }

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
