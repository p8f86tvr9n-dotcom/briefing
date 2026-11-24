#!/usr/bin/env node
/* Trading Desk background scanner.
   Runs the same rules as desk.html (it loads them straight out of that file), follows the paper trades,
   and writes the record to a JSON file. Run by .github/workflows/desk-scan.yml on a schedule.
   Usage: node desk-scan.js <path to desk-data.json> */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'desk.html'), 'utf8');
const a = html.indexOf('/*SHARED-START*/'), b = html.indexOf('/*SHARED-END*/');
if (a < 0 || b < 0) throw new Error('Shared code block not found in desk.html');
const { Engine, Feeds, Desk } = new Function(html.slice(a, b) + '\n;return {Engine:Engine, Feeds:Feeds, Desk:Desk};')();

const outPath = process.argv[2] || path.join(dir, 'desk-data.json');

function readJSON(p, mustParse) {
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { if (mustParse) throw new Error('Could not read ' + p + ': refusing to overwrite the record. ' + e.message); return null; }
}
function num(v, dflt, lo, hi) { v = Number(v); return isFinite(v) && v >= lo && v <= hi ? v : dflt; }

const KEEP_RESULT = ['status', 'note', 'setup', 'score', 'strength', 'entry', 'stop', 'target', 'stopPct', 'tgtPct', 'netRR',
  'stake', 'lossGBP', 'gainGBP', 'overRisk', 'reasons', 'barTs', 'price', 'rsi', 'trend', 'ctxTrend', 'thin', 'bt'];

(async () => {
  const raw = readJSON(path.join(dir, 'desk-config.json'), false) || {};
  const cfg = {
    maxLoss: num(raw.maxLoss, 10, 1, 1000),
    minStake: num(raw.minStake, 50, 10, 100000),
    maxStake: num(raw.maxStake, 500, 10, 100000),
    feePct: num(raw.feePct, 0.4, 0, 5),
    coins: (Array.isArray(raw.coins) ? raw.coins : Desk.COINS).filter(c => Desk.COINS.includes(c)),
    modes: (Array.isArray(raw.modes) ? raw.modes : Desk.MODE_KEYS).filter(m => Desk.MODES[m])
  };
  if (cfg.maxStake < cfg.minStake) cfg.maxStake = cfg.minStake;
  if (!cfg.coins.length) cfg.coins = Desk.COINS;
  if (!cfg.modes.length) cfg.modes = Desk.MODE_KEYS;

  const prev = readJSON(outPath, true) || {};
  const st = {
    settings: { maxLoss: cfg.maxLoss, minStake: cfg.minStake, maxStake: cfg.maxStake, feePct: cfg.feePct },
    journal: { trades: Array.isArray(prev.trades) ? prev.trades : [], feed: Array.isArray(prev.feed) ? prev.feed : [] },
    results: {}, rowInfo: {}, btc: { h4: 'unknown', d1: 'unknown' }, btCache: {}, log: true
  };
  if (prev.sources && typeof prev.sources === 'object') Object.assign(Feeds.source, prev.sources);
  const tradesBefore = st.journal.trades.length, feedBefore = st.journal.feed.length;

  const now = Date.now();
  const gotAny = await Desk.scanAll(st, cfg.coins, cfg.modes);

  const out = {
    v: 1, checkedAt: now,
    updatedAt: gotAny ? now : (prev.updatedAt || 0),
    startedAt: prev.startedAt || now,
    scans: (prev.scans || 0) + (gotAny ? 1 : 0),
    config: cfg
  };
  if (gotAny) {
    out.btc = st.btc; out.sources = Object.assign({}, Feeds.source); out.coins = {};
    for (const c of cfg.coins) {
      const info = st.rowInfo[c] || {}, modes = {};
      for (const m of cfg.modes) {
        const r = (st.results[c] || {})[m]; if (!r) continue;
        const slim = {}; for (const k of KEEP_RESULT) if (r[k] !== undefined) slim[k] = r[k];
        modes[m] = slim;
      }
      out.coins[c] = { price: info.price, chg: info.chg, modes };
    }
  } else {
    out.btc = prev.btc || st.btc; out.sources = prev.sources || {}; out.coins = prev.coins || {};
    out.lastError = 'No price feed answered at ' + new Date(now).toISOString();
  }
  out.trades = st.journal.trades.slice(-500);
  out.feed = st.journal.feed.slice(-300);
  fs.writeFileSync(outPath, JSON.stringify(out));

  // Run log, readable in the Actions tab.
  const bySource = {}; for (const c of cfg.coins) if (st.rowInfo[c]) bySource[Feeds.source[c]] = (bySource[Feeds.source[c]] || 0) + 1;
  console.log('Feeds:', Feeds.PROVIDERS.map(p => { const h = Feeds.health[p.id]; return p.name + ' ok=' + h.ok + ' missing=' + h.missing + ' failed=' + h.fail + (h.lastStatus ? ' (last ' + h.lastStatus + ')' : ''); }).join(' | '));
  console.log('Coins with prices:', Object.entries(bySource).map(([k, v]) => k + ' ' + v).join(', ') || 'none');
  console.log('Backdrop: BTC 4h ' + st.btc.h4 + ', daily ' + st.btc.d1);
  const tally = {};
  for (const c of cfg.coins) for (const m of cfg.modes) { const r = (st.results[c] || {})[m]; if (r) tally[r.status] = (tally[r.status] || 0) + 1; }
  console.log('Statuses:', JSON.stringify(tally));
  for (const f of st.journal.feed.slice(feedBefore)) console.log('NEW ' + f.kind.toUpperCase() + ': ' + f.text);
  console.log('Record: ' + out.trades.length + ' trades (' + (st.journal.trades.length - tradesBefore) + ' new, ' + out.trades.filter(t => t.status === 'open').length + ' open), ' + out.feed.length + ' feed entries, scan #' + out.scans + '.');
  if (!gotAny) console.log('::warning::' + out.lastError + '. The saved record was left as it was.');
})().catch(e => { console.error(e); process.exit(1); });
