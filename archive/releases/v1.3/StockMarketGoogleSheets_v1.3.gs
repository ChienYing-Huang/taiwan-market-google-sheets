/**
 * 台股現貨與台指期每日行情更新器
 * 資料來源：
 * 1. 臺灣證券交易所：發行量加權股價指數歷史資料
 * 2. 臺灣期貨交易所官網：期貨每日交易行情（日盤）
 * 3. 玩股網：小台指／微台指散戶多空比
 * 4. 臺灣期貨交易所：臺指選擇權 Put/Call 比
 * 5. 聚財網：台指期大額與法人未平倉資料
 *
 * 使用方式：
 * 1. 在 Google 試算表開啟「擴充功能 → Apps Script」
 * 2. 將本檔完整貼到 Code.gs
 * 3. 儲存後執行 setupMarketUpdater()
 * 4. 首次執行需授權
 *
 * v1.3：新增散戶多空比、Put/Call 未平倉量比及大額／法人未平倉資料。
 *       各網站依自己的最新資料日期寫入「每日籌碼」，避免混用不同日期。
 */

const CONFIG = {
  TIMEZONE: 'Asia/Taipei',
  DATA_SHEET: '每日行情',
  CHIP_SHEET: '每日籌碼',
  LOG_SHEET: '執行紀錄',
  TRIGGER_HOUR: 20,
  TRIGGER_MINUTE: 0,

  TWSE_URL:
    'https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?response=json&date=',

  // 官網的 Excel 外部資料頁通常比 OpenAPI 更早提供當日日盤行情。
  TAIFEX_WEB_URL:
    'https://www.taifex.com.tw/cht/3/futDailyMarketExcel?commodity_id=TX',

  TAIFEX_OPENAPI_URL:
    'https://openapi.taifex.com.tw/v1/DailyMarketReportFut',

  TAIFEX_CSV_URL:
    'https://www.taifex.com.tw/data_gov/taifex_open_data.asp?data_name=DailyMarketReportFut',

  WANTGOO_MINI_RETAIL_URL:
    'https://www.wantgoo.com/futures/retail-indicator/wmt%26',

  WANTGOO_MICRO_RETAIL_URL:
    'https://www.wantgoo.com/futures/retail-indicator/wtm%26',

  TAIFEX_PC_RATIO_URL:
    'https://www.taifex.com.tw/cht/3/pcRatio',

  WEARN_TAIFEX_URL:
    'https://stock.wearn.com/taifexphoto.asp',
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

  const chipSheet = getOrCreateSheet_(ss, CONFIG.CHIP_SHEET);
  initializeHeader_(chipSheet, CHIP_HEADERS);
  chipSheet.setFrozenRows(1);
  chipSheet.getRange('A:A').setNumberFormat('@');
  chipSheet.getRange('B:D').setNumberFormat('0.00');
  chipSheet.getRange('E:K').setNumberFormat('#,##0');
  chipSheet.getRange('M:M').setNumberFormat('yyyy/mm/dd hh:mm:ss');
  chipSheet.autoResizeColumns(1, CHIP_HEADERS.length);

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

    try {
      const mini = fetchWantgooRetailRatio_(
        CONFIG.WANTGOO_MINI_RETAIL_URL,
        '小台指散戶多空比'
      );
      upsertChipFields_({
        date: mini.date,
        miniRetailRatio: mini.ratio,
        source: '玩股網－小台指散戶多空比',
        status: mini.date === today ? '當日資料' : '最近可用交易日',
      });
      results.push(`小台散戶比 ${mini.date}`);
    } catch (error) {
      errors.push(`小台散戶比：${error.message}`);
    }

    try {
      const micro = fetchWantgooRetailRatio_(
        CONFIG.WANTGOO_MICRO_RETAIL_URL,
        '微台指散戶多空比'
      );
      upsertChipFields_({
        date: micro.date,
        microRetailRatio: micro.ratio,
        source: '玩股網－微台指散戶多空比',
        status: micro.date === today ? '當日資料' : '最近可用交易日',
      });
      results.push(`微台散戶比 ${micro.date}`);
    } catch (error) {
      errors.push(`微台散戶比：${error.message}`);
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
      results.push(`大額法人未平倉 ${positions.date}`);
    } catch (error) {
      errors.push(`大額法人未平倉：${error.message}`);
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
 * 取得玩股網的小台指或微台指散戶多空比。
 */
function fetchWantgooRetailRatio_(baseUrl, expectedTitle) {
  const html = fetchHtmlWithCacheBust_(baseUrl, ['UTF-8']);
  const plainText = normalizeWhitespace_(
    decodeHtmlEntities_(stripHtml_(html))
  );

  if (!plainText.includes(expectedTitle)) {
    throw new Error(`頁面中找不到「${expectedTitle}」。`);
  }

  const rows = extractHtmlTableRows_(html);
  const candidates = rows
    .filter((cells) => cells.length >= 5)
    .map((cells) => ({
      date: parseGenericDate_(cells[0]),
      ratio: parseNumber_(cells[4]),
    }))
    .filter(
      (row) => row.date && Number.isFinite(row.ratio)
    )
    .sort((a, b) => b.date.localeCompare(a.date));

  if (candidates.length === 0) {
    throw new Error('找不到可用的散戶多空比資料列。');
  }

  return candidates[0];
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

  const lastRow = sheet.getLastRow();
  const data =
    lastRow > 1
      ? sheet
          .getRange(2, 1, lastRow - 1, CHIP_HEADERS.length)
          .getValues()
      : [];

  const existingIndex = data.findIndex(
    (row) => String(row[0]).trim() === record.date
  );
  const values =
    existingIndex >= 0
      ? data[existingIndex].slice()
      : new Array(CHIP_HEADERS.length).fill('');

  values[0] = record.date;

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

function mergeUniqueText_(existing, incoming, separator) {
  const values = String(existing || '')
    .split(separator)
    .map((value) => value.trim())
    .filter(Boolean);
  const newValue = String(incoming || '').trim();

  if (newValue && !values.includes(newValue)) {
    values.push(newValue);
  }

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
