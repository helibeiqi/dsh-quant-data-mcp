#!/usr/bin/env node
// =============================================================================
// quant-mcp-server.mjs — Zero-dependency MCP stdio server (TEMPLATE + example)
// -----------------------------------------------------------------------------
// A minimal, dependency-free MCP server that speaks the REAL Model Context
// Protocol over stdio and ships a working A-share (Chinese stock) data toolkit
// as the out-of-the-box example. To build a different zero-key local data
// source, just edit the `TOOLS` array + the `handleCall` dispatch below.
//
// Protocol: NDJSON — one JSON-RPC 2.0 object per line, terminated by '\n',
// with a trailing '\r' tolerated & stripped. This is EXACTLY what the official
// MCP SDK (and dsh's dsh-mcp-client) speaks. DO NOT use Content-Length framing:
// the SDK's stdio reader splits on '\n', so a Content-Length frame never matches
// and the server silently fails to attach (a classic gotcha).
//
// Transport: stdio. Runtime: any Node >= 18 (built-in fetch required).
// Dependencies: ZERO. Node built-ins only (node:process, node:fs, node:util).
//
// Runtime configuration (all optional, via environment variables):
//   QUANT_MCP_LOG  Path to an append-only log file. Unset => logging disabled.
//   (command/args/cwd are supplied by dsh via cordis.patch.yml — see README)
//
// Tools (model namespace mcp__quant__*):
//   1. a_share_daily    - A-share daily OHLCV kline. Sources: East Money push2his (primary, has amount)
//                        -> Tencent proxy.finance.qq.com fqkline (fallback) -> local akshare/baostock (if detected).
//   2. quote_snapshot   - realtime snapshot quote for one stock (Tencent; highly available).
//   3. quote_batch      - realtime snapshot for many stocks in one call (Tencent).
//   4. financials       - main financial indicators across periods. Sources: East Money datacenter (primary)
//                        -> local akshare (fallback, if detected). Key-free.
//   5. northbound       - 沪深港通 (Stock Connect) capital-flow snapshot. Sources: East Money kamt (primary)
//                        -> local akshare (fallback, if detected).
//   6. sectors          - industry/concept/region board list w/ main-net inflow. Sources: East Money clist (primary)
//                        -> local akshare (fallback, if detected).
//   The optional akshare/baostock layer is OFF unless a Python interpreter that can `import akshare`
//   is found at startup (auto-detected; override with AKSHARE_PYTHON / AKSHARE_HELPER env vars).
//
// All endpoints are public and require NO API key. Data-source taboos (anti-
// scrape / dead / 403) are documented inline so you don't re-hit dead ends.
// =============================================================================

import process from 'node:process';
import { appendFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// --- optional logging; disabled unless QUANT_MCP_LOG is set -------------------
const LOG = process.env.QUANT_MCP_LOG || null;
function log(...a) {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`);
  } catch {}
}
log('server started pid=' + process.pid);

// ---------- MCP framing: NEWLINE-DELIMITED JSON (NDJSON) ----------
// Each JSON-RPC message is one line terminated by '\n'. We buffer stdin, split
// on '\n', strip a trailing '\r', and JSON.parse each non-empty line.
let buf = '';
process.stdin.on('data', (chunk) => { buf += chunk.toString('utf8'); drain(); });
process.stdin.on('end', () => process.exit(0));

function drain() {
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  // notifications (e.g. notifications/initialized) have no id — ignore
  if (msg.id === undefined && msg.method) return;
  log('recv method=' + msg.method + (msg.params ? ' params.keys=' + Object.keys(msg.params).join(',') : ''));
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'quant-mcp', version: '1.0.0' },
      } });
      log('sent initialize result (echoed protocolVersion=' + (msg.params?.protocolVersion || '2024-11-05') + ')');
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      log('sent tools/list with ' + TOOLS.length + ' tools: ' + TOOLS.map(t => t.name).join(','));
      break;
    case 'tools/call':
      handleCall(msg).then((r) => send({ jsonrpc: '2.0', id: msg.id, result: r }));
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
  }
}

async function handleCall(msg) {
  const { name, arguments: args } = msg.params || {};
  try {
    let result;
    if (name === 'a_share_daily') result = await aShareDaily(args || {});
    else if (name === 'quote_snapshot') result = await quoteSnapshot(args || {});
    else if (name === 'quote_batch') result = await quoteBatch(args || {});
    else if (name === 'financials') result = await financials(args || {});
    else if (name === 'northbound') result = await northbound(args || {});
    else if (name === 'sectors') result = await sectors(args || {});
    else throw new Error('Unknown tool: ' + name);
    const summary = name === 'a_share_daily' ? (result.name + ' rows=' + result.count)
      : name === 'quote_snapshot' ? (result.name + ' price=' + result.price)
      : name === 'quote_batch' ? ('count=' + result.count)
      : name === 'financials' ? (result.name + ' periods=' + result.count)
      : name === 'northbound' ? ('totalAllYi=' + result.totalAllNetAmtInYi)
      : name === 'sectors' ? (result.type + ' boards=' + result.count)
      : 'ok';
    log('call ' + name + ' -> ' + summary);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String((e && e.message) || e) }] };
  }
}

// ---------- generic helpers (port these to your own tools) ----------
function parseSymbol(symbol) {
  if (/^sh\d{6}$/i.test(symbol)) return { mkt: 1, code: symbol.slice(2) };
  if (/^sz\d{6}$/i.test(symbol)) return { mkt: 0, code: symbol.slice(2) };
  if (/^\d{6}$/.test(symbol)) return { mkt: symbol[0] === '6' ? 1 : 0, code: symbol };
  throw new Error('Bad symbol: ' + symbol + ' (expect 6-digit code or sh/sz prefix)');
}
function ymd(s) { return (s || '').replace(/-/g, ''); }
// Convert 元 -> 亿元 (null-safe)
function yi(v) { return v != null && !isNaN(v) ? +(v / 1e8).toFixed(2) : null; }
// Encode an East Money datacenter filter expression
function emFilter(expr) { return encodeURIComponent(expr); }

// Host-resilient fetch: try each source in order, return the first that yields
// a non-null, error-free parse. A source is either:
//   { name, url, parse?, headers? }  -> HTTP GET + optional parse(text)
//   { name, fn }                     -> an async function returning the parsed value
// This lets us chain HTTP mirrors AND an optional local akshare/baostock bridge
// (see runAkshare) behind one uniform fallback loop. A source that returns
// { __error__: ... } is treated as a failure and the loop continues.
async function fetchFirstOk(sources, { timeoutMs = 12000 } = {}) {
  let lastErr;
  for (const src of sources) {
    try {
      let parsed;
      if (typeof src.fn === 'function') {
        parsed = await src.fn();
      } else {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(src.url, { headers: src.headers || { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
        clearTimeout(tid);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const text = await r.text();
        parsed = src.parse ? src.parse(text) : JSON.parse(text);
      }
      if (parsed && !parsed.__error__) return { value: parsed, source: src.name };
      if (parsed && parsed.__error__) throw new Error(parsed.__error__);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all sources failed');
}

// ---------- optional akshare/baostock bridge (local Python, env-gated) ----------
// The server is zero-dependency by default. At startup we probe for a Python
// that can `import akshare`; if found, AKSHARE_PY holds that interpreter and the
// akshare/baostock fallback is enabled. If none is found, AKSHARE_PY stays null
// and the server relies on its built-in HTTP mirrors only. No absolute paths are
// hard-coded — we probe a candidate list (env override first).
// Probe is FIRE-AND-FORGET (async) so it never blocks server startup: akshare
// import can take ~15-20s on a cold machine, and blocking on it would stall the
// server. The fallback activates automatically once the probe resolves; until then
// calls simply use the built-in HTTP mirrors (which work without Python).
let AKSHARE_PY = null;
let AKSHARE_PROBING = true;
function detectAkshare() {
  const candidates = [
    process.env.AKSHARE_PYTHON,
    'python3', 'python',
    'C:/ProgramData/anaconda3/python.exe',     // common Windows anaconda (no username, public path)
    'C:/ProgramData/miniconda3/python.exe',
    '/opt/anaconda3/bin/python', '/opt/miniconda3/bin/python',
    '/usr/bin/python3',
  ].filter(Boolean);
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) {
      AKSHARE_PROBING = false;
      log('akshare NOT available — akshare/baostock fallback disabled, HTTP mirrors only');
      return;
    }
    const py = candidates[i++];
    let cp;
    try {
      cp = spawn(py, ['-c', 'import akshare; print("ok")'], { encoding: 'utf-8' });
    } catch { tryNext(); return; }
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('error', () => tryNext());
    cp.on('close', (code) => {
      log('probe candidate ' + py + ' close code=' + code + ' out=' + JSON.stringify(out.slice(0, 30)));
      if (code === 0 && /ok/.test(out)) {
        AKSHARE_PY = py; AKSHARE_PROBING = false;
        log('akshare fallback ENABLED via ' + py);
      } else {
        tryNext();
      }
    });
  };
  tryNext();
}
// Spawn the bridge script once per call; the bridge reads one JSON line from
// stdin and writes one JSON line to stdout. Returns the parsed object, or
// { __error__: ... } on any failure (so fetchFirstOk falls through).
function runAkshare(method, params) {
  if (!AKSHARE_PY) return { __error__: 'akshare not enabled' };
  const helper = process.env.AKSHARE_HELPER || path.join(__dirname, 'akshare_bridge.py');
  let p;
  try {
    p = spawnSync(AKSHARE_PY, [helper], {
      input: JSON.stringify({ method, params }) + '\n',
      encoding: 'utf-8', timeout: 90000, maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) { return { __error__: String(e) }; }
  if (p.status !== 0 || !p.stdout || !p.stdout.trim()) {
    return { __error__: (p.stderr || '').slice(0, 300) || ('akshare exit ' + p.status) };
  }
  try {
    const line = p.stdout.trim().split('\n').pop();
    return JSON.parse(line);
  } catch { return { __error__: 'bad akshare output' }; }
}

// Probe for a usable Python (with akshare) so the optional akshare/baostock
// fallback can be enabled. Fire-and-forget (async) so it never blocks startup;
// the fallback activates automatically once the probe resolves.
detectAkshare();

// ---------- tools (A-share example; swap for your own) ----------

// 1. A-share daily OHLCV. Failover: East Money push2his (primary, has amount)
//    -> Tencent proxy.finance.qq.com fqkline (fallback, verified reachable even
//    where push2*.eastmoney.com is blocked). Key-free.
async function aShareDaily({ symbol, start, end, adjust }) {
  const { mkt, code } = parseSymbol(symbol);
  const secid = `${mkt}.${code}`;
  const fqt = adjust === 'hfq' ? 2 : adjust === 'raw' ? 0 : 1; // qfq default
  const qfqFlag = adjust === 'hfq' ? 'hfq' : adjust === 'raw' ? '' : 'qfq';
  const qsym = (mkt === 1 ? 'sh' : 'sz') + code;
  const beg = ymd(start) || '20200101';
  const en = ymd(end) || '20300101';
  // Tencent fqkline takes a bar COUNT (not a date range) and returns bars ending
  // at the latest trade date. So size the count to span [beg, today], then filter
  // to [beg, en]. Cap at 2000 (~8y of dailies) — primary East Money covers full history.
  const a = new Date(beg.slice(0,4)+'-'+beg.slice(4,6)+'-'+beg.slice(6,8));
  const today = new Date();
  // Tencent fqkline returns bars ending at the latest trade date, so size the
  // count from `start` up to `today` (not to `end`), then filter down to [beg,en].
  const days = Math.max(1, Math.round((today - a) / 86400000));
  const count = Math.min(2000, Math.max(5, Math.ceil(days * 252 / 365) + 15));

  const res = await fetchFirstOk([
    {
      name: 'eastmoney',
      url: `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
           `&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=${fqt}&beg=${beg}&end=${en}`,
      parse: (t) => {
        const j = JSON.parse(t); const d = j?.data;
        if (!d || !d.klines) return null;
        return { name: d.name, code: d.code, rows: d.klines.map((line) => {
          const p = line.split(',');
          return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
                   volume: +p[5], amount: +p[6], amplitude: +p[7] };
        }) };
      },
    },
    {
      name: 'tencent',
      url: `https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get?param=${qsym},day,,,${count},${qfqFlag}`,
      parse: (t) => {
        const j = JSON.parse(t); const node = j?.data?.[qsym];
        const key = qfqFlag ? qfqFlag + 'day' : 'day';
        const arr = node?.[key];
        if (!arr || !arr.length) return null;
        return { name: node?.qt?.[qsym]?.[1] || code, code, rows: arr.map((p) => ({
          date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
          volume: +p[5], amount: null, amplitude: null,
        })) };
      },
    },
    {
      // optional local akshare/baostock (enabled only if a Python with akshare is detected)
      name: 'akshare',
      fn: async () => {
        const raw = await runAkshare('daily', { code, start: beg, end: en, fqt });
        if (!raw || raw.__error__) throw new Error((raw && raw.__error__) || 'empty');
        return { name: raw.name, code: raw.code, rows: raw.rows };
      },
    },
  ]);
  const rows = res.value.rows.filter((r) => r.date.replace(/-/g, '') >= beg && r.date.replace(/-/g, '') <= en);
  return { name: res.value.name, code: res.value.code, symbol: secid,
           adjust: fqt === 1 ? 'qfq' : fqt === 2 ? 'hfq' : 'raw',
           source: res.source, count: rows.length, data: rows };
}

// 2. Realtime snapshot for one stock (Tencent qt.gtimg.cn, GBK). Key-free.
async function quoteSnapshot({ symbol }) {
  const { mkt, code } = parseSymbol(symbol);
  const qsym = (mkt === 1 ? 'sh' : 'sz') + code;
  const url = `https://qt.gtimg.cn/q=${qsym}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const ab = await r.arrayBuffer();
  let txt;
  try { txt = new TextDecoder('gbk').decode(ab); } catch { txt = new TextDecoder('utf-8').decode(ab); }
  const m = txt.match(/v_\w+="([^"]*)"/);
  if (!m) throw new Error('No snapshot for ' + qsym);
  const p = m[1].split('~');
  return {
    code: p[2], name: p[1],
    price: p[3] ? +p[3] : null,
    prevClose: p[4] ? +p[4] : null,
    open: p[5] ? +p[5] : null,
    high: p[33] ? +p[33] : null,
    low: p[34] ? +p[34] : null,
    changeAmount: p[31] ? +p[31] : null,
    changePercent: p[32] ? +p[32] : null,
    volume: p[6] ? +p[6] : null,
    time: p[30] || null,
  };
}

// 3. Batch realtime snapshot (Tencent). Key-free.
async function quoteBatch({ symbols }) {
  const arr = String(symbols || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 50).map(s => {
    const { mkt, code } = parseSymbol(s);
    return (mkt === 1 ? 'sh' : 'sz') + code;
  });
  if (!arr.length) throw new Error('No symbols provided');
  const url = `https://qt.gtimg.cn/q=${arr.join(',')}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const ab = await r.arrayBuffer();
  let txt;
  try { txt = new TextDecoder('gbk').decode(ab); } catch { txt = new TextDecoder('utf-8').decode(ab); }
  const out = [];
  const re = /v_(\w+)="([^"]*)"/g; let m;
  while ((m = re.exec(txt))) {
    const p = m[2].split('~');
    out.push({
      code: p[2] || null, name: p[1] || null,
      price: p[3] ? +p[3] : null,
      prevClose: p[4] ? +p[4] : null,
      open: p[5] ? +p[5] : null,
      high: p[33] ? +p[33] : null,
      low: p[34] ? +p[34] : null,
      changePercent: p[32] ? +p[32] : null,
      time: p[30] || null,
    });
  }
  if (!out.length) throw new Error('No snapshot for ' + arr.join(','));
  return { count: out.length, data: out };
}

// 4. Main financial indicators. Failover: East Money datacenter (primary)
//    -> local akshare (fallback, if a Python with akshare is detected). Key-free.
async function financials({ symbol, periods }) {
  const { code } = parseSymbol(symbol);
  const n = Math.min(Math.max(parseInt(periods) || 4, 1), 12);
  const filter = emFilter(`(SECURITY_CODE="${code}")`);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD` +
    `&columns=ALL&filter=${filter}&pageSize=${n}&sortColumns=REPORTDATE&sortTypes=-1&client=PC`;
  const res = await fetchFirstOk([
    {
      name: 'eastmoney',
      url,
      parse: (t) => {
        const j = JSON.parse(t);
        const rows = j?.result?.data || [];
        if (!rows.length) return null;
        return { code, name: rows[0].SECURITY_NAME_ABBR, count: rows.length,
          data: rows.map(d => ({
            reportDate: (d.REPORTDATE || '').slice(0, 10),
            dataType: d.DATATYPE || d.QDATE || null,
            board: d.BOARD_NAME || null,
            eps: d.BASIC_EPS ?? null,
            deductEps: d.DEDUCT_BASIC_EPS ?? null,
            totalIncomeYi: yi(d.TOTAL_OPERATE_INCOME),
            parentNetProfitYi: yi(d.PARENT_NETPROFIT),
            roe: d.WEIGHTAVG_ROE ?? null,
            incomeYoy: d.YSTZ ?? null,
            profitYoy: d.SJLTZ ?? null,
            bps: d.BPS ?? null,
            mgOperatingCashFlow: d.MGJYXJJE ?? null,
            grossMargin: d.XSMLL ?? null,
          })) };
      },
    },
    {
      name: 'akshare',
      fn: async () => {
        const raw = await runAkshare('financials', { code, periods: n });
        if (!raw || raw.__error__) throw new Error((raw && raw.__error__) || 'empty');
        // raw = { code, count, data:[{reportDate, roe, eps, incomeYoy, profitYoy, grossMargin}] }
        return { code: raw.code, name: raw.code, count: raw.count,
          data: raw.data.map(d => ({
            reportDate: d.reportDate, dataType: null, board: null,
            eps: d.eps, deductEps: null,
            totalIncomeYi: null, parentNetProfitYi: null,
            roe: d.roe, incomeYoy: d.incomeYoy, profitYoy: d.profitYoy,
            bps: null, mgOperatingCashFlow: null, grossMargin: d.grossMargin,
          })) };
      },
    },
  ]);
  return res.value;
}

// 5. Northbound (沪深港通) capital-flow snapshot (East Money kamt). Key-free.
// 5. Northbound (沪深港通) capital-flow snapshot. Failover: East Money kamt
//    (primary) -> local akshare (fallback, if a Python with akshare is detected). Key-free.
async function northbound() {
  const url = `https://push2.eastmoney.com/api/qt/kamt/get?fields1=f1,f3` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65&ut=fa5fd1943c7b386f172d6893dbfba10b`;
  const res = await fetchFirstOk([
    {
      name: 'eastmoney',
      url,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      parse: (t) => {
        const j = JSON.parse(t); const d = j?.data;
        if (!d) return null;
        const ch = (o) => o ? {
          date: o.date2 || o.date || null,
          status: o.status ?? null,
          dayNetAmtInYi: yi(o.dayNetAmtIn),
          dayAmtRemainYi: yi(o.dayAmtRemain),
          monthNetAmtInYi: yi(o.monthNetAmtIn),
          yearNetAmtInYi: yi(o.yearNetAmtIn),
          allNetAmtInYi: yi(o.allNetAmtIn),
          updateTime: o.updateTime ?? null,
        } : null;
        const sh = ch(d.hk2sh), sz = ch(d.hk2sz);
        const totalAll = (sh?.allNetAmtInYi ?? 0) + (sz?.allNetAmtInYi ?? 0);
        return { hk2sh: sh, hk2sz: sz, totalAllNetAmtInYi: +totalAll.toFixed(2),
          note: 'dayNetAmtIn may be 0 when market closed; allNetAmtIn = cumulative net buy since Stock Connect launch (亿元).' };
      },
    },
    {
      name: 'akshare',
      fn: async () => {
        const raw = await runAkshare('northbound', {});
        if (!raw || raw.__error__) throw new Error((raw && raw.__error__) || 'empty');
        return { hk2sh: null, hk2sz: null,
          totalAllNetAmtInYi: raw.totalAllNetAmtInYi != null ? +(+raw.totalAllNetAmtInYi).toFixed(2) : null,
          note: (raw.note || 'northbound via akshare') };
      },
    },
  ]);
  return res.value;
}

// 6. Sector/industry/concept/region board list. Failover: East Money clist m:90
//    (primary) -> local akshare (fallback, if a Python with akshare is detected). Key-free.
async function sectors({ type, count }) {
  const tmap = { industry: 't:2', concept: 't:3', region: 't:1' };
  const fs = 'm:90+' + (tmap[type] || 't:2');
  const n = Math.min(Math.max(parseInt(count) || 50, 1), 200);
  const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${n}&po=1&np=1&fltt=2&invt=2` +
    `&fs=${fs}&fields=f12,f14,f2,f3,f62,f184`;
  const res = await fetchFirstOk([
    {
      name: 'eastmoney',
      url,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' },
      parse: (t) => {
        const j = JSON.parse(t); const diff = j?.data?.diff || [];
        if (!diff.length) return null;
        return { type: type || 'industry', count: diff.length,
          data: diff.map(x => ({
            code: x.f12, name: x.f14, index: x.f2 ?? null,
            changePercent: x.f3 ?? null, mainNetInflowYi: yi(x.f62), turnoverRate: x.f184 ?? null,
          })) };
      },
    },
    {
      name: 'akshare',
      fn: async () => {
        const raw = await runAkshare('sectors', { type: type || 'industry' });
        if (!raw || raw.__error__) throw new Error((raw && raw.__error__) || 'empty');
        return { type: raw.type || type || 'industry', count: raw.count,
          data: raw.data.map(x => ({
            code: x.code, name: x.name, index: null,
            changePercent: x.changePercent, mainNetInflowYi: x.mainNetInflowYi, turnoverRate: null,
          })) };
      },
    },
  ]);
  return res.value;
}

// ---------- tool schemas (edit to match your tools) ----------
const TOOLS = [
  {
    name: 'a_share_daily',
    description: 'Fetch A-share daily OHLCV kline (no API key). Multi-source failover: East Money push2his (primary, has amount) -> Tencent proxy.finance.qq.com fqkline (fallback for networks where push2*.eastmoney.com is blocked) -> local akshare/baostock (if a Python with akshare is detected at startup). Returns name/code/date/open/close/high/low/volume/amount(=null on Tencent/akshare fallback)/amplitude(=null on fallback). `source` field in result shows which host answered.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: "6-digit code, e.g. '600000' or 'sh600000' / 'sz000001'. sh=SSE, sz=SZSE." },
        start: { type: 'string', description: 'Start date YYYY-MM-DD (default 2020-01-01).' },
        end: { type: 'string', description: 'End date YYYY-MM-DD (default 2030-01-01).' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'raw'], description: 'qfq=forward-adjusted (default), hfq=back-adjusted, raw=unadjusted.' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'quote_snapshot',
    description: 'Realtime snapshot quote for an A-share (no API key). Source: Tencent qt.gtimg.cn. Returns name/price/prevClose/open/high/low/changePercent/time.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: "6-digit code, e.g. '600000' or 'sh600000'." },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'quote_batch',
    description: 'Batch realtime snapshot quotes for multiple A-shares in one call (no API key). Source: Tencent qt.gtimg.cn. Accepts comma/space separated codes. Returns array of name/price/changePercent/time.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'string', description: "Comma or space separated 6-digit codes or sh/sz prefixes, e.g. '600000,000001,sz300750'. Max 50." },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'financials',
    description: 'Main financial indicators for an A-share across recent report periods (no API key). Multi-source failover: East Money datacenter RPT_LICO_FN_CPD (primary) -> local akshare (fallback, if detected). Returns per-period: reportDate, dataType, board, eps, deductEps, totalIncomeYi(亿元), parentNetProfitYi(亿元), roe, incomeYoy, profitYoy, bps, grossMargin.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: "6-digit code, e.g. '600000' or 'sh600000'." },
        periods: { type: 'number', description: 'Number of most recent report periods to return (1-12, default 4).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'northbound',
    description: 'Northbound (沪深港通) capital flow snapshot (no API key). Multi-source failover: East Money push2 kamt (primary) -> local akshare (fallback, if detected). Returns per-channel (hk2sh/hk2sz) day/month/year/cumulative net buy (亿元) and totalAllNetAmtInYi.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'sectors',
    description: 'A-share sector/industry/concept/region board list with change % and main-force net inflow (no API key). Multi-source failover: East Money push2 clist (m:90, primary) -> local akshare (fallback, if detected). Returns code/name/index/changePercent/mainNetInflowYi(亿元)/turnoverRate.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['industry', 'concept', 'region'], description: 'industry=行业板块 (default), concept=概念板块, region=地域板块.' },
        count: { type: 'number', description: 'Number of boards to return (1-200, default 50).' },
      },
    },
  },
];

// keep the process alive (stdin stays open for the host to drive it)
setInterval(() => {}, 1 << 30);
