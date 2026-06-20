const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map(); // currency -> { rateToSgd, fetchedAt }

const SUPPORTED_CURRENCIES = ['SGD', 'USD', 'INR', 'RMB'];

// open.er-api.com uses the standard ISO code CNY for Chinese Yuan (RMB).
const ISO_CODE = { RMB: 'CNY' };

async function fetchRateToSgd(currency) {
  if (currency === 'SGD') return 1;

  const cached = cache.get(currency);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.rateToSgd;
  }

  const base = ISO_CODE[currency] || currency;
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
  if (!res.ok) {
    throw new Error(`Exchange rate API request failed with status ${res.status}`);
  }
  const data = await res.json();
  if (data.result !== 'success' || !data.rates || typeof data.rates.SGD !== 'number') {
    throw new Error(`Exchange rate API did not return a usable SGD rate for ${currency}`);
  }

  const rateToSgd = data.rates.SGD;
  cache.set(currency, { rateToSgd, fetchedAt: Date.now() });
  return rateToSgd;
}

module.exports = { fetchRateToSgd, SUPPORTED_CURRENCIES };
