'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const Parser     = require('rss-parser');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');
const TICKER_DB  = require('./tickers');
const { SEED, nextDrip } = require('./seed_articles');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT          = process.env.PORT || 3000;
const POLL_INTERVAL = 2 * 60 * 1000; // 2 min
const MAX_ARTICLES  = 600;
const DATA_FILE     = path.join(__dirname, 'data.json');

// ─── RSS Feeds ────────────────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: 'https://finance.yahoo.com/rss/topstories',                          name: 'Yahoo Finance',   market: 'general'    },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',             name: 'CNBC',            market: 'general'    },
  { url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html',              name: 'CNBC Markets',    market: 'stocks'     },
  { url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html',              name: 'CNBC Earnings',   market: 'stocks'     },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',        name: 'MarketWatch',     market: 'general'    },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse',       name: 'MW Market Pulse', market: 'stocks'     },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                     name: 'WSJ Markets',     market: 'stocks'     },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                   name: 'CoinDesk',        market: 'crypto'     },
  { url: 'https://cointelegraph.com/rss',                                      name: 'CoinTelegraph',   market: 'crypto'     },
  { url: 'https://decrypt.co/feed',                                            name: 'Decrypt',         market: 'crypto'     },
  { url: 'https://www.theblock.co/rss.xml',                                   name: 'The Block',       market: 'crypto'     },
  { url: 'https://www.forexlive.com/feed/',                                    name: 'ForexLive',       market: 'forex'      },
  { url: 'https://www.fxstreet.com/rss/news',                                  name: 'FX Street',       market: 'forex'      },
  { url: 'https://www.nasdaq.com/feed/rssoutbound',                            name: 'Nasdaq',          market: 'stocks'     },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                     name: 'Reuters Business',market: 'general'    },
  { url: 'https://feeds.reuters.com/reuters/technologyNews',                   name: 'Reuters Tech',    market: 'stocks'     },
  { url: 'https://www.investing.com/rss/news.rss',                             name: 'Investing.com',   market: 'general'    },
  { url: 'https://www.investing.com/rss/news_25.rss',                          name: 'Investing Crypto',market: 'crypto'     },
  { url: 'https://www.investing.com/rss/news_14.rss',                          name: 'Investing Forex', market: 'forex'      },
  { url: 'https://www.investing.com/rss/news_8.rss',                           name: 'Investing Comm.', market: 'commodities'},
  { url: 'https://www.businesstimes.com.sg/rss/companies-markets',             name: 'Business Times',  market: 'stocks'     },
  { url: 'https://www.businesstimes.com.sg/rss/banking-finance',               name: 'BT Banking',      market: 'stocks'     },
];

// ─── State ────────────────────────────────────────────────────────────────────
let articles  = [];
let seenUrls  = new Set();
let watchlist = loadWatchlist();

function loadWatchlist() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(d.watchlist) ? d.watchlist : [];
  } catch { return []; }
}

function saveWatchlist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ watchlist }, null, 2));
}

// ─── Swing-trade signal keywords ─────────────────────────────────────────────
const SWING_SIGNALS = [
  'earnings', 'beats estimates', 'misses estimates', 'revenue beat', 'eps beat',
  'guidance raised', 'guidance lowered', 'upgrade', 'downgrade', 'price target',
  'rate cut', 'rate hike', 'interest rate', 'fed decision', 'central bank',
  'inflation data', 'cpi', 'jobs report', 'nonfarm payroll', 'gdp',
  'breakout', 'all-time high', 'record high', 'resistance', 'support',
  'short squeeze', 'short interest', 'insider buying', 'insider selling',
  'merger', 'acquisition', 'deal', 'buyout', 'ipo', 'secondary offering',
  'sec filing', '10-k', '10-q', '8-k',
  'dividend', 'buyback', 'share repurchase',
  'opec', 'production cut', 'supply cut',
];

function detectSwingSignal(text) {
  const lower = text.toLowerCase();
  return SWING_SIGNALS.filter(s => lower.includes(s));
}

// ─── Relevance Scoring ────────────────────────────────────────────────────────
function scoreArticle(article, ticker) {
  const db = TICKER_DB[ticker];
  if (!db) return null;

  const titleLower   = (article.title   || '').toLowerCase();
  const summaryLower = (article.summary || '').toLowerCase();

  let score = 0;
  let matchType = null;
  const matchedTerms = [];

  // Exact ticker symbol in title → highest confidence
  const symRe = new RegExp(`(?<![a-zA-Z])${ticker.replace('/', '\\/')}(?![a-zA-Z])`, 'i');
  if (symRe.test(article.title))   { score += 120; matchType = 'direct'; }
  else if (symRe.test(article.summary)) { score += 80; matchType = 'direct'; }

  // Company name in title
  const nameL = db.name.toLowerCase();
  if (titleLower.includes(nameL))   { score += 100; matchType = 'direct'; }
  else if (summaryLower.includes(nameL)) { score += 65; if (!matchType) matchType = 'direct'; }

  // Related keyword terms
  for (const term of db.terms) {
    if (titleLower.includes(term)) {
      score += 45;
      matchedTerms.push(term);
      if (!matchType) matchType = 'related';
    } else if (summaryLower.includes(term)) {
      score += 22;
      matchedTerms.push(term);
      if (!matchType) matchType = 'related';
    }
  }

  if (score < 22) return null;

  return {
    ticker,
    score,
    matchType,
    matchedTerms: [...new Set(matchedTerms)].slice(0, 3),
  };
}

function processArticle(raw) {
  const matches = [];
  for (const ticker of watchlist) {
    const m = scoreArticle(raw, ticker);
    if (m) matches.push(m);
  }

  // If watchlist is set but nothing matched, skip
  if (watchlist.length > 0 && matches.length === 0) return null;

  matches.sort((a, b) => b.score - a.score);

  const swingSignals = detectSwingSignal(`${raw.title} ${raw.summary}`);
  const matchType    = matches.some(m => m.matchType === 'direct') ? 'direct' : (matches.length ? 'related' : 'general');
  const topScore     = matches[0]?.score ?? 0;

  return {
    ...raw,
    matches,
    matchType,
    relevanceScore: topScore,
    swingSignals,
    isSwingRelevant: swingSignals.length > 0,
  };
}

// ─── RSS Polling ──────────────────────────────────────────────────────────────
const parser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'MarketPulse/1.0 (swing-trading-news-aggregator)' },
  customFields: { item: [['media:content', 'media'], ['media:thumbnail', 'thumbnail']] },
});

async function fetchFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return result.items.map(item => ({
      id:          item.guid || item.link || item.title || '',
      title:       (item.title || '').trim(),
      summary:     (item.contentSnippet || item.summary || item.content || '').slice(0, 400).trim(),
      url:         item.link || '',
      source:      feed.name,
      sourceMkt:   feed.market,
      publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
      image:       item.media?.$.url || item.thumbnail?.$.url || item.enclosure?.url || null,
    }));
  } catch (err) {
    console.warn(`[FEED FAIL] ${feed.name}: ${err.message}`);
    return [];
  }
}

async function pollFeeds() {
  console.log(`[POLL] Fetching ${RSS_FEEDS.length} feeds…`);
  const newArticles = [];

  const settled = await Promise.allSettled(RSS_FEEDS.map(fetchFeed));
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const raw of r.value) {
      if (!raw.url || seenUrls.has(raw.url) || !raw.title) continue;
      seenUrls.add(raw.url);
      const processed = processArticle(raw);
      if (processed) {
        newArticles.push(processed);
        articles.unshift(processed);
      }
    }
  }

  // Keep seenUrls from growing unbounded
  if (seenUrls.size > 10000) {
    const arr = [...seenUrls].slice(-5000);
    seenUrls = new Set(arr);
  }

  // Trim memory
  if (articles.length > MAX_ARTICLES) articles = articles.slice(0, MAX_ARTICLES);

  if (newArticles.length > 0) {
    console.log(`[POLL] ${newArticles.length} new articles`);
    broadcast({ type: 'new_articles', data: newArticles });
  } else {
    console.log('[POLL] No new articles');
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'init', data: articles.slice(0, 150) }));
  ws.on('error', () => {});
});

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/news', (req, res) => {
  const { market, swing, limit = 150 } = req.query;
  let feed = articles;
  if (market && market !== 'all') {
    feed = feed.filter(a => {
      if (a.sourceMkt === market) return true;
      return a.matches?.some(m => TICKER_DB[m.ticker]?.market === market);
    });
  }
  if (swing === '1') feed = feed.filter(a => a.isSwingRelevant);
  res.json(feed.slice(0, parseInt(limit)));
});

app.get('/api/watchlist', (req, res) => {
  res.json(watchlist.map(ticker => ({ ticker, ...(TICKER_DB[ticker] || {}) })));
});

app.post('/api/watchlist', (req, res) => {
  const { ticker } = req.body;
  if (!ticker) return res.status(400).json({ error: 'ticker required' });
  const t = ticker.toUpperCase();
  if (!TICKER_DB[t]) return res.status(404).json({ error: 'Ticker not in database' });
  if (!watchlist.includes(t)) {
    watchlist.push(t);
    saveWatchlist();
    // Re-score existing articles with new watchlist
    articles = articles.map(a => processArticle({ ...a, matches: undefined, matchType: undefined, swingSignals: undefined, isSwingRelevant: undefined })).filter(Boolean);
    broadcast({ type: 'refresh', data: articles.slice(0, 150) });
  }
  res.json({ ok: true, ticker: t, info: TICKER_DB[t] });
});

app.delete('/api/watchlist/:ticker', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  watchlist = watchlist.filter(x => x !== t);
  saveWatchlist();
  articles = articles.map(a => processArticle({ ...a, matches: undefined, matchType: undefined, swingSignals: undefined, isSwingRelevant: undefined })).filter(Boolean);
  broadcast({ type: 'refresh', data: articles.slice(0, 150) });
  res.json({ ok: true });
});

app.get('/api/tickers', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const results = Object.entries(TICKER_DB)
    .filter(([sym, info]) =>
      sym.toLowerCase().includes(q) ||
      info.name.toLowerCase().includes(q) ||
      (info.exchange || '').toLowerCase().includes(q)
    )
    .slice(0, 25)
    .map(([sym, info]) => ({
      ticker: sym,
      name: info.name,
      market: info.market,
      exchange: info.exchange || '',
    }));
  res.json(results);
});

app.get('/api/status', (req, res) => {
  res.json({ articles: articles.length, watchlist, feeds: RSS_FEEDS.length });
});

// ─── Seed Data ────────────────────────────────────────────────────────────────
function loadSeedData() {
  console.log(`[SEED] Loading ${SEED.length} seed articles…`);
  for (const raw of SEED) {
    const id = raw.url;
    if (!seenUrls.has(id)) {
      seenUrls.add(id);
      const processed = processArticle({ ...raw, id });
      if (processed) articles.push(processed);
    }
  }
  // Sort by date
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  console.log(`[SEED] ${articles.length} articles ready`);
}

// Push one drip article every 90 seconds to simulate live feed
function startDripSimulation() {
  setInterval(() => {
    const raw = nextDrip();
    if (seenUrls.has(raw.id)) return;
    seenUrls.add(raw.id);
    const processed = processArticle(raw);
    if (processed) {
      articles.unshift(processed);
      console.log(`[DRIP] New article: ${raw.title.slice(0, 60)}…`);
      broadcast({ type: 'new_articles', data: [processed] });
    }
  }, 90 * 1000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀  MarketPulse running → http://localhost:${PORT}\n`);
  loadSeedData();
  startDripSimulation();
  // Also poll real feeds — they'll add articles if network allows
  pollFeeds();
  setInterval(pollFeeds, POLL_INTERVAL);
});
