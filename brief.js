'use strict';

// ─── Market Sessions ──────────────────────────────────────────────────────────
// All times in local exchange time; we check UTC offsets per day
const EXCHANGES = [
  { id: 'NYSE',    name: 'NYSE/NASDAQ', tz: 'America/New_York',    open: [9,30],  close: [16,0],  icon: '🇺🇸', color: '#00d4ff' },
  { id: 'SGX',     name: 'SGX',          tz: 'Asia/Singapore',      open: [9,0],   close: [17,30], icon: '🇸🇬', color: '#ff9500' },
  { id: 'LSE',     name: 'LSE',          tz: 'Europe/London',       open: [8,0],   close: [16,30], icon: '🇬🇧', color: '#aa88ff' },
  { id: 'TSE',     name: 'Nikkei/TSE',   tz: 'Asia/Tokyo',          open: [9,0],   close: [15,30], icon: '🇯🇵', color: '#ff6b6b' },
  { id: 'HKEX',   name: 'HKEX',          tz: 'Asia/Hong_Kong',     open: [9,30],  close: [16,0],  icon: '🇭🇰', color: '#ffd700' },
  { id: 'ASX',     name: 'ASX',          tz: 'Australia/Sydney',    open: [10,0],  close: [16,0],  icon: '🇦🇺', color: '#00e676' },
  { id: 'EURONEXT',name: 'Euronext/DAX', tz: 'Europe/Paris',        open: [9,0],   close: [17,30], icon: '🇪🇺', color: '#aa88ff' },
  { id: 'CRYPTO',  name: 'Crypto',       tz: 'UTC',                 open: [0,0],   close: [24,0],  icon: '₿',   color: '#ffd700', always: true },
  { id: 'FOREX',   name: 'FX',           tz: 'UTC',                 open: [0,0],   close: [24,0],  icon: '💱',  color: '#00e676', forexClosed: true },
];

function isWeekend(dateInTz) {
  const day = dateInTz.getDay();
  return day === 0 || day === 6;
}

function getExchangeLocalTime(now, tz) {
  // Use Intl to get local time in exchange timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false, weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const get = t => parseInt(parts.find(p => p.type === t)?.value || '0');
  const weekday = parts.find(p => p.type === 'weekday')?.value;
  return {
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
    weekday,
    isWeekend: weekday === 'Sun' || weekday === 'Sat',
  };
}

function getMarketStatus(ex, now) {
  if (ex.always) return { open: true, label: '24/7' };
  if (ex.forexClosed) {
    const utcDay = now.getUTCDay();
    const utcHour = now.getUTCHours();
    // Forex closes Fri 17:00 ET = 22:00 UTC, opens Sun 17:00 ET = 22:00 UTC
    const closedPeriod = (utcDay === 6) || (utcDay === 5 && utcHour >= 22) || (utcDay === 0 && utcHour < 22);
    return { open: !closedPeriod, label: closedPeriod ? 'Weekend Close' : '24h FX' };
  }
  const local = getExchangeLocalTime(now, ex.tz);
  if (local.isWeekend) return { open: false, label: 'Weekend' };
  const mins = local.hour * 60 + local.minute;
  const openMins  = ex.open[0]  * 60 + ex.open[1];
  const closeMins = ex.close[0] * 60 + ex.close[1];
  const open = mins >= openMins && mins < closeMins;
  let label = open ? 'Open' : (mins < openMins ? 'Pre-Market' : 'Closed');
  // Pre-market window (within 90 min before open)
  const preMarket = !open && mins >= openMins - 90 && mins < openMins;
  if (preMarket) label = 'Pre-Market';
  return { open, preMarket, label };
}

function getSessionContext(now) {
  const utcH = now.getUTCHours();
  const utcDay = now.getUTCDay();
  const isWknd = utcDay === 0 || utcDay === 6;

  if (isWknd) return { name: 'Weekend', emoji: '🌙', desc: 'Markets closed · Crypto & FX active · Plan your week' };

  // UTC offsets for key sessions (approximate)
  if (utcH >= 22 || utcH < 3)  return { name: 'Sydney / Tokyo Open',   emoji: '🌏', desc: 'Asia-Pacific session opening · SGX pre-market soon' };
  if (utcH >= 1  && utcH < 9)  return { name: 'Asia Session',           emoji: '🌏', desc: 'SGX · HKEX · TSE active · European pre-market building' };
  if (utcH >= 7  && utcH < 9)  return { name: 'European Pre-Market',    emoji: '🌍', desc: 'LSE & Euronext opening · US futures watch' };
  if (utcH >= 8  && utcH < 13) return { name: 'European Session',       emoji: '🌍', desc: 'LSE · Euronext · DAX active · US market opening soon' };
  if (utcH >= 13 && utcH < 14) return { name: 'US Pre-Market / London', emoji: '⚡', desc: 'High volatility window · US futures + Europe overlap' };
  if (utcH >= 14 && utcH < 20) return { name: 'US Session 🔥',          emoji: '🔥', desc: 'NYSE · NASDAQ live · Peak liquidity window' };
  if (utcH >= 20 && utcH < 21) return { name: 'US Market Close',        emoji: '🔔', desc: 'Final hour volatility · Watch for MOC orders' };
  if (utcH >= 21 && utcH < 22) return { name: 'US After-Hours',         emoji: '🌆', desc: 'AH earnings reaction · Lower liquidity' };
  return { name: 'Inter-Session',  emoji: '🌙', desc: 'Quiet period · Review positions · Plan next move' };
}

// ─── Play Generation ──────────────────────────────────────────────────────────
const SIGNAL_PLAYS = {
  'earnings':           { dir: 'LONG',  upMin: 5,  upMax: 12, stars: 5, tag: 'EARNINGS BEAT', note: 'Gap-open pullback entry. Wait for first 15-min candle.' },
  'eps beat':           { dir: 'LONG',  upMin: 4,  upMax: 10, stars: 5, tag: 'EPS BEAT',      note: 'Buy dip to VWAP post-open gap.' },
  'beats estimates':    { dir: 'LONG',  upMin: 4,  upMax: 9,  stars: 5, tag: 'BEAT ESTIMATE', note: 'Momentum entry on confirmation.' },
  'guidance raised':    { dir: 'LONG',  upMin: 5,  upMax: 12, stars: 5, tag: 'GUIDANCE ▲',    note: 'Strongest fundamental signal. Add on first dip.' },
  'upgrade':            { dir: 'LONG',  upMin: 3,  upMax: 7,  stars: 4, tag: 'ANALYST UPGRADE',note: 'Buy at open. Upgrades hold for 2–5 days.' },
  'price target':       { dir: 'LONG',  upMin: 2,  upMax: 6,  stars: 4, tag: 'PT RAISED',     note: 'Confirm direction with volume.' },
  'all-time high':      { dir: 'LONG',  upMin: 2,  upMax: 5,  stars: 4, tag: 'ATH BREAKOUT',  note: 'ATH = no overhead resistance. Ride momentum.' },
  'breakout':           { dir: 'LONG',  upMin: 3,  upMax: 7,  stars: 4, tag: 'BREAKOUT',      note: 'Enter on volume confirmation above key level.' },
  'short squeeze':      { dir: 'LONG',  upMin: 10, upMax: 30, stars: 5, tag: '⚡ SHORT SQUEEZE',note: 'High risk/reward. Size down. Fast moves.' },
  'insider buying':     { dir: 'LONG',  upMin: 3,  upMax: 8,  stars: 5, tag: '🔍 INSIDER BUY', note: 'CEO/Director open-market buy = highest conviction signal.' },
  'merger':             { dir: 'LONG',  upMin: 15, upMax: 40, stars: 5, tag: 'M&A',           note: 'Risk-arb: buy target, short acquirer.' },
  'acquisition':        { dir: 'LONG',  upMin: 15, upMax: 40, stars: 5, tag: 'ACQUISITION',   note: 'Immediate spike to deal price. Buy at discount to bid.' },
  'deal':               { dir: 'LONG',  upMin: 4,  upMax: 12, stars: 4, tag: 'MAJOR DEAL',    note: 'Revenue visibility catalyst.' },
  'buyback':            { dir: 'LONG',  upMin: 2,  upMax: 6,  stars: 3, tag: 'BUYBACK',       note: 'Slow burn upside. Good for options.' },
  'dividend':           { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'DIVIDEND',      note: 'Yield support. Defensive hold.' },
  'misses estimates':   { dir: 'SHORT', upMin: 4,  upMax: 10, stars: 4, tag: '🔴 MISS',        note: 'Sell the gap-up open if any. Target support.' },
  'guidance lowered':   { dir: 'SHORT', upMin: 6,  upMax: 15, stars: 5, tag: '🔴 GUIDE DOWN',  note: 'Strongest short signal. Multi-day downtrend.' },
  'downgrade':          { dir: 'SHORT', upMin: 3,  upMax: 7,  stars: 4, tag: '🔴 DOWNGRADE',   note: 'Sell rallies. Cascading downgrades often follow.' },
  'insider selling':    { dir: 'SHORT', upMin: 2,  upMax: 5,  stars: 3, tag: '🔴 INSIDER SELL',note: 'Caution — could be routine. Check Form 4 size.' },
  'secondary offering': { dir: 'SHORT', upMin: 5,  upMax: 10, stars: 4, tag: '🔴 DILUTION',    note: 'Priced at discount = forced selling pressure.' },
  'short interest':     { dir: 'SHORT', upMin: 3,  upMax: 8,  stars: 3, tag: '🔴 HIGH SHORT',  note: 'Either squeeze setup OR crowd is right. Read macro.' },
  'opec':               { dir: 'SHORT', upMin: 2,  upMax: 5,  stars: 4, tag: 'OPEC SUPPLY',   note: 'Output hike = bearish crude. Short WTI/XOM/CVX.' },
  'rate cut':           { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'RATE CUT',      note: 'Broad lift: growth stocks, gold, crypto benefit.' },
  'rate hike':          { dir: 'SHORT', upMin: 1,  upMax: 3,  stars: 3, tag: 'RATE HIKE',     note: 'Pressure on growth/tech. Banks may benefit.' },
  'cpi':                { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'CPI COOL',      note: 'Dovish pivot narrative strengthens. Risk-on.' },
  'jobs report':        { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'JOBS DATA',     note: 'Strong jobs = soft landing. Equities + crypto bid.' },
  'nonfarm payroll':    { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'NFP',           note: 'Watch wage growth — if cool, even more bullish.' },
  'gdp':                { dir: 'LONG',  upMin: 1,  upMax: 2,  stars: 2, tag: 'GDP',           note: 'Revision up = economic resilience confirmed.' },
  'resistance':         { dir: 'LONG',  upMin: 2,  upMax: 5,  stars: 4, tag: 'RESISTANCE BREAK', note: 'Clean level cleared = next resistance becomes target.' },
  'support':            { dir: 'LONG',  upMin: 1,  upMax: 4,  stars: 3, tag: 'SUPPORT HOLD',  note: 'Bouncing off key level = risk defined entry.' },
  'ipo':                { dir: 'LONG',  upMin: 5,  upMax: 20, stars: 3, tag: 'IPO',           note: 'First day pop possible. Size small. Wide spreads.' },
};

const PRIORITY_SIGNALS = ['guidance raised','earnings','eps beat','beats estimates','short squeeze','merger','acquisition','insider buying','guidance lowered','all-time high','breakout','upgrade'];

// Populated by setTickerDB()
let _tickerDB = {};
function setTickerDB(db) { _tickerDB = db; }

// Keyword → canonical ticker mapping for title-based extraction
const TITLE_TICKER_MAP = {
  'bitcoin': 'BTC', 'btc': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL',
  'ripple': 'XRP', 'xrp': 'XRP', 'dogecoin': 'DOGE', 'binance': 'BNB',
  'gold': 'GOLD', 'silver': 'SILVER', 'crude oil': 'OIL', 'wti': 'OIL',
  'brent': 'BRENT', 'natural gas': 'NATGAS', 'copper': 'COPPER',
  's&p 500': 'SPX', 'sp500': 'SPX', 'nasdaq': 'NDX', 'dow jones': 'DJI',
  'vix': 'VIX', 'nikkei': 'N225', 'hang seng': 'HSI', 'dax': 'DAX',
  'eur/usd': 'EURUSD', 'eurusd': 'EURUSD', 'usd/jpy': 'USDJPY',
  'gbp/usd': 'GBPUSD', 'aud/usd': 'AUDUSD', 'dollar index': 'DXY',
  'dxy': 'DXY', 'dollar index': 'DXY',
  'nvidia': 'NVDA', 'apple': 'AAPL', 'microsoft': 'MSFT', 'tesla': 'TSLA',
  'amazon': 'AMZN', 'meta': 'META', 'google': 'GOOGL', 'alphabet': 'GOOGL',
  'amd': 'AMD', 'intel': 'INTC', 'palantir': 'PLTR', 'coinbase': 'COIN',
  'goldman sachs': 'GS', 'jpmorgan': 'JPM', 'boeing': 'BA', 'rivian': 'RIVN',
  'eli lilly': 'LLY', 'moderna': 'MRNA', 'pfizer': 'PFE',
  'dbs bank': 'D05', 'singapore airlines': 'C6L', 'singtel': 'Z74',
  'opec': 'OIL',
};

function extractTickerFromArticle(article) {
  // 1. Prefer watchlist-matched tickers
  if (article.matches && article.matches.length > 0) {
    return article.matches.map(m => m.ticker);
  }

  const titleLow = (article.title || '').toLowerCase();
  const summLow  = (article.summary || '').toLowerCase();
  const combined = titleLow + ' ' + summLow;

  // 2. Keyword lookup in title/summary
  const found = [];
  for (const [kw, sym] of Object.entries(TITLE_TICKER_MAP)) {
    if (combined.includes(kw) && !found.includes(sym)) found.push(sym);
  }
  if (found.length) return found.slice(0, 3);

  // 3. Look for $TICKER pattern
  const dollarMatch = article.title.match(/\$([A-Z]{2,5})\b/g);
  if (dollarMatch) {
    const valid = dollarMatch.map(m => m.slice(1)).filter(t => _tickerDB[t]);
    if (valid.length) return valid.slice(0, 2);
  }

  // 4. Validated uppercase words (2-5 chars) against ticker DB
  const upperMatch = article.title.match(/\b([A-Z]{2,5})\b/g) || [];
  const dbMatch = upperMatch.filter(t => _tickerDB[t]);
  if (dbMatch.length) return dbMatch.slice(0, 2);

  return ['MKT'];
}

module.exports.setTickerDB = setTickerDB;

function getSentimentFromTitle(title) {
  const t = title.toLowerCase();
  const bearWords = ['falls','drops','tumbles','slides','sinks','miss','misses','warning','cut','lose','loss','plunges','slumps','declines'];
  const bullWords = ['surges','rises','jumps','rallies','beats','record','gains','upgrades','higher','tops','breaks','hits'];
  let bull = bullWords.filter(w => t.includes(w)).length;
  let bear = bearWords.filter(w => t.includes(w)).length;
  return bull > bear ? 'bull' : bear > bull ? 'bear' : 'neutral';
}

function generatePlay(article) {
  const signals = article.swingSignals || [];
  if (!signals.length) return null;

  // Find the highest-priority signal
  let bestSignal = null;
  let bestPlay = null;
  for (const sig of PRIORITY_SIGNALS) {
    if (signals.includes(sig) && SIGNAL_PLAYS[sig]) {
      bestSignal = sig;
      bestPlay = SIGNAL_PLAYS[sig];
      break;
    }
  }
  if (!bestPlay) {
    // Fall back to first matched signal
    for (const sig of signals) {
      if (SIGNAL_PLAYS[sig]) { bestSignal = sig; bestPlay = SIGNAL_PLAYS[sig]; break; }
    }
  }
  if (!bestPlay) return null;

  // Override direction based on title sentiment
  const sentiment = getSentimentFromTitle(article.title);
  let dir = bestPlay.dir;
  if (sentiment === 'bear' && dir === 'LONG') dir = 'SHORT';
  if (sentiment === 'bull' && dir === 'SHORT') dir = 'LONG';

  // Adjust upside based on signal count (more signals = stronger move)
  const sigBoost = Math.min(signals.length - 1, 3) * 1.5;
  const upMin = (bestPlay.upMin + sigBoost).toFixed(1);
  const upMax = (bestPlay.upMax + sigBoost * 1.5).toFixed(1);

  // Stars based on signal count + quality
  const stars = Math.min(5, bestPlay.stars + (signals.length > 2 ? 1 : 0));

  const tickers = extractTickerFromArticle(article);

  return {
    ticker:    tickers[0] || '—',
    allTickers: tickers,
    direction: dir,
    tag:       bestPlay.tag,
    note:      bestPlay.note,
    upMin,
    upMax,
    stars,
    signal:    bestSignal,
    signals,
    title:     article.title,
    summary:   article.summary,
    source:    article.source,
    publishedAt: article.publishedAt,
    articleUrl: article.url,
    matchType: article.matchType,
  };
}

function generateBrief(articles, tz) {
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 3600 * 1000);

  // Recent articles, newest first
  const recent = articles
    .filter(a => new Date(a.publishedAt) >= cutoff24h)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  // Market status
  const marketStatus = EXCHANGES.map(ex => ({
    ...ex,
    status: getMarketStatus(ex, now),
  }));

  // Session context
  const session = getSessionContext(now);

  // Extract macro articles
  const macroSignals = ['cpi', 'rate cut', 'rate hike', 'jobs report', 'nonfarm payroll', 'gdp', 'federal reserve', 'interest rate'];
  const macroArticles = recent.filter(a =>
    (a.swingSignals || []).some(s => macroSignals.includes(s))
  ).slice(0, 4);

  // Generate plays from swing articles
  const swingArticles = recent.filter(a => a.isSwingRelevant);
  const rawPlays = swingArticles
    .map(a => generatePlay(a))
    .filter(Boolean);

  // Deduplicate by ticker (keep highest stars)
  const playMap = {};
  for (const p of rawPlays) {
    const key = p.ticker;
    if (!playMap[key] || p.stars > playMap[key].stars) playMap[key] = p;
  }
  const allPlays = Object.values(playMap).sort((a, b) => b.stars - a.stars || b.upMax - a.upMax);

  const longs  = allPlays.filter(p => p.direction === 'LONG').slice(0, 7);
  const shorts = allPlays.filter(p => p.direction === 'SHORT').slice(0, 4);

  // Macro backdrop summary
  const macroKeyPoints = macroArticles.map(a => ({
    title:   a.title,
    source:  a.source,
    signals: a.swingSignals,
    publishedAt: a.publishedAt,
  }));

  return {
    generatedAt:  now.toISOString(),
    timezone:     tz,
    session,
    marketStatus,
    macroBackdrop: macroKeyPoints,
    longs,
    shorts,
    articleCount:  recent.length,
    totalArticles: articles.length,
    nextRefresh:   new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

module.exports = { generateBrief, setTickerDB, EXCHANGES, getMarketStatus, getSessionContext };
