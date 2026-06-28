'use strict';

const express    = require('express');
const { WebSocketServer } = require('ws');
const Parser     = require('rss-parser');
const http       = require('http');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT          = process.env.PORT || 3000;
const POLL_INTERVAL = 90 * 1000; // 90 sec
const MAX_ARTICLES  = 600;
const DATA_FILE     = path.join(__dirname, 'data.json');

// ─── Ticker Database ──────────────────────────────────────────────────────────
const TICKER_DB = {
  // ── US TECH ──────────────────────────────────────────────────────────────
  'AAPL':    { name: 'Apple',            market: 'stocks', exchange: 'NASDAQ', terms: ['apple', 'iphone', 'ipad', 'macbook', 'app store', 'tim cook', 'airpods', 'apple watch', 'vision pro', 'cupertino'] },
  'MSFT':    { name: 'Microsoft',        market: 'stocks', exchange: 'NASDAQ', terms: ['microsoft', 'azure', 'windows', 'xbox', 'satya nadella', 'openai', 'copilot', 'bing', 'teams', 'linkedin'] },
  'GOOGL':   { name: 'Alphabet/Google',  market: 'stocks', exchange: 'NASDAQ', terms: ['google', 'alphabet', 'youtube', 'android', 'gemini', 'sundar pichai', 'waymo', 'deepmind', 'google cloud'] },
  'AMZN':    { name: 'Amazon',           market: 'stocks', exchange: 'NASDAQ', terms: ['amazon', 'aws', 'andy jassy', 'prime', 'alexa', 'amazon web services'] },
  'NVDA':    { name: 'Nvidia',           market: 'stocks', exchange: 'NASDAQ', terms: ['nvidia', 'gpu', 'jensen huang', 'cuda', 'h100', 'blackwell', 'hopper', 'geforce', 'rtx', 'ai chip', 'data center chip'] },
  'META':    { name: 'Meta',             market: 'stocks', exchange: 'NASDAQ', terms: ['meta', 'facebook', 'instagram', 'whatsapp', 'mark zuckerberg', 'metaverse', 'threads', 'oculus'] },
  'TSLA':    { name: 'Tesla',            market: 'stocks', exchange: 'NASDAQ', terms: ['tesla', 'elon musk', 'electric vehicle', 'ev', 'cybertruck', 'autopilot', 'full self driving', 'gigafactory', 'powerwall'] },
  'AMD':     { name: 'AMD',              market: 'stocks', exchange: 'NASDAQ', terms: ['amd', 'advanced micro devices', 'ryzen', 'radeon', 'lisa su', 'epyc', 'instinct'] },
  'INTC':    { name: 'Intel',            market: 'stocks', exchange: 'NASDAQ', terms: ['intel', 'pat gelsinger', 'intel foundry', 'core processor', 'gaudi'] },
  'NFLX':    { name: 'Netflix',          market: 'stocks', exchange: 'NASDAQ', terms: ['netflix', 'streaming service', 'reed hastings', 'ted sarandos'] },
  'ORCL':    { name: 'Oracle',           market: 'stocks', exchange: 'NYSE',   terms: ['oracle', 'larry ellison', 'oracle cloud', 'java', 'oracle database'] },
  'CRM':     { name: 'Salesforce',       market: 'stocks', exchange: 'NYSE',   terms: ['salesforce', 'marc benioff', 'slack', 'salesforce crm'] },
  'ADBE':    { name: 'Adobe',            market: 'stocks', exchange: 'NASDAQ', terms: ['adobe', 'photoshop', 'creative cloud', 'firefly ai', 'acrobat'] },
  'PLTR':    { name: 'Palantir',         market: 'stocks', exchange: 'NYSE',   terms: ['palantir', 'alex karp', 'gotham', 'foundry platform', 'aip palantir'] },
  'COIN':    { name: 'Coinbase',         market: 'stocks', exchange: 'NASDAQ', terms: ['coinbase', 'brian armstrong', 'base network coinbase'] },
  'SNOW':    { name: 'Snowflake',        market: 'stocks', exchange: 'NYSE',   terms: ['snowflake', 'sridhar ramaswamy', 'snowflake cloud', 'data cloud'] },
  'UBER':    { name: 'Uber',             market: 'stocks', exchange: 'NYSE',   terms: ['uber', 'dara khosrowshahi', 'rideshare', 'uber eats'] },
  'ABNB':    { name: 'Airbnb',           market: 'stocks', exchange: 'NASDAQ', terms: ['airbnb', 'brian chesky', 'short-term rental', 'vacation rental'] },
  'RBLX':    { name: 'Roblox',           market: 'stocks', exchange: 'NYSE',   terms: ['roblox', 'david baszucki', 'roblox platform'] },
  'SNAP':    { name: 'Snap',             market: 'stocks', exchange: 'NYSE',   terms: ['snap', 'snapchat', 'evan spiegel', 'spectacles snap'] },

  // ── US FINANCE ────────────────────────────────────────────────────────────
  'JPM':     { name: 'JPMorgan Chase',   market: 'stocks', exchange: 'NYSE',   terms: ['jpmorgan', 'jp morgan', 'jamie dimon', 'chase bank'] },
  'BAC':     { name: 'Bank of America',  market: 'stocks', exchange: 'NYSE',   terms: ['bank of america', 'bofa', 'brian moynihan'] },
  'GS':      { name: 'Goldman Sachs',    market: 'stocks', exchange: 'NYSE',   terms: ['goldman sachs', 'david solomon', 'goldman'] },
  'MS':      { name: 'Morgan Stanley',   market: 'stocks', exchange: 'NYSE',   terms: ['morgan stanley', 'ted pick', 'james gorman'] },
  'V':       { name: 'Visa',             market: 'stocks', exchange: 'NYSE',   terms: ['visa', 'visa card', 'visa payments', 'ryan mcinerney'] },
  'MA':      { name: 'Mastercard',       market: 'stocks', exchange: 'NYSE',   terms: ['mastercard', 'master card', 'michael miebach'] },
  'PYPL':    { name: 'PayPal',           market: 'stocks', exchange: 'NASDAQ', terms: ['paypal', 'venmo', 'alex chriss', 'buy now pay later'] },
  'SQ':      { name: 'Block/Square',     market: 'stocks', exchange: 'NYSE',   terms: ['block inc', 'square payments', 'jack dorsey', 'cash app', 'afterpay'] },

  // ── US ENERGY ──────────────────────────────────────────────────────────────
  'XOM':     { name: 'ExxonMobil',       market: 'stocks', exchange: 'NYSE',   terms: ['exxon', 'exxonmobil', 'darren woods'] },
  'CVX':     { name: 'Chevron',          market: 'stocks', exchange: 'NYSE',   terms: ['chevron', 'mike wirth', 'chevron corp'] },

  // ── US EV / AUTO ──────────────────────────────────────────────────────────
  'F':       { name: 'Ford',             market: 'stocks', exchange: 'NYSE',   terms: ['ford motor', 'mustang', 'f-150', 'jim farley ford'] },
  'GM':      { name: 'General Motors',   market: 'stocks', exchange: 'NYSE',   terms: ['general motors', 'mary barra', 'chevy', 'chevrolet', 'cadillac'] },
  'RIVN':    { name: 'Rivian',           market: 'stocks', exchange: 'NASDAQ', terms: ['rivian', 'rj scaringe', 'rivian truck'] },

  // ── MEME / POPULAR ─────────────────────────────────────────────────────────
  'GME':     { name: 'GameStop',         market: 'stocks', exchange: 'NYSE',   terms: ['gamestop', 'gme', 'roaring kitty', 'ryan cohen', 'meme stock'] },
  'AMC':     { name: 'AMC Entertainment',market: 'stocks', exchange: 'NYSE',   terms: ['amc entertainment', 'adam aron', 'amc theaters'] },
  'HOOD':    { name: 'Robinhood',        market: 'stocks', exchange: 'NASDAQ', terms: ['robinhood', 'vlad tenev', 'robinhood markets'] },

  // ── US HEALTHCARE ──────────────────────────────────────────────────────────
  'MRNA':    { name: 'Moderna',          market: 'stocks', exchange: 'NASDAQ', terms: ['moderna', 'mrna vaccine', 'stephane bancel'] },
  'PFE':     { name: 'Pfizer',           market: 'stocks', exchange: 'NYSE',   terms: ['pfizer', 'albert bourla', 'paxlovid'] },
  'JNJ':     { name: 'J&J',             market: 'stocks', exchange: 'NYSE',   terms: ['johnson & johnson', 'j&j', 'joaquin duato'] },
  'LLY':     { name: 'Eli Lilly',        market: 'stocks', exchange: 'NYSE',   terms: ['eli lilly', 'ozempic', 'mounjaro', 'tirzepatide', 'glp-1', 'weight loss drug', 'david ricks'] },
  'NVO':     { name: 'Novo Nordisk',     market: 'stocks', exchange: 'NYSE',   terms: ['novo nordisk', 'ozempic', 'wegovy', 'semaglutide', 'glp-1'] },

  // ── US DEFENSE ─────────────────────────────────────────────────────────────
  'BA':      { name: 'Boeing',           market: 'stocks', exchange: 'NYSE',   terms: ['boeing', 'kelly ortberg', '737 max', '787 dreamliner'] },
  'LMT':     { name: 'Lockheed Martin',  market: 'stocks', exchange: 'NYSE',   terms: ['lockheed martin', 'f-35', 'james taiclet'] },
  'RTX':     { name: 'RTX Corp',         market: 'stocks', exchange: 'NYSE',   terms: ['rtx', 'raytheon', 'pratt & whitney', 'collins aerospace'] },

  // ── CRYPTO ────────────────────────────────────────────────────────────────
  'BTC':     { name: 'Bitcoin',          market: 'crypto', terms: ['bitcoin', 'btc', 'satoshi', 'halving', 'lightning network', 'cryptocurrency', 'digital gold', 'spot bitcoin etf', 'bitcoin etf'] },
  'ETH':     { name: 'Ethereum',         market: 'crypto', terms: ['ethereum', 'eth', 'defi', 'vitalik buterin', 'smart contract', 'staking ethereum', 'layer 2', 'eip ethereum'] },
  'BNB':     { name: 'BNB/Binance',      market: 'crypto', terms: ['bnb', 'binance', 'cz binance', 'richard teng', 'bsc', 'binance smart chain'] },
  'SOL':     { name: 'Solana',           market: 'crypto', terms: ['solana', 'sol crypto', 'anatoly yakovenko', 'solana network'] },
  'XRP':     { name: 'XRP/Ripple',       market: 'crypto', terms: ['xrp', 'ripple', 'brad garlinghouse', 'ripple labs', 'ripple sec'] },
  'ADA':     { name: 'Cardano',          market: 'crypto', terms: ['cardano', 'ada crypto', 'charles hoskinson'] },
  'DOGE':    { name: 'Dogecoin',         market: 'crypto', terms: ['dogecoin', 'doge', 'meme coin'] },
  'AVAX':    { name: 'Avalanche',        market: 'crypto', terms: ['avalanche', 'avax', 'emin gün sirer', 'avalanche blockchain'] },
  'MATIC':   { name: 'Polygon',          market: 'crypto', terms: ['polygon', 'matic', 'sandeep nailwal', 'polygon network'] },
  'DOT':     { name: 'Polkadot',         market: 'crypto', terms: ['polkadot', 'dot crypto', 'gavin wood', 'parachain'] },
  'LINK':    { name: 'Chainlink',        market: 'crypto', terms: ['chainlink', 'link crypto', 'sergey nazarov', 'oracle network chainlink'] },
  'TON':     { name: 'Toncoin',          market: 'crypto', terms: ['toncoin', 'ton crypto', 'telegram open network'] },
  'SHIB':    { name: 'Shiba Inu',        market: 'crypto', terms: ['shiba inu', 'shib', 'shibarium'] },
  'LTC':     { name: 'Litecoin',         market: 'crypto', terms: ['litecoin', 'ltc', 'charlie lee litecoin'] },
  'UNI':     { name: 'Uniswap',          market: 'crypto', terms: ['uniswap', 'uni crypto', 'dex swap', 'decentralized exchange uniswap'] },
  'APT':     { name: 'Aptos',            market: 'crypto', terms: ['aptos', 'apt crypto', 'aptos blockchain'] },
  'ARB':     { name: 'Arbitrum',         market: 'crypto', terms: ['arbitrum', 'arb crypto', 'layer 2 arbitrum'] },
  'OP':      { name: 'Optimism',         market: 'crypto', terms: ['optimism', 'op crypto', 'optimism network'] },

  // ── FOREX ─────────────────────────────────────────────────────────────────
  'EURUSD':  { name: 'EUR/USD',          market: 'forex', terms: ['eur/usd', 'eurusd', 'euro dollar', 'european central bank', 'ecb rate', 'ecb decision', 'eurozone inflation', 'lagarde ecb', 'eurozone gdp'] },
  'GBPUSD':  { name: 'GBP/USD',          market: 'forex', terms: ['gbp/usd', 'gbpusd', 'pound dollar', 'sterling', 'bank of england', 'boe rate', 'uk inflation', 'andrew bailey', 'uk economy'] },
  'USDJPY':  { name: 'USD/JPY',          market: 'forex', terms: ['usd/jpy', 'usdjpy', 'dollar yen', 'yen', 'bank of japan', 'boj rate', 'japan inflation', 'ueda boj', 'forex intervention', 'yen weakens', 'yen strengthens'] },
  'AUDUSD':  { name: 'AUD/USD',          market: 'forex', terms: ['aud/usd', 'audusd', 'aussie dollar', 'australian dollar', 'rba rate', 'reserve bank australia', 'australia inflation', 'australia gdp'] },
  'USDCAD':  { name: 'USD/CAD',          market: 'forex', terms: ['usd/cad', 'usdcad', 'loonie', 'canadian dollar', 'bank of canada', 'boc rate', 'canada economy'] },
  'USDCHF':  { name: 'USD/CHF',          market: 'forex', terms: ['usd/chf', 'usdchf', 'swiss franc', 'snb rate', 'swiss national bank'] },
  'NZDUSD':  { name: 'NZD/USD',          market: 'forex', terms: ['nzd/usd', 'nzdusd', 'kiwi dollar', 'new zealand dollar', 'rbnz rate'] },
  'USDSGD':  { name: 'USD/SGD',          market: 'forex', terms: ['usd/sgd', 'singapore dollar', 'mas rate', 'monetary authority singapore', 'sgd exchange'] },
  'GBPJPY':  { name: 'GBP/JPY',          market: 'forex', terms: ['gbp/jpy', 'gbpjpy', 'pound yen', 'sterling yen'] },
  'USDHKD':  { name: 'USD/HKD',          market: 'forex', terms: ['usd/hkd', 'hong kong dollar', 'hkma', 'hkd peg'] },
  'USDCNH':  { name: 'USD/CNH',          market: 'forex', terms: ['usd/cnh', 'yuan', 'renminbi', 'pboc', 'peoples bank of china', 'china currency'] },

  // ── COMMODITIES ────────────────────────────────────────────────────────────
  'GOLD':    { name: 'Gold (XAU)',        market: 'commodities', terms: ['gold price', 'xau', 'precious metal', 'safe haven gold', 'bullion', 'spot gold', 'comex gold', 'gold futures', 'gold rally'] },
  'SILVER':  { name: 'Silver (XAG)',      market: 'commodities', terms: ['silver price', 'xag', 'silver futures', 'silver rally', 'comex silver'] },
  'OIL':     { name: 'WTI Crude Oil',     market: 'commodities', terms: ['crude oil', 'wti crude', 'oil price', 'opec', 'opec+', 'petroleum', 'barrel oil', 'oil futures', 'energy prices', 'brent crude'] },
  'NATGAS':  { name: 'Natural Gas',       market: 'commodities', terms: ['natural gas', 'lng', 'natgas', 'henry hub', 'gas prices', 'liquefied natural gas'] },
  'COPPER':  { name: 'Copper',            market: 'commodities', terms: ['copper price', 'comex copper', 'dr copper', 'copper demand'] },
  'WHEAT':   { name: 'Wheat',             market: 'commodities', terms: ['wheat price', 'wheat futures', 'grain prices', 'cbot wheat'] },
  'CORN':    { name: 'Corn',              market: 'commodities', terms: ['corn price', 'corn futures', 'maize', 'cbot corn'] },
  'PLATINUM':{ name: 'Platinum',          market: 'commodities', terms: ['platinum price', 'pgm', 'platinum group metals', 'palladium'] },

  // ── INDICES ────────────────────────────────────────────────────────────────
  'SPX':     { name: 'S&P 500',           market: 'indices', terms: ['s&p 500', 'sp500', 's&p500', 'spx', 'spy etf', 'wall street rally', 'us stocks rally', 'federal reserve', 'fed rate', 'powell fed', 'us economy', 'american economy', 'inflation data us'] },
  'NDX':     { name: 'Nasdaq 100',        market: 'indices', terms: ['nasdaq 100', 'ndx', 'qqq', 'tech stocks rally', 'nasdaq composite', 'nasdaq rally'] },
  'DJI':     { name: 'Dow Jones',         market: 'indices', terms: ['dow jones', 'dow', 'djia', 'blue chip stocks'] },
  'RUT':     { name: 'Russell 2000',      market: 'indices', terms: ['russell 2000', 'small cap stocks', 'iwm', 'small caps'] },
  'VIX':     { name: 'VIX Volatility',    market: 'indices', terms: ['vix', 'volatility index', 'fear index', 'market volatility', 'cboe vix'] },
  'FTSE':    { name: 'FTSE 100',          market: 'indices', terms: ['ftse 100', 'ftse100', 'london stock exchange', 'uk stocks', 'footsie'] },
  'DAX':     { name: 'DAX',               market: 'indices', terms: ['dax index', 'german stocks', 'frankfurt stock', 'germany economy'] },
  'N225':    { name: 'Nikkei 225',        market: 'indices', terms: ['nikkei', 'nikkei 225', 'japan stocks', 'topix', 'tokyo stock exchange'] },
  'HSI':     { name: 'Hang Seng',         market: 'indices', terms: ['hang seng', 'hsi', 'hong kong stocks', 'hkex', 'hong kong market'] },
  'STI':     { name: 'STI (Singapore)',   market: 'indices', terms: ['sti index', 'straits times index', 'sgx', 'singapore exchange', 'singapore stocks', 'singapore market'] },
  'ASX200':  { name: 'ASX 200',           market: 'indices', terms: ['asx 200', 'asx200', 'australia stocks', 'australian market', 'asx market'] },
  'CSI300':  { name: 'CSI 300 (China)',   market: 'indices', terms: ['csi 300', 'china stocks', 'a-shares', 'shanghai composite', 'shenzhen', 'chinese market'] },

  // ── SGX STOCKS ─────────────────────────────────────────────────────────────
  'D05':     { name: 'DBS Bank',          market: 'stocks', exchange: 'SGX', terms: ['dbs bank', 'dbs group', 'piyush gupta', 'dbs digital'] },
  'O39':     { name: 'OCBC Bank',         market: 'stocks', exchange: 'SGX', terms: ['ocbc', 'ocbc bank', 'helen wong ocbc', 'great eastern life'] },
  'U11':     { name: 'UOB Bank',          market: 'stocks', exchange: 'SGX', terms: ['uob', 'united overseas bank', 'wee ee cheong'] },
  'C6L':     { name: 'Singapore Airlines',market: 'stocks', exchange: 'SGX', terms: ['singapore airlines', 'sia', 'scoot airline', 'sia engineering'] },
  'Z74':     { name: 'Singtel',           market: 'stocks', exchange: 'SGX', terms: ['singtel', 'singapore telecommunications', 'optus', 'airtel india'] },
  'C31':     { name: 'CapitaLand Invest.',market: 'stocks', exchange: 'SGX', terms: ['capitaland', 'cli', 'capitaland investment'] },
  'G13':     { name: 'Genting Singapore', market: 'stocks', exchange: 'SGX', terms: ['genting singapore', 'resorts world sentosa', 'rws casino'] },
  'BN4':     { name: 'Keppel Corp',       market: 'stocks', exchange: 'SGX', terms: ['keppel', 'keppel corporation', 'keppel offshore'] },
  'F34':     { name: 'Wilmar International',market:'stocks', exchange: 'SGX', terms: ['wilmar', 'wilmar international', 'kuok group', 'palm oil wilmar'] },

  // ── ASX (AUSTRALIA) ────────────────────────────────────────────────────────
  'BHP':     { name: 'BHP Group',          market: 'stocks', exchange: 'ASX', terms: ['bhp', 'bhp group', 'bhp billiton', 'mike henry bhp', 'bhp iron ore'] },
  'CBA':     { name: 'CommonWealth Bank',  market: 'stocks', exchange: 'ASX', terms: ['commonwealth bank', 'commbank', 'cba bank', 'matt comyn'] },
  'CSL':     { name: 'CSL Limited',        market: 'stocks', exchange: 'ASX', terms: ['csl limited', 'csl behring', 'csl plasma', 'paul mckenzie csl'] },
  'RIO':     { name: 'Rio Tinto',          market: 'stocks', exchange: 'ASX', terms: ['rio tinto', 'jakob stausholm', 'iron ore rio tinto'] },
  'ANZ':     { name: 'ANZ Banking',        market: 'stocks', exchange: 'ASX', terms: ['anz bank', 'anz banking', 'shayne elliott anz', 'australia new zealand bank'] },
  'NAB':     { name: 'Natl Australia Bank',market: 'stocks', exchange: 'ASX', terms: ['national australia bank', 'nab bank', 'andrew irvine nab'] },
  'WBC':     { name: 'Westpac Banking',    market: 'stocks', exchange: 'ASX', terms: ['westpac', 'westpac bank', 'anthony miller westpac'] },
  'WOW':     { name: 'Woolworths Group',   market: 'stocks', exchange: 'ASX', terms: ['woolworths', 'woolworths australia', 'woolworths group'] },
  'MQG':     { name: 'Macquarie Group',    market: 'stocks', exchange: 'ASX', terms: ['macquarie', 'macquarie group', 'shemara wikramanayake', 'macquarie bank'] },
  'FMG':     { name: 'Fortescue Metals',   market: 'stocks', exchange: 'ASX', terms: ['fortescue', 'fmg', 'andrew forrest', 'fortescue metals', 'iron ore fortescue'] },

  // ── HKEX (HONG KONG) ───────────────────────────────────────────────────────
  '0700':    { name: 'Tencent',            market: 'stocks', exchange: 'HKEX', terms: ['tencent', 'pony ma', 'wechat', 'weixin', 'tencent games', 'tencent cloud', 'tencent music'] },
  '9988':    { name: 'Alibaba (HK)',        market: 'stocks', exchange: 'HKEX', terms: ['alibaba', 'taobao', 'tmall', 'eddie wu alibaba', 'alicloud', 'alibaba cloud', 'alibaba hong kong'] },
  '0005':    { name: 'HSBC Holdings',       market: 'stocks', exchange: 'HKEX', terms: ['hsbc', 'noel quinn hsbc', 'hsbc holdings', 'hong kong shanghai banking'] },
  '1299':    { name: 'AIA Group',           market: 'stocks', exchange: 'HKEX', terms: ['aia group', 'aia insurance', 'lee yuan siong', 'aia hong kong'] },
  '3690':    { name: 'Meituan',             market: 'stocks', exchange: 'HKEX', terms: ['meituan', 'wang xing meituan', 'meituan dianping', 'food delivery china'] },
  '9618':    { name: 'JD.com (HK)',         market: 'stocks', exchange: 'HKEX', terms: ['jd.com', 'jingdong', 'richard liu jd', 'jd logistics'] },
  '2318':    { name: 'Ping An Insurance',   market: 'stocks', exchange: 'HKEX', terms: ['ping an', 'ping an insurance', 'peter ma ping an', 'ping an bank'] },
  '1398':    { name: 'ICBC',                market: 'stocks', exchange: 'HKEX', terms: ['icbc', 'industrial commercial bank china', 'icbc hong kong'] },
};

// ─── Seed Articles ────────────────────────────────────────────────────────────
function ago(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

const SEED = [
  // ── MACRO / FED ────────────────────────────────────────────────────────────
  { title: "Fed Minutes Signal Rate Cut Possible in September If Inflation Keeps Cooling", summary: "Federal Reserve minutes released Wednesday show officials see conditions for a rate cut building, contingent on two more months of declining CPI data. Powell emphasized the committee is 'not in a hurry' but noted risks have become 'more balanced.' Markets are pricing in a 68% chance of a September cut.", source: "MarketWatch", sourceMkt: "general", url: "https://marketwatch.com/fed-minutes-sept-cut", publishedAt: ago(18) },
  { title: "US CPI April: Inflation Cools to 2.8% YoY, Core at 3.1% — Below Expectations", summary: "April CPI came in at 2.8% year-over-year, below the 2.9% consensus. Core CPI at 3.1% also beat expectations. Shelter costs rose 0.3% MoM, the slowest pace in two years. The dollar weakened and Treasuries rallied on the print.", source: "CNBC", sourceMkt: "general", url: "https://cnbc.com/cpi-april-2026", publishedAt: ago(6) },
  { title: "US GDP Q1 Final Revision: Economy Grew 2.4%, Better Than Preliminary 2.1%", summary: "The final Q1 GDP revision showed the US economy expanded at a 2.4% annualized pace, upgraded from the preliminary 2.1% estimate. Consumer spending and business investment were the primary drivers. Recession fears fade further after the upward revision.", source: "Reuters Business", sourceMkt: "general", url: "https://reuters.com/gdp-q1-final", publishedAt: ago(54) },
  { title: "Nonfarm Payrolls Add 215K Jobs in April, Unemployment Holds at 3.9%", summary: "April jobs report came in slightly above consensus of 200K. Wage growth eased to 3.8% YoY from 4.1% previously, a development welcomed by the Fed. Healthcare and construction led gains. The report reinforces a soft-landing narrative.", source: "WSJ Markets", sourceMkt: "general", url: "https://wsj.com/jobs-april-2026", publishedAt: ago(120) },

  // ── US EQUITIES — EARNINGS & MOVERS ────────────────────────────────────────
  { title: "Nvidia Q1 Revenue Surges 78% to $47.2B, EPS Beats by 23 Cents — Stock Rallies 8%", summary: "Nvidia reported Q1 2026 revenue of $47.2B, up 78% YoY, crushing the $44.8B consensus. Data Center segment alone generated $39.1B. CEO Jensen Huang said Blackwell GPU demand 'far exceeds supply' and raised full-year guidance. Shares jumped 8% in after-hours trading.", source: "CNBC", sourceMkt: "stocks", url: "https://cnbc.com/nvda-q1-2026", publishedAt: ago(9) },
  { title: "Apple Unveils AI-Enhanced iPhone 18 Pro With On-Device LLM, Shares Up 4%", summary: "Apple's WWDC keynote revealed iPhone 18 Pro will feature a dedicated Neural Engine running a 7B parameter on-device language model, enabling offline AI tasks. Analysts at Morgan Stanley raised their price target to $265. Shares gained 4% on the news.", source: "Bloomberg", sourceMkt: "stocks", url: "https://bloomberg.com/aapl-iphone-18", publishedAt: ago(27) },
  { title: "Tesla Deliveries Miss Estimate for Third Consecutive Quarter; Stock Falls 6%", summary: "Tesla delivered 412,000 vehicles in Q1, below the 425,000 analyst consensus. The shortfall was attributed to factory retooling in Fremont and logistics delays in Europe. Elon Musk's distraction with political activities was cited by multiple analysts as a governance concern.", source: "Reuters Business", sourceMkt: "stocks", url: "https://reuters.com/tsla-deliveries-q1", publishedAt: ago(45) },
  { title: "Meta AI Monetisation Surprises: Ad Revenue Up 19%, Llama Licensing Revenue $1.2B", summary: "Meta Q1 earnings showed ad revenue growth of 19% YoY with AI-optimised ad targeting credited for the beat. The company also disclosed $1.2B in enterprise Llama 3 licensing deals. Daily active users across the family of apps hit 3.4B. Stock rose 6.5% after-hours.", source: "CNBC Markets", sourceMkt: "stocks", url: "https://cnbc.com/meta-q1-2026", publishedAt: ago(63) },
  { title: "AMD Gains Ground in AI Accelerator Market: Instinct MI400 Wins Microsoft Azure Deal", summary: "AMD announced Microsoft Azure will deploy 50,000 Instinct MI400 GPUs in its new AI training clusters, marking AMD's largest hyperscaler win to date. Analysts at JPMorgan upgraded AMD to Overweight with a $220 price target, citing accelerating data center adoption.", source: "MarketWatch", sourceMkt: "stocks", url: "https://marketwatch.com/amd-azure-deal", publishedAt: ago(81) },
  { title: "Goldman Sachs Upgrades S&P 500 Year-End Target to 6,200 on Earnings Resilience", summary: "Goldman Sachs chief equity strategist David Kostin raised the S&P 500 year-end target from 5,800 to 6,200, citing stronger-than-expected Q1 earnings season with 78% of companies beating EPS estimates. The bank sees AI capex driving durable margin expansion in tech.", source: "WSJ Markets", sourceMkt: "stocks", url: "https://wsj.com/gs-sp500-target", publishedAt: ago(97) },
  { title: "Microsoft Azure Revenue Grows 31% as AI Copilot Adoption Drives Enterprise Spending", summary: "Microsoft fiscal Q3 results showed Azure revenue growth of 31%, above the 28% consensus. CEO Satya Nadella noted more than 85% of the Fortune 500 now use Microsoft AI products. Operating income reached $28.1B. Shares rose 5.2% after-hours on the beat.", source: "CNBC Earnings", sourceMkt: "stocks", url: "https://cnbc.com/msft-q3-2026", publishedAt: ago(114) },
  { title: "Boeing 737 MAX Receives FAA Approval for Extended Range Variant; Shares Jump 5%", summary: "The FAA granted Boeing certification for the 737 MAX 10ER, the extended-range variant sought by multiple airlines for transatlantic routes. Delta and United have combined orders for 120 aircraft. The approval removes a major near-term regulatory overhang for Boeing.", source: "Reuters Business", sourceMkt: "stocks", url: "https://reuters.com/ba-737-faa", publishedAt: ago(130) },
  { title: "Palantir Secures $3.2B US Army AI Contract Extension, Stock Hits All-Time High", summary: "Palantir's AIP platform received a three-year, $3.2B extension on its AI battlefield intelligence contract with the US Army. CEO Alex Karp said this cements Palantir as 'the spine of American military AI.' PLTR shares hit an all-time high of $88.40.", source: "MarketWatch", sourceMkt: "stocks", url: "https://marketwatch.com/pltr-army-contract", publishedAt: ago(148) },
  { title: "Morgan Stanley Raises Eli Lilly Price Target to $1,000 on GLP-1 Market Dominance", summary: "Morgan Stanley analysts upgraded their Eli Lilly 12-month price target to $1,000 per share, citing GLP-1 drugs (Mounjaro, Zepbound) capturing 62% market share in the obesity and diabetes segment. They forecast Mounjaro alone reaching $28B annual revenue by 2028.", source: "CNBC Markets", sourceMkt: "stocks", url: "https://cnbc.com/lly-upgrade-ms", publishedAt: ago(165) },
  { title: "Coinbase Q1 Revenue Doubles on Crypto Bull Market; Institutional Trading Up 180%", summary: "Coinbase reported Q1 revenue of $2.4B, up 102% YoY, with net income of $1.1B. Institutional trading volume jumped 180% quarter-over-quarter. CEO Brian Armstrong noted spot Bitcoin and Ethereum ETF launches have brought in a new wave of institutional capital.", source: "The Block", sourceMkt: "stocks", url: "https://theblock.co/coinbase-q1", publishedAt: ago(182) },

  // ── CRYPTO ─────────────────────────────────────────────────────────────────
  { title: "Bitcoin Breaks $105,000 Resistance; Eyes $110K as ETF Inflows Hit Record $2.1B Weekly", summary: "Bitcoin surged past the $105,000 resistance level on high volume, with spot Bitcoin ETF inflows hitting a record $2.1B in the week. Analysts at Standard Chartered see BTC targeting $115,000 in Q2 driven by continued institutional demand and constrained post-halving supply.", source: "CoinDesk", sourceMkt: "crypto", url: "https://coindesk.com/btc-105k-breakout", publishedAt: ago(12) },
  { title: "Ethereum ETF AUM Crosses $20B as Staking Yield Drives Institutional Demand", summary: "Spot Ethereum ETFs in the US now manage $20.4B in assets, crossing the milestone amid growing institutional interest in ETH's 4.1% staking yield. BlackRock's ETHA fund alone accounts for $7.8B. Ethereum is up 12% month-to-date as the ETF demand narrative builds.", source: "CoinTelegraph", sourceMkt: "crypto", url: "https://cointelegraph.com/eth-etf-20b", publishedAt: ago(34) },
  { title: "Solana DeFi TVL Tops $18B; 'Super App' Ecosystem Drives SOL to 6-Month High", summary: "Solana's Total Value Locked in DeFi protocols reached $18B, a new record, supported by the launch of three major DEX aggregators and a new liquid staking protocol. SOL/USD rose 18% this week, hitting a 6-month high of $198 as developer activity remains elevated.", source: "Decrypt", sourceMkt: "crypto", url: "https://decrypt.co/sol-tvl-record", publishedAt: ago(52) },
  { title: "XRP Wins Final Legal Battle: SEC Appeal Denied, Ripple CEO Says 'Crypto Legal Clarity Arrives'", summary: "A US appeals court denied the SEC's attempt to appeal the Ripple decision, confirming XRP sales on secondary markets do not constitute securities transactions. XRP surged 22% on the news to $2.84. CEO Brad Garlinghouse called it a 'watershed moment for the entire crypto industry.'", source: "The Block", sourceMkt: "crypto", url: "https://theblock.co/xrp-sec-final", publishedAt: ago(70) },
  { title: "Binance Launches Regulated EU Exchange; BNB Gains 9% on Regulatory Clarity", summary: "Binance received regulatory approval to operate a fully-regulated exchange in Germany under EU's MiCA framework, a landmark move that could unlock institutional European capital. BNB rose 9% to $712 as investors bet on Binance regaining market dominance in Europe.", source: "CoinDesk", sourceMkt: "crypto", url: "https://coindesk.com/binance-eu-approved", publishedAt: ago(89) },
  { title: "Bitcoin Mining Difficulty Hits All-Time High as Hash Rate Surpasses 800 EH/s", summary: "Bitcoin's network difficulty adjusted upward by 4.2% to a new all-time high, with hash rate surpassing 800 exahashes per second for the first time. The metric signals miner confidence in sustained profitability, a historically bullish indicator for BTC price.", source: "Decrypt", sourceMkt: "crypto", url: "https://decrypt.co/btc-hashrate-ath", publishedAt: ago(107) },
  { title: "Dogecoin Surges 35% as Elon Musk Announces X Payments Integration, 'DOGE Accepted'", summary: "Dogecoin jumped 35% to $0.42 after Elon Musk announced X (formerly Twitter) will accept DOGE payments for premium subscriptions and content creator tipping, effective next quarter. On-chain activity spiked with active addresses rising 180% in 24 hours.", source: "CoinTelegraph", sourceMkt: "crypto", url: "https://cointelegraph.com/doge-x-payments", publishedAt: ago(124) },
  { title: "Avalanche Foundation Deploys $300M Ecosystem Fund; AVAX Up 14%", summary: "The Avalanche Foundation unveiled a $300M development fund targeting DeFi, gaming, and enterprise blockchain projects building on Avalanche's C-Chain. AVAX/USD rose 14% to $52 on the news, with analysts citing improving fundamentals and upcoming Durango upgrade.", source: "Decrypt", sourceMkt: "crypto", url: "https://decrypt.co/avax-ecosystem-fund", publishedAt: ago(141) },

  // ── FOREX ──────────────────────────────────────────────────────────────────
  { title: "EUR/USD Rallies to 1.1250 After ECB Signals Pause; Lagarde Cites Sticky Services Inflation", summary: "The euro strengthened to 1.1250 vs the dollar after ECB President Lagarde signalled the bank would pause its rate-cutting cycle pending further evidence of services disinflation. The ECB has cut rates three times since June 2025. EUR/USD is up 1.2% on the week.", source: "ForexLive", sourceMkt: "forex", url: "https://forexlive.com/eurusd-ecb-pause", publishedAt: ago(22) },
  { title: "USD/JPY Falls Below 148 as Bank of Japan Hints at July Rate Hike", summary: "The yen strengthened sharply, with USD/JPY breaking below the 148 handle after BoJ Governor Ueda indicated conditions may be ripe for a rate increase at the July meeting. Japan's core inflation at 2.6% exceeds the BoJ's 2% target for the 24th consecutive month.", source: "FX Street", sourceMkt: "forex", url: "https://fxstreet.com/usdjpy-boj-july", publishedAt: ago(41) },
  { title: "GBP/USD Hits 1.3450 Ahead of UK Inflation Data; Bank of England Meeting in Focus", summary: "Sterling pushed to 1.3450 against the dollar as traders positioned for a potentially hawkish Bank of England meeting next week. UK wage growth remains above 4% despite slowing overall inflation, complicating the BoE's path toward rate cuts.", source: "ForexLive", sourceMkt: "forex", url: "https://forexlive.com/gbpusd-uk-cpi", publishedAt: ago(59) },
  { title: "AUD/USD Jumps to 0.6720 as Australia Employment Surges; RBA Rate Cut Bets Fade", summary: "The Australian dollar rose sharply after Australia added 58,500 jobs in April, roughly triple the 20,000 consensus estimate. The unemployment rate held at 3.8%. Markets pushed back RBA rate cut expectations from August to November, driving AUD/USD to its highest since January.", source: "FX Street", sourceMkt: "forex", url: "https://fxstreet.com/audusd-jobs", publishedAt: ago(77) },
  { title: "Dollar Index (DXY) Slides to 102.80 on Fed Dovish Pivot Expectations", summary: "The US Dollar Index fell to 102.80, a four-week low, as soft CPI data reinforced expectations of Fed rate cuts beginning in September. Dollar weakness is broad-based, with EUR, GBP, and AUD all gaining. Gold and commodities benefit from the weaker dollar backdrop.", source: "Investing.com", sourceMkt: "forex", url: "https://investing.com/dxy-102", publishedAt: ago(93) },

  // ── COMMODITIES ────────────────────────────────────────────────────────────
  { title: "Gold Breaks $3,400/oz — Safe-Haven Demand Surges on Middle East Tensions", summary: "Spot gold surged past $3,400 per troy ounce for the first time, driven by Middle East geopolitical tensions and dollar weakness following soft US CPI. Central bank buying from China and India remains robust. Analysts at Goldman Sachs target $3,600 by year-end.", source: "Investing Commodities", sourceMkt: "commodities", url: "https://investing.com/gold-3400", publishedAt: ago(14) },
  { title: "WTI Crude Falls to $74.20 as OPEC+ Surprise Output Hike Overwhelms Demand", summary: "WTI crude oil dropped 3.4% to $74.20 per barrel after OPEC+ announced an unexpected 600,000 bpd production increase beginning June. Saudi Arabia reversed its May output cut, citing the need to defend market share amid rising non-OPEC supply from the US and Guyana.", source: "Reuters Business", sourceMkt: "commodities", url: "https://reuters.com/opec-output-hike", publishedAt: ago(32) },
  { title: "Silver Outperforms Gold, Rises 4.2% to $43.80 on Industrial Demand and Solar Boom", summary: "Silver surged 4.2% to $43.80/oz, outperforming gold on a combination of investment demand and strong industrial buying. Solar panel manufacturers have boosted silver purchasing amid record panel installations globally. The gold/silver ratio tightened to 77.6.", source: "Investing.com", sourceMkt: "commodities", url: "https://investing.com/silver-solar", publishedAt: ago(50) },
  { title: "Natural Gas Spikes 12% on Unexpected Cold Snap Forecast; Inventories Below 5-Year Average", summary: "US natural gas futures rose 12% to $3.48/MMBtu as weather models shifted toward a colder-than-expected June across the US Midwest and Northeast. EIA inventories stand 8.2% below the 5-year seasonal average, raising concerns about summer storage adequacy.", source: "MarketWatch", sourceMkt: "commodities", url: "https://marketwatch.com/natgas-spike", publishedAt: ago(68) },
  { title: "Copper Hits $11,200/tonne on China Stimulus Bets and Supply Deficit Fears", summary: "LME copper reached $11,200 per tonne, a 14-month high, as traders anticipate a major Chinese fiscal stimulus package targeting infrastructure. Chile's Codelco simultaneously flagged a 7% production shortfall due to mine disruptions, tightening the global supply outlook.", source: "Investing Commodities", sourceMkt: "commodities", url: "https://investing.com/copper-stimulus", publishedAt: ago(86) },

  // ── INDICES ────────────────────────────────────────────────────────────────
  { title: "S&P 500 Hits New All-Time High at 5,942 — AI Earnings Season Fuels the Rally", summary: "The S&P 500 closed at a new all-time high of 5,942, up 1.4% on the session, as Nvidia's blowout earnings drove broad tech buying. The index has gained 14.2% year-to-date. The Nasdaq 100 added 2.1%, while the VIX dropped to 12.3, the lowest since February.", source: "CNBC Markets", sourceMkt: "indices", url: "https://cnbc.com/sp500-ath-5942", publishedAt: ago(20) },
  { title: "VIX Falls to 12.3 — 'Fear Gauge' at Multi-Month Low as Earnings Season Outperforms", summary: "The CBOE Volatility Index (VIX) fell to 12.3, a 4-month low, signalling extreme complacency among options traders. Historically, VIX below 13 often precedes short-term market volatility as investors become over-positioned. 78% of S&P 500 companies have beaten Q1 EPS estimates.", source: "MarketWatch", sourceMkt: "indices", url: "https://marketwatch.com/vix-1230", publishedAt: ago(38) },
  { title: "Nikkei 225 Rises 1.8% as Yen Weakness Boosts Exporters; Sony and Toyota Lead", summary: "Japan's Nikkei 225 gained 1.8% to close at 38,840 as a weakening yen boosted export-oriented companies. Sony rallied 4.1% after raising its profit forecast, while Toyota added 2.7% on record-high US sales projections. Bank of Japan policy uncertainty remains the key macro risk.", source: "Reuters Business", sourceMkt: "indices", url: "https://reuters.com/nikkei-exporters", publishedAt: ago(56) },
  { title: "Hang Seng Surges 3.1% on China Stimulus Hopes; Tech Giants Lead Gains", summary: "Hong Kong's Hang Seng Index surged 3.1% to 22,450 following reports of an imminent $1 trillion Chinese fiscal stimulus package targeting technology and infrastructure. Alibaba rose 6%, Tencent gained 4.8%. The CSI 300 on the mainland added 2.4%.", source: "Reuters Business", sourceMkt: "indices", url: "https://reuters.com/hsi-china-stimulus", publishedAt: ago(74) },
  { title: "DAX Hits Record 22,800 as German Industrial Output Beats; ECB Pause Lifts Sentiment", summary: "Germany's DAX index set a new all-time high at 22,800, driven by better-than-expected April industrial output data (+1.8% MoM vs +0.6% expected) and the ECB's signal to pause rate cuts, reducing near-term uncertainty for European corporates.", source: "Investing.com", sourceMkt: "indices", url: "https://investing.com/dax-record", publishedAt: ago(92) },

  // ── SGX STOCKS ─────────────────────────────────────────────────────────────
  { title: "DBS Bank Q1 Profit Rises 8% to S$2.96B; NIM Holds at 2.13% Despite Rate Pressures", summary: "DBS Group's Q1 2026 net profit climbed 8% year-on-year to S$2.96B, slightly ahead of consensus. Net interest margin held at 2.13% as the bank successfully managed deposit repricing. CEO Piyush Gupta flagged strong loan growth in India and Indonesia. Dividend maintained at S$0.54.", source: "Business Times", sourceMkt: "stocks", url: "https://bt.sg/dbs-q1-2026", publishedAt: ago(103) },
  { title: "Singapore Airlines Reports Record Full-Year Profit of S$3.2B on Premium Travel Demand", summary: "SIA posted a record annual profit of S$3.2B for FY2026, up 11% from the prior year. Passenger load factor reached 88.1%, the highest in the airline's history. Management guided for continued double-digit revenue growth as premium cabin demand remains strong.", source: "Business Times", sourceMkt: "stocks", url: "https://bt.sg/sia-record-profit", publishedAt: ago(158) },
  { title: "Singtel Surges 6% After Announcing S$2B Share Buyback and Optus Sale Completion", summary: "Singtel shares jumped 6% after the company completed the sale of a 10% stake in Optus for A$1.8B and announced a S$2B share buyback programme. The capital return comes alongside strong Airtel India performance, which contributed S$890M in equity income for the year.", source: "Business Times", sourceMkt: "stocks", url: "https://bt.sg/singtel-buyback", publishedAt: ago(175) },

  // ── ASX (AUSTRALIA) ────────────────────────────────────────────────────────
  { title: "BHP Iron Ore Shipments Hit Record 76Mt in Q1; Dividend Yield Attracts Institutional Buying", summary: "BHP Group reported a record Q1 iron ore shipment volume of 76 million tonnes from its Pilbara operations, 4% above consensus. Realised prices averaged US$98/t. The company reaffirmed its full-year guidance and its 6.2% trailing dividend yield is drawing yield-seeking institutional flows.", source: "Reuters AU", sourceMkt: "stocks", url: "https://reuters.com/bhp-q1-iron-ore-record", publishedAt: ago(22) },
  { title: "Commonwealth Bank Raises Dividend 9% to A$2.50 After Record H1 Profit of A$5.4B", summary: "CBA reported record first-half cash profit of A$5.4B, up 7% year-on-year, driven by resilient net interest margins and strong home loan growth. The interim dividend was raised 9% to A$2.50 per share. CEO Matt Comyn guided for continued above-system home lending growth in H2.", source: "AFR Latest", sourceMkt: "stocks", url: "https://afr.com/cba-h1-record-dividend", publishedAt: ago(80) },
  { title: "ASX 200 Breaks 8,400 as Wall Street Gains Spill Over; BHP, RIO, Macquarie Lead", summary: "The ASX 200 cleared the 8,400 level for the first time, extending gains from the US session where the S&P 500 hit a record. Mining heavyweights BHP and Rio Tinto each rose over 2% on higher iron ore futures. Macquarie Group hit a 52-week high after infrastructure asset sales.", source: "SMH Markets AU", sourceMkt: "stocks", url: "https://smh.com.au/asx200-8400-breakout", publishedAt: ago(35) },
  { title: "Fortescue Metals Earnings Beat: Net Profit A$3.1B, Iron Ore Cost Guidance Cut", summary: "Fortescue reported net profit of A$3.1B for H1, beating the A$2.8B consensus. The company cut its C1 iron ore cost guidance to US$17.50–18.50/t from the prior US$18.50–19.50/t range, driven by operational efficiencies at Cloudbreak. CEO Dino Otranto raised the interim dividend to A$1.08.", source: "ABC Business AU", sourceMkt: "stocks", url: "https://abc.net.au/fmg-h1-beat", publishedAt: ago(140) },
  { title: "Rio Tinto Flags A$2.8B Copper Project Approval; CEO Says 'Energy Transition Super-Cycle Underway'", summary: "Rio Tinto's board approved the A$2.8B expansion of the Oyu Tolgoi copper mine in Mongolia, targeting an additional 150,000 tonnes of annual production by 2028. CEO Jakob Stausholm said the company sees a 'structural super-cycle' in copper demand driven by EV and grid electrification.", source: "Reuters AU", sourceMkt: "stocks", url: "https://reuters.com/rio-copper-oyu-tolgoi", publishedAt: ago(190) },
  { title: "Macquarie Group Full-Year Profit Jumps 18% to A$6.1B on Infrastructure and Energy Deals", summary: "Macquarie Group posted full-year net profit of A$6.1B, up 18% YoY, led by its infrastructure asset management division which completed $28B in transactions globally. The board declared a final dividend of A$4.20, taking the full-year payout to A$7.50 — a record.", source: "AFR Latest", sourceMkt: "stocks", url: "https://afr.com/macquarie-fy-record", publishedAt: ago(220) },

  // ── HSI / HONG KONG ────────────────────────────────────────────────────────
  { title: "Hang Seng Surges 4.2% on China's A$1.2 Trillion Stimulus Package; Tencent, Alibaba Lead", summary: "The Hang Seng Index surged 4.2% to 24,880 after Beijing unveiled a 6 trillion yuan ($1.2 trillion) stimulus package combining infrastructure spending and tech sector subsidies. Tencent rose 7.1%, Alibaba HK climbed 8.4%. Analysts at Goldman called it 'the stimulus the market was waiting for.'", source: "SCMP Business", sourceMkt: "stocks", url: "https://scmp.com/hsi-china-stimulus-surge", publishedAt: ago(14) },
  { title: "Tencent Q1 Earnings Beat: Revenue Up 11%, WeChat AI Features Drive Advertising Growth 21%", summary: "Tencent Holdings (0700.HK) reported Q1 revenue of RMB 175.1B, up 11% YoY, beating estimates of RMB 168B. WeChat's AI-powered advertising tools drove a 21% jump in marketing revenue to RMB 31.4B. Gaming revenue grew 6%. The company announced a HK$40B share buyback expansion.", source: "SCMP Business", sourceMkt: "stocks", url: "https://scmp.com/tencent-0700-q1-beat", publishedAt: ago(50) },
  { title: "Alibaba HK (9988) Restructuring Delivers: E-Commerce Margins Expand, Cloud Profitable", summary: "Alibaba's restructured business reported improved Q1 results with e-commerce EBITDA margins expanding to 19.4% from 16.2% a year ago. Alibaba Cloud reached profitability for the first time with an EBITDA margin of 8.1%. The stock trades at 11x forward earnings, its cheapest since 2015.", source: "SCMP HK", sourceMkt: "stocks", url: "https://scmp.com/alibaba-9988-restructure-profit", publishedAt: ago(88) },
  { title: "Meituan (3690.HK) Gains 12% as Overseas Food Delivery Expansion Beats Forecast", summary: "Meituan surged 12% after its international food delivery business in Saudi Arabia and Southeast Asia surpassed 1 million daily orders ahead of schedule. Domestic order volume also beat consensus by 8%. Analysts at CLSA raised their 12-month target from HK$140 to HK$178.", source: "SCMP Business", sourceMkt: "stocks", url: "https://scmp.com/meituan-3690-overseas-beat", publishedAt: ago(112) },
  { title: "HSBC Holdings (0005.HK) Raises Dividend 14% After Asia Revenue Tops $10B for First Time", summary: "HSBC reported Asia revenue exceeding $10B in a quarter for the first time, driven by strong wealth management inflows and trade finance in Hong Kong and Singapore. The bank raised its quarterly dividend 14% to $0.16 per share and announced a $3B buyback. Shares hit a 5-year high.", source: "Reuters Asia", sourceMkt: "stocks", url: "https://reuters.com/hsbc-0005-asia-record", publishedAt: ago(155) },
  { title: "JD.com (9618.HK) Insider Buying: Chairman Richard Liu Purchases HK$1.4B in Stock", summary: "JD.com Chairman Richard Liu purchased 18 million shares worth approximately HK$1.4B on the open market over five trading sessions, according to HK Stock Exchange filings. The purchases were made at prices between HK$76 and HK$80 per share — the largest insider buy since JD's HK listing.", source: "SCMP HK", sourceMkt: "stocks", url: "https://scmp.com/jd-9618-insider-buy", publishedAt: ago(178) },

  // ── ADDITIONAL SWING-SIGNAL ARTICLES ──────────────────────────────────────
  { title: "Short Interest in Tesla Reaches 18-Month High at $16B — Largest Short Position on Record", summary: "Tesla bears have accumulated $16B in short positions, the largest on record, ahead of the next quarterly deliveries report. Short interest represents 4.9% of the float. Options market shows elevated put buying, with the 30-day implied volatility at 62%.", source: "CNBC Markets", sourceMkt: "stocks", url: "https://cnbc.com/tsla-short-interest", publishedAt: ago(200) },
  { title: "Insider Buying Alert: PLTR CEO Alex Karp Buys $12M in Shares at Open Market", summary: "SEC Form 4 filings show Palantir CEO Alex Karp purchased 150,000 shares at an average of $80.20, totalling approximately $12M, in open-market transactions over three days. Insider buying at this scale is typically considered a strong bullish signal by market practitioners.", source: "MarketWatch", sourceMkt: "stocks", url: "https://marketwatch.com/pltr-insider-buy", publishedAt: ago(215) },
  { title: "NVDA Options Activity Explodes: $2B in Calls Bought Ahead of Earnings — Largest Ever", summary: "Nvidia options activity reached a historic level with $2B in call options purchased in the three sessions prior to earnings, the largest pre-earnings options buy in market history. The most popular strike is the $1,200 call expiring next Friday. IV crush risk is extreme post-earnings.", source: "MarketWatch", sourceMkt: "stocks", url: "https://marketwatch.com/nvda-options-record", publishedAt: ago(232) },
  { title: "BTC Technical: Golden Cross Forms on Weekly Chart — Historically Signals 40%+ Rally", summary: "Bitcoin's 50-week moving average crossed above the 200-week moving average for the first time since November 2023, forming a 'Golden Cross' on the weekly chart. This pattern preceded 40%+ rallies in all previous occurrences (2019, 2020, 2023). Current price: $103,800.", source: "CoinDesk", sourceMkt: "crypto", url: "https://coindesk.com/btc-golden-cross", publishedAt: ago(248) },
  { title: "Secondary Offering: Rivian Prices $1.2B Stock Sale at $12.40, Shares Fall 8%", summary: "Rivian priced a $1.2B secondary share offering at $12.40 per share, a 7% discount to the prior day's close. The company said proceeds will fund Volkswagen joint venture ramp-up costs. Shares fell 8% on the dilution announcement, bringing RIVN's YTD decline to -32%.", source: "Reuters Business", sourceMkt: "stocks", url: "https://reuters.com/rivn-secondary", publishedAt: ago(263) },
];

const DRIP_QUEUE = [
  { title: "Bitcoin Spot ETF Net Inflows Hit $420M Today — BlackRock IBIT Leads", summary: "Spot Bitcoin ETF net inflows reached $420M on Friday, led by BlackRock's IBIT with $238M. Total US spot BTC ETF AUM now stands at $112B. The sustained inflow pace continues to compress available spot BTC supply on exchanges.", source: "CoinDesk", sourceMkt: "crypto", url: "https://coindesk.com/btc-etf-inflow-420m", publishedAt: null },
  { title: "FOMC: Fed Holds Rates at 4.25%-4.5%, Dots Show Two Cuts in 2026", summary: "The Federal Open Market Committee voted unanimously to hold rates at 4.25%-4.5%. The updated dot plot shows the median expectation of two 25bp cuts in 2026, both in H2. Chair Powell noted the labour market remains 'robust' but inflation progress is 'encouraging.'", source: "CNBC", sourceMkt: "general", url: "https://cnbc.com/fomc-hold-dots-2026", publishedAt: null },
  { title: "Gold Futures Hit New Record $3,450 Intraday — Geopolitical Risk Premium Expanding", summary: "COMEX gold futures briefly touched $3,450/oz intraday before settling at $3,428. Analysts attribute the move to escalating Middle East tensions and accelerating central bank diversification away from dollar-denominated assets. WGC data shows 1,136 tonnes of central bank buying in 2025.", source: "Investing.com", sourceMkt: "commodities", url: "https://investing.com/gold-3450", publishedAt: null },
  { title: "Nvidia H200 GPU Backlog Extends to 18 Months — Supply Crunch Deepens", summary: "Industry sources tell CNBC that Nvidia H200 GPU delivery times have extended to 18 months, up from 12 months in Q4 2025. TSMC's CoWoS packaging capacity, a critical bottleneck, is fully allocated through 2027. AMD sees opportunity with MI400 ramp-up but supply is also constrained.", source: "CNBC Markets", sourceMkt: "stocks", url: "https://cnbc.com/nvda-h200-backlog", publishedAt: null },
  { title: "EUR/USD Drops to 1.1180 as German Retail Sales Miss; Eurozone Growth Doubts Return", summary: "The euro pulled back to 1.1180 after German retail sales contracted 0.8% in April, well below the +0.3% forecast. Weak consumer spending in the eurozone's largest economy raises doubts about ECB's forecast of a 2026 growth rebound. EUR/USD support seen at 1.1100.", source: "ForexLive", sourceMkt: "forex", url: "https://forexlive.com/eurusd-german-retail", publishedAt: null },
  { title: "Tesla Cybertruck Production Ramp: 1,200 Units/Week Achieved, On Track for 2026 Target", summary: "Tesla confirmed Cybertruck production hit 1,200 units per week at Gigafactory Texas, on a run-rate to meet the 80,000-unit 2026 delivery target. Gross margin for Cybertruck is now positive for the first time at 8.4%. Backlog stands at 180,000 reservations.", source: "Reuters Business", sourceMkt: "stocks", url: "https://reuters.com/tsla-cybertruck-ramp", publishedAt: null },
  { title: "Ethereum Layer-2 Ecosystem Hits $35B TVL — Base, Arbitrum, Optimism Lead", summary: "The combined TVL across all Ethereum Layer-2 networks surpassed $35B for the first time. Coinbase's Base leads with $12.4B, followed by Arbitrum ($9.8B) and Optimism ($7.2B). Lower fees and faster settlement are attracting DeFi activity away from Ethereum mainnet.", source: "Decrypt", sourceMkt: "crypto", url: "https://decrypt.co/eth-l2-35b", publishedAt: null },
  { title: "WTI Oil Rebounds to $76.80 as US Strategic Reserve Drawdown Halted", summary: "WTI crude recovered to $76.80/barrel after the US Department of Energy announced it would pause Strategic Petroleum Reserve sales, removing a key source of supply overhang. OPEC+ compliance reportedly improved to 94% according to secondary source data.", source: "Reuters Business", sourceMkt: "commodities", url: "https://reuters.com/wti-spr-halt", publishedAt: null },

  // ── ASX DRIP ───────────────────────────────────────────────────────────────
  { title: "ANZ Bank Earnings Beat: Cash Profit A$3.7B, Raises Dividend to A$0.86", summary: "ANZ Banking Group posted H1 cash profit of A$3.7B, ahead of the A$3.4B consensus, supported by improving credit quality in its institutional division and an uptick in retail mortgage market share. CEO Shayne Elliott raised the interim dividend to A$0.86 per share, an 8% increase.", source: "Reuters AU", sourceMkt: "stocks", url: "https://reuters.com/anz-h1-earnings-beat", publishedAt: null },
  { title: "Woolworths Upgrade: Analysts Raise Target on AI-Driven Inventory Win; Margin Beats", summary: "Multiple brokers upgraded Woolworths Group to Buy after Q3 like-for-like sales growth of 4.2% exceeded forecasts. AI-powered inventory management reduced food waste costs by A$180M annually. Macquarie raised its 12-month target to A$38.50, implying 14% upside.", source: "Motley Fool AU", sourceMkt: "stocks", url: "https://fool.com.au/wow-upgrade-target", publishedAt: null },
  { title: "CSL Limited All-Time High: Plasma Collections Surge 18%, FY Guidance Raised", summary: "CSL Limited shares hit a new all-time high of A$352 after the company raised full-year profit guidance by 12%, citing a sustained 18% increase in plasma collection volumes globally. CEO Paul McKenzie said supply normalisation post-COVID has been 'faster than expected.'", source: "ABC Business AU", sourceMkt: "stocks", url: "https://abc.net.au/csl-ath-guidance-raised", publishedAt: null },
  { title: "ASX 200 Falls 1.1% as RBA Holds Rates; Banks Slide on NIM Compression Fears", summary: "The ASX 200 fell 1.1% after the Reserve Bank of Australia held the cash rate at 4.10%, citing persistent services inflation. The big four banks led losses as investors repriced net interest margin compression risk. CBA fell 2.1%, NAB dropped 1.9%, ANZ lost 1.7%.", source: "SMH Markets AU", sourceMkt: "stocks", url: "https://smh.com.au/asx200-rba-hold-decline", publishedAt: null },
  { title: "BHP-Woodside Merger Talks: Bloomberg Reports Preliminary Discussions on Energy Spinoff", summary: "Bloomberg reported BHP Group and Woodside Energy held preliminary discussions on a potential merger of BHP's oil & gas assets with Woodside, which would create Australia's largest integrated energy company. BHP shares rose 3.4% on the report while Woodside gained 6.1%.", source: "Reuters AU", sourceMkt: "stocks", url: "https://reuters.com/bhp-woodside-merger-talks", publishedAt: null },
  { title: "Westpac Insider Buy: CEO Anthony Miller Purchases A$2.1M of WBC Shares on Market", summary: "Westpac CEO Anthony Miller bought A$2.1M of Westpac shares on the open market at A$27.80, the largest CEO insider purchase since 2019. The buy comes ahead of the company's H1 results next month and signals management confidence in the bank's earnings trajectory.", source: "AFR Latest", sourceMkt: "stocks", url: "https://afr.com/wbc-ceo-insider-buy", publishedAt: null },

  // ── HSI / HK DRIP ──────────────────────────────────────────────────────────
  { title: "Ping An Insurance (2318.HK) Beats Estimates: Investment Returns Surge 22% on A-Share Rally", summary: "Ping An Insurance reported Q1 net profit of RMB 39.2B, up 15% YoY and 8% above consensus. Investment returns jumped 22% as the company benefited from the mainland A-share market rally. The board approved an interim dividend of RMB 0.93 per share. Stock rose 5.8%.", source: "SCMP Business", sourceMkt: "stocks", url: "https://scmp.com/ping-an-2318-q1-beat", publishedAt: null },
  { title: "Hang Seng Breaks 25,000 for First Time in 3 Years on Policy Pivot Optimism", summary: "Hong Kong's Hang Seng Index crossed 25,000 for the first time since 2021, driven by a series of PBOC policy easing measures and optimism over US-China trade talks. Daily turnover hit HK$280B, the highest since March 2021. Southbound flow from mainland investors reached HK$18.4B.", source: "RTHK News HK", sourceMkt: "stocks", url: "https://rthk.hk/hsi-25000-milestone", publishedAt: null },
  { title: "ICBC (1398.HK) Guidance Raised: NIM Stabilises, Dividend Yield Hits 7.1%", summary: "Industrial and Commercial Bank of China (ICBC) raised its full-year earnings guidance after net interest margin stabilised at 1.48% — better than the feared 1.40%. At current prices the stock yields 7.1%, attracting dividend-focused institutional investors. ICBC shares hit a 52-week high.", source: "Reuters Asia", sourceMkt: "stocks", url: "https://reuters.com/icbc-1398-guidance-raised", publishedAt: null },
  { title: "AIA Group (1299.HK) Reports 14% VONB Growth; New Business Value Beats Forecast", summary: "AIA Group reported 14% growth in Value of New Business (VONB) for Q1, ahead of the 9% consensus estimate, driven by strong sales of unit-linked and protection products in China and Thailand. CEO Lee Yuan Siong said mainland China VONB doubled year-on-year. Shares rose 6.3%.", source: "SCMP HK", sourceMkt: "stocks", url: "https://scmp.com/aia-1299-vonb-beat", publishedAt: null },
];

let dripIndex = 0;
let dripCycle = 0;
function nextDrip() {
  if (dripIndex >= DRIP_QUEUE.length) { dripIndex = 0; dripCycle++; }
  const a = { ...DRIP_QUEUE[dripIndex++] };
  a.publishedAt = new Date().toISOString();
  // Include cycle so each pass gets a fresh unique ID and passes the seenUrls check
  a.id = `${a.url}#c${dripCycle}`;
  return a;
}

// ─── Market Sessions & Brief Generation ──────────────────────────────────────
const EXCHANGES = [
  { id: 'NYSE',     name: 'NYSE/NASDAQ', tz: 'America/New_York',  open: [9,30],  close: [16,0],  icon: '🇺🇸', color: '#00d4ff' },
  { id: 'SGX',      name: 'SGX',         tz: 'Asia/Singapore',    open: [9,0],   close: [17,30], icon: '🇸🇬', color: '#ff9500' },
  { id: 'LSE',      name: 'LSE',         tz: 'Europe/London',     open: [8,0],   close: [16,30], icon: '🇬🇧', color: '#aa88ff' },
  { id: 'TSE',      name: 'Nikkei/TSE',  tz: 'Asia/Tokyo',        open: [9,0],   close: [15,30], icon: '🇯🇵', color: '#ff6b6b' },
  { id: 'HKEX',     name: 'HKEX',        tz: 'Asia/Hong_Kong',    open: [9,30],  close: [16,0],  icon: '🇭🇰', color: '#ffd700' },
  { id: 'ASX',      name: 'ASX',         tz: 'Australia/Sydney',  open: [10,0],  close: [16,0],  icon: '🇦🇺', color: '#00e676' },
  { id: 'EURONEXT', name: 'Euronext/DAX',tz: 'Europe/Paris',      open: [9,0],   close: [17,30], icon: '🇪🇺', color: '#aa88ff' },
  { id: 'CRYPTO',   name: 'Crypto',      tz: 'UTC',               open: [0,0],   close: [24,0],  icon: '₿',   color: '#ffd700', always: true },
  { id: 'FOREX',    name: 'FX',          tz: 'UTC',               open: [0,0],   close: [24,0],  icon: '💱',  color: '#00e676', forexClosed: true },
];

function getExchangeLocalTime(now, tz) {
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
    const closedPeriod = (utcDay === 6) || (utcDay === 5 && utcHour >= 22) || (utcDay === 0 && utcHour < 22);
    return { open: !closedPeriod, label: closedPeriod ? 'Weekend Close' : '24h FX' };
  }
  const local = getExchangeLocalTime(now, ex.tz);
  if (local.isWeekend) return { open: false, label: 'Weekend' };
  const mins = local.hour * 60 + local.minute;
  const openMins  = ex.open[0]  * 60 + ex.open[1];
  const closeMins = ex.close[0] * 60 + ex.close[1];
  const open = mins >= openMins && mins < closeMins;
  const preMarket = !open && mins >= openMins - 90 && mins < openMins;
  const label = preMarket ? 'Pre-Market' : open ? 'Open' : (mins < openMins ? 'Pre-Market' : 'Closed');
  return { open, preMarket, label };
}

function getSessionContext(now) {
  const utcH = now.getUTCHours();
  const utcDay = now.getUTCDay();
  const isWknd = utcDay === 0 || utcDay === 6;

  if (isWknd) return { name: 'Weekend', emoji: '🌙', desc: 'Markets closed · Crypto & FX active · Plan your week' };
  if (utcH >= 22 || utcH < 3)  return { name: 'Sydney / Tokyo Open',   emoji: '🌏', desc: 'Asia-Pacific session opening · SGX pre-market soon' };
  if (utcH >= 1  && utcH < 9)  return { name: 'Asia Session',           emoji: '🌏', desc: 'SGX · HKEX · TSE active · European pre-market building' };
  if (utcH >= 7  && utcH < 9)  return { name: 'European Pre-Market',    emoji: '🌍', desc: 'LSE & Euronext opening · US futures watch' };
  if (utcH >= 8  && utcH < 13) return { name: 'European Session',       emoji: '🌍', desc: 'LSE · Euronext · DAX active · US market opening soon' };
  if (utcH >= 13 && utcH < 14) return { name: 'US Pre-Market / London', emoji: '⚡', desc: 'High volatility window · US futures + Europe overlap' };
  if (utcH >= 14 && utcH < 20) return { name: 'US Session 🔥',          emoji: '🔥', desc: 'NYSE · NASDAQ live · Peak liquidity window' };
  if (utcH >= 20 && utcH < 21) return { name: 'US Market Close',        emoji: '🔔', desc: 'Final hour volatility · Watch for MOC orders' };
  if (utcH >= 21 && utcH < 22) return { name: 'US After-Hours',         emoji: '🌆', desc: 'AH earnings reaction · Lower liquidity' };
  return { name: 'Inter-Session', emoji: '🌙', desc: 'Quiet period · Review positions · Plan next move' };
}

const SIGNAL_PLAYS = {
  'earnings':           { dir: 'LONG',  upMin: 5,  upMax: 12, stars: 5, tag: 'EARNINGS BEAT', note: 'Buy gap-open pullback. Set 2hr exit alert.' },
  'eps beat':           { dir: 'LONG',  upMin: 4,  upMax: 10, stars: 5, tag: 'EPS BEAT',      note: 'Buy VWAP dip at open. 2hr target, then exit.' },
  'beats estimates':    { dir: 'LONG',  upMin: 4,  upMax: 9,  stars: 5, tag: 'BEAT ESTIMATE', note: 'Momentum entry at open. Exit within 2hrs.' },
  'guidance raised':    { dir: 'LONG',  upMin: 5,  upMax: 12, stars: 5, tag: 'GUIDANCE ▲',    note: 'Strongest signal. Buy premarket, exit 2hrs after open.' },
  'upgrade':            { dir: 'LONG',  upMin: 3,  upMax: 7,  stars: 4, tag: 'ANALYST UPGRADE',note: 'Buy at open. 2hr window captures initial surge.' },
  'price target':       { dir: 'LONG',  upMin: 2,  upMax: 6,  stars: 4, tag: 'PT RAISED',     note: 'Enter on volume spike. 2hr momentum play.' },
  'all-time high':      { dir: 'LONG',  upMin: 2,  upMax: 5,  stars: 4, tag: 'ATH BREAKOUT',  note: 'No overhead resistance. Ride 2hr momentum.' },
  'breakout':           { dir: 'LONG',  upMin: 3,  upMax: 7,  stars: 4, tag: 'BREAKOUT',      note: 'Enter on volume confirmation. 2hr hold max.' },
  'short squeeze':      { dir: 'LONG',  upMin: 10, upMax: 30, stars: 5, tag: '⚡ SHORT SQUEEZE',note: 'Fast 2hr move. Size small — extreme volatility.' },
  'insider buying':     { dir: 'LONG',  upMin: 3,  upMax: 8,  stars: 5, tag: '🔍 INSIDER BUY', note: 'CEO/Director buy = highest conviction. Enter early.' },
  'merger':             { dir: 'LONG',  upMin: 15, upMax: 40, stars: 5, tag: 'M&A',           note: 'Buy target at open, 2hr spike to deal price.' },
  'acquisition':        { dir: 'LONG',  upMin: 15, upMax: 40, stars: 5, tag: 'ACQUISITION',   note: 'Gap to bid price within 2hrs. Buy at discount.' },
  'deal':               { dir: 'LONG',  upMin: 4,  upMax: 12, stars: 4, tag: 'MAJOR DEAL',    note: 'Revenue catalyst. 2hr entry on the news pop.' },
  'buyback':            { dir: 'LONG',  upMin: 2,  upMax: 6,  stars: 3, tag: 'BUYBACK',       note: '2hr momentum pop on buyback announcement.' },
  'dividend':           { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'DIVIDEND',      note: 'Modest 2hr lift. Defensive intraday play.' },
  'misses estimates':   { dir: 'SHORT', upMin: 4,  upMax: 10, stars: 4, tag: '🔴 MISS',        note: 'Short any gap-up open. 2hr downside target.' },
  'guidance lowered':   { dir: 'SHORT', upMin: 6,  upMax: 15, stars: 5, tag: '🔴 GUIDE DOWN',  note: 'Strongest short. Sell at open, cover 2hrs later.' },
  'downgrade':          { dir: 'SHORT', upMin: 3,  upMax: 7,  stars: 4, tag: '🔴 DOWNGRADE',   note: 'Sell rallies in 2hr window.' },
  'insider selling':    { dir: 'SHORT', upMin: 2,  upMax: 5,  stars: 3, tag: '🔴 INSIDER SELL',note: 'Check Form 4 size. Short on volume confirmation.' },
  'secondary offering': { dir: 'SHORT', upMin: 5,  upMax: 10, stars: 4, tag: '🔴 DILUTION',    note: 'Discount to market = 2hr selling pressure.' },
  'short interest':     { dir: 'SHORT', upMin: 3,  upMax: 8,  stars: 3, tag: '🔴 HIGH SHORT',  note: 'High short = squeeze or cascade. Read the macro.' },
  'opec':               { dir: 'SHORT', upMin: 2,  upMax: 5,  stars: 4, tag: 'OPEC SUPPLY',   note: 'Output hike = 2hr crude sell. Short OIL/XOM/CVX.' },
  'rate cut':           { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'RATE CUT',      note: '2hr risk-on. Growth stocks, gold, crypto lift.' },
  'rate hike':          { dir: 'SHORT', upMin: 1,  upMax: 3,  stars: 3, tag: 'RATE HIKE',     note: '2hr pressure on growth/tech.' },
  'cpi':                { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'CPI COOL',      note: 'Dovish pivot. 2hr risk-on trade.' },
  'jobs report':        { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'JOBS DATA',     note: 'Strong jobs = soft landing. 2hr equity/crypto bid.' },
  'nonfarm payroll':    { dir: 'LONG',  upMin: 1,  upMax: 3,  stars: 3, tag: 'NFP',           note: 'Cool wage growth = bullish. 2hr momentum.' },
  'gdp':                { dir: 'LONG',  upMin: 1,  upMax: 2,  stars: 2, tag: 'GDP',           note: 'Upward revision = 2hr confidence bounce.' },
  'resistance':         { dir: 'LONG',  upMin: 2,  upMax: 5,  stars: 4, tag: 'RESISTANCE BREAK', note: 'Level cleared. 2hr ride to next resistance.' },
  'support':            { dir: 'LONG',  upMin: 1,  upMax: 4,  stars: 3, tag: 'SUPPORT HOLD',  note: 'Risk-defined 2hr bounce from key level.' },
  'ipo':                { dir: 'LONG',  upMin: 5,  upMax: 20, stars: 3, tag: 'IPO',           note: 'First 2hr pop possible. Size small, wide spreads.' },
};

const PRIORITY_SIGNALS = ['guidance raised','earnings','eps beat','beats estimates','short squeeze','merger','acquisition','insider buying','guidance lowered','all-time high','breakout','upgrade'];

let _tickerDB = {};
function setTickerDB(db) { _tickerDB = db; }

const TITLE_TICKER_MAP = {
  'bitcoin': 'BTC', 'btc': 'BTC', 'ethereum': 'ETH', 'solana': 'SOL',
  'ripple': 'XRP', 'xrp': 'XRP', 'dogecoin': 'DOGE', 'binance': 'BNB',
  'gold': 'GOLD', 'silver': 'SILVER', 'crude oil': 'OIL', 'wti': 'OIL',
  'brent': 'BRENT', 'natural gas': 'NATGAS', 'copper': 'COPPER',
  's&p 500': 'SPX', 'sp500': 'SPX', 'nasdaq': 'NDX', 'dow jones': 'DJI',
  'vix': 'VIX', 'nikkei': 'N225', 'hang seng': 'HSI', 'dax': 'DAX',
  'eur/usd': 'EURUSD', 'eurusd': 'EURUSD', 'usd/jpy': 'USDJPY',
  'gbp/usd': 'GBPUSD', 'aud/usd': 'AUDUSD', 'dollar index': 'DXY',
  'dxy': 'DXY',
  'nvidia': 'NVDA', 'apple': 'AAPL', 'microsoft': 'MSFT', 'tesla': 'TSLA',
  'amazon': 'AMZN', 'meta': 'META', 'google': 'GOOGL', 'alphabet': 'GOOGL',
  'amd': 'AMD', 'intel': 'INTC', 'palantir': 'PLTR', 'coinbase': 'COIN',
  'goldman sachs': 'GS', 'jpmorgan': 'JPM', 'boeing': 'BA', 'rivian': 'RIVN',
  'eli lilly': 'LLY', 'moderna': 'MRNA', 'pfizer': 'PFE',
  'dbs bank': 'D05', 'singapore airlines': 'C6L', 'singtel': 'Z74',
  'opec': 'OIL',
  // ASX
  'bhp': 'BHP', 'bhp group': 'BHP', 'commonwealth bank': 'CBA', 'commbank': 'CBA',
  'csl limited': 'CSL', 'rio tinto': 'RIO', 'anz bank': 'ANZ', 'anz banking': 'ANZ',
  'national australia bank': 'NAB', 'nab bank': 'NAB', 'westpac': 'WBC',
  'woolworths': 'WOW', 'macquarie group': 'MQG', 'macquarie': 'MQG',
  'fortescue': 'FMG', 'fortescue metals': 'FMG', 'andrew forrest': 'FMG',
  'asx 200': 'ASX200', 'asx200': 'ASX200',
  // HKEX
  'tencent': '0700', 'wechat': '0700', 'pony ma': '0700',
  'alibaba': '9988', 'taobao': '9988', 'tmall': '9988',
  'hsbc': '0005', 'hsbc holdings': '0005',
  'aia group': '1299', 'aia insurance': '1299',
  'meituan': '3690', 'wang xing': '3690',
  'jd.com': '9618', 'richard liu': '9618',
  'ping an': '2318', 'ping an insurance': '2318',
  'icbc': '1398', 'hang seng': 'HSI',
};

function extractTickerFromArticle(article) {
  if (article.matches && article.matches.length > 0) {
    return article.matches.map(m => m.ticker);
  }
  const titleLow = (article.title   || '').toLowerCase();
  const summLow  = (article.summary || '').toLowerCase();
  const combined = titleLow + ' ' + summLow;

  const found = [];
  for (const [kw, sym] of Object.entries(TITLE_TICKER_MAP)) {
    if (combined.includes(kw) && !found.includes(sym)) found.push(sym);
  }
  if (found.length) return found.slice(0, 3);

  const dollarMatch = article.title.match(/\$([A-Z]{2,5})\b/g);
  if (dollarMatch) {
    const valid = dollarMatch.map(m => m.slice(1)).filter(t => _tickerDB[t]);
    if (valid.length) return valid.slice(0, 2);
  }

  const upperMatch = article.title.match(/\b([A-Z]{2,5})\b/g) || [];
  const dbMatch = upperMatch.filter(t => _tickerDB[t]);
  if (dbMatch.length) return dbMatch.slice(0, 2);

  return ['MKT'];
}

function getSentimentFromTitle(title) {
  const t = title.toLowerCase();
  const bearWords = ['falls','drops','tumbles','slides','sinks','miss','misses','warning','cut','lose','loss','plunges','slumps','declines'];
  const bullWords = ['surges','rises','jumps','rallies','beats','record','gains','upgrades','higher','tops','breaks','hits'];
  const bull = bullWords.filter(w => t.includes(w)).length;
  const bear = bearWords.filter(w => t.includes(w)).length;
  return bull > bear ? 'bull' : bear > bull ? 'bear' : 'neutral';
}

function generatePlay(article) {
  const signals = article.swingSignals || [];
  if (!signals.length) return null;

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
    for (const sig of signals) {
      if (SIGNAL_PLAYS[sig]) { bestSignal = sig; bestPlay = SIGNAL_PLAYS[sig]; break; }
    }
  }
  if (!bestPlay) return null;

  const sentiment = getSentimentFromTitle(article.title);
  let dir = bestPlay.dir;
  if (sentiment === 'bear' && dir === 'LONG') dir = 'SHORT';
  if (sentiment === 'bull' && dir === 'SHORT') dir = 'LONG';

  const sigBoost = Math.min(signals.length - 1, 3) * 1.5;
  const upMin = (bestPlay.upMin + sigBoost).toFixed(1);
  const upMax = (bestPlay.upMax + sigBoost * 1.5).toFixed(1);
  const stars = Math.min(5, bestPlay.stars + (signals.length > 2 ? 1 : 0));

  const tickers = extractTickerFromArticle(article);

  const primaryTicker = tickers[0] || '—';
  return {
    ticker:    primaryTicker,
    exchange:  TICKER_DB[primaryTicker]?.exchange || '',
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

function getPrimaryMarket(now) {
  const sgtH = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', hour: 'numeric', hour12: false,
  }).format(now));
  if (sgtH >= 20) return 'us';
  if (sgtH >= 9)  return 'hk_sg';
  return 'au';
}

const PRIMARY_EXCHANGES = {
  us:    ['NYSE', 'NASDAQ'],
  hk_sg: ['HKEX', 'SGX'],
  au:    ['ASX'],
};

function generateBrief(articles, tz) {
  const now = new Date();
  const cutoff24h = new Date(now.getTime() - 24 * 3600 * 1000);

  const recent = articles
    .filter(a => new Date(a.publishedAt) >= cutoff24h)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const marketStatus = EXCHANGES.map(ex => ({
    ...ex,
    status: getMarketStatus(ex, now),
  }));

  const session = getSessionContext(now);
  const primaryMarket = getPrimaryMarket(now);
  const priorityExchanges = PRIMARY_EXCHANGES[primaryMarket] || [];

  const macroSignals = ['cpi', 'rate cut', 'rate hike', 'jobs report', 'nonfarm payroll', 'gdp', 'federal reserve', 'interest rate'];
  const macroArticles = recent.filter(a =>
    (a.swingSignals || []).some(s => macroSignals.includes(s))
  ).slice(0, 4);

  const swingArticles = recent.filter(a => a.isSwingRelevant);
  const rawPlays = swingArticles.map(a => generatePlay(a)).filter(Boolean);

  // Allow up to 2 plays per ticker (top 2 by stars)
  const playMap = {};
  for (const p of rawPlays) {
    const key = p.ticker;
    if (!playMap[key]) playMap[key] = [];
    playMap[key].push(p);
    playMap[key].sort((a, b) => b.stars - a.stars);
    if (playMap[key].length > 2) playMap[key].pop();
  }

  // Sort: primary-market tickers first, then by stars
  const allPlays = Object.values(playMap).flat().sort((a, b) => {
    const ap = priorityExchanges.includes(a.exchange) ? 1 : 0;
    const bp = priorityExchanges.includes(b.exchange) ? 1 : 0;
    if (bp !== ap) return bp - ap;
    return b.stars - a.stars || parseFloat(b.upMax) - parseFloat(a.upMax);
  });

  const longs  = allPlays.filter(p => p.direction === 'LONG').slice(0, 10);
  const shorts = allPlays.filter(p => p.direction === 'SHORT').slice(0, 6);

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
    primaryMarket,
    primaryExchanges: priorityExchanges,
    macroBackdrop: macroKeyPoints,
    longs,
    shorts,
    articleCount:  recent.length,
    totalArticles: articles.length,
    nextRefresh:   new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
  };
}

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

  // ── ASX / AUSTRALIA ────────────────────────────────────────────────────────
  { url: 'https://feeds.reuters.com/reuters/australiaNews',                     name: 'Reuters AU',      market: 'stocks'     },
  { url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                      name: 'ABC Business AU', market: 'stocks'     },
  { url: 'https://www.smh.com.au/rss/business/markets.xml',                     name: 'SMH Markets AU',  market: 'stocks'     },
  { url: 'https://www.afr.com/rss/latest',                                      name: 'AFR Latest',      market: 'stocks'     },
  { url: 'https://www.fool.com.au/feed/',                                        name: 'Motley Fool AU',  market: 'stocks'     },

  // ── HSI / HONG KONG / CHINA ────────────────────────────────────────────────
  { url: 'https://feeds.reuters.com/reuters/asianews',                          name: 'Reuters Asia',    market: 'stocks'     },
  { url: 'https://www.scmp.com/rss/91/feed',                                    name: 'SCMP Business',   market: 'stocks'     },
  { url: 'https://www.scmp.com/rss/4/feed',                                     name: 'SCMP HK',         market: 'stocks'     },
  { url: 'https://rthk.hk/rthk/news/rss/e_expressnews_elocalnews.xml',         name: 'RTHK News HK',    market: 'general'    },
  { url: 'https://www.investing.com/rss/news_135.rss',                          name: 'Investing HK',    market: 'stocks'     },
];

// ─── State ────────────────────────────────────────────────────────────────────
let articles  = [];
let seenUrls  = new Set();
let watchlist = [];
let customTickers = {};

function loadData() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    watchlist = Array.isArray(d.watchlist) ? d.watchlist : [];
    customTickers = d.customTickers || {};
    for (const [sym, info] of Object.entries(customTickers)) {
      TICKER_DB[sym] = info;
    }
  } catch {
    watchlist = [];
    customTickers = {};
  }
}

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ watchlist, customTickers }, null, 2));
}

loadData();

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

  const symRe = new RegExp(`(?<![a-zA-Z])${ticker.replace('/', '\\/')}(?![a-zA-Z])`, 'i');
  if (symRe.test(article.title))        { score += 120; matchType = 'direct'; }
  else if (symRe.test(article.summary)) { score += 80;  matchType = 'direct'; }

  const nameL = db.name.toLowerCase();
  if (titleLower.includes(nameL))        { score += 100; matchType = 'direct'; }
  else if (summaryLower.includes(nameL)) { score += 65;  if (!matchType) matchType = 'direct'; }

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

  if (seenUrls.size > 10000) {
    const arr = [...seenUrls].slice(-5000);
    seenUrls = new Set(arr);
  }

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
    saveData();
    articles = articles.map(a => processArticle({ ...a, matches: undefined, matchType: undefined, swingSignals: undefined, isSwingRelevant: undefined })).filter(Boolean);
    broadcast({ type: 'refresh', data: articles.slice(0, 150) });
  }
  res.json({ ok: true, ticker: t, info: TICKER_DB[t] });
});

app.delete('/api/watchlist/:ticker', (req, res) => {
  const t = req.params.ticker.toUpperCase();
  watchlist = watchlist.filter(x => x !== t);
  saveData();
  articles = articles.map(a => processArticle({ ...a, matches: undefined, matchType: undefined, swingSignals: undefined, isSwingRelevant: undefined })).filter(Boolean);
  broadcast({ type: 'refresh', data: articles.slice(0, 150) });
  res.json({ ok: true });
});

app.post('/api/tickers/custom', (req, res) => {
  const { ticker, name, market, exchange } = req.body;
  if (!ticker || !name || !market) return res.status(400).json({ error: 'ticker, name, market required' });
  const t = ticker.toUpperCase();
  const entry = {
    name,
    market,
    exchange: exchange || '',
    terms: [name.toLowerCase(), t.toLowerCase()],
  };
  TICKER_DB[t] = entry;
  customTickers[t] = entry;
  saveData();
  res.json({ ok: true, ticker: t, info: entry });
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

app.get('/api/brief', (req, res) => {
  const tz = req.query.tz || 'UTC';
  res.json(generateBrief(articles, tz));
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
  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  console.log(`[SEED] ${articles.length} articles ready`);
}

function drip() {
  const raw = nextDrip();
  if (seenUrls.has(raw.id)) return;
  seenUrls.add(raw.id);
  const processed = processArticle(raw);
  if (processed) {
    articles.unshift(processed);
    if (articles.length > MAX_ARTICLES) articles = articles.slice(0, MAX_ARTICLES);
    console.log(`[DRIP] ${raw.title.slice(0, 60)}…`);
    broadcast({ type: 'new_articles', data: [processed] });
  }
}

function startDripSimulation() {
  // Burst: push a few articles quickly after boot so the feed feels live immediately
  [5, 20, 45, 90, 150].forEach(s => setTimeout(drip, s * 1000));
  // Then sustain one article per minute continuously
  setInterval(drip, 60 * 1000);
}

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀  MarketPulse running → http://localhost:${PORT}\n`);
  setTickerDB(TICKER_DB);
  loadSeedData();
  startDripSimulation();
  pollFeeds();
  setInterval(pollFeeds, POLL_INTERVAL);
});
