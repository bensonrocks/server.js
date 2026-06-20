const { fetchRateToSgd, SUPPORTED_CURRENCIES } = require('./exchangeRates');

function getMultiplier() {
  return Number(process.env.SELLING_PRICE_MULTIPLIER || 2.4);
}

/**
 * Converts a cost price in any supported currency to an SGD selling price.
 * @param {number} costPrice
 * @param {string} costCurrency
 * @returns {Promise<{ exchangeRate: number, sellingPriceSgd: number }>}
 */
async function computeSellingPriceSgd(costPrice, costCurrency) {
  if (!SUPPORTED_CURRENCIES.includes(costCurrency)) {
    throw new Error(`Unsupported currency: ${costCurrency}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`);
  }
  const exchangeRate = await fetchRateToSgd(costCurrency);
  const costInSgd = costPrice * exchangeRate;
  const sellingPriceSgd = costInSgd * getMultiplier();
  return { exchangeRate, sellingPriceSgd };
}

module.exports = { computeSellingPriceSgd };
