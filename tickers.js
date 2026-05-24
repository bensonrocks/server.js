'use strict';

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
};

module.exports = TICKER_DB;
