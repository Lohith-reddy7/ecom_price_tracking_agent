/**
 * Historical Price Service
 * Fetches authentic original past 180-day price history for e-commerce products
 * (Amazon, Flipkart, etc.) using free public historical price archives.
 */

/**
 * Normalizes e-commerce product URLs for historical archive lookup.
 * @param {string} rawUrl 
 * @returns {string} Clean canonical URL
 */
export const cleanProductUrl = (rawUrl) => {
  if (!rawUrl) return '';

  let cleanUrl = rawUrl.trim();

  // Normalize mobile & redirect Flipkart links
  cleanUrl = cleanUrl
    .replace('://dl.flipkart.com/dlhttp://', '://')
    .replace('://dl.flipkart.com/dlhttps://', '://')
    .replace('//m.flipkart.com/', '//www.flipkart.com/')
    .replace('dl.flipkart.com/dl/', 'www.flipkart.com/');

  // Normalize Amazon links: strip referral tags, keep canonical /dp/ASIN
  cleanUrl = cleanUrl.replace(/\/gp\/aw\/d\//, '/dp/');
  const asinMatch = cleanUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (asinMatch && cleanUrl.toLowerCase().includes('amazon')) {
    const asin = asinMatch[1];
    const isIndia = cleanUrl.toLowerCase().includes('amazon.in');
    const domain = isIndia ? 'amazon.in' : 'amazon.com';
    cleanUrl = `https://www.${domain}/dp/${asin}`;
  }

  return cleanUrl;
};

/**
 * Fetches authentic historical price observations from free public price archives.
 * Decrypts dynamic price dataset and projects continuous daily past prices for up to 180 days.
 * 
 * @param {string} productUrl URL of the product (Amazon, Flipkart, etc.)
 * @param {number|null} currentPrice Current observed price to anchor the latest entry
 * @param {number} days Number of days of historical prices to construct (default: 180)
 * @returns {Promise<Array<{price: number, date: Date}>|null>}
 */
export const fetchOriginalPriceHistory = async (productUrl, currentPrice = null, days = 180) => {
  try {
    const cleanUrl = cleanProductUrl(productUrl);
    if (!cleanUrl) return null;

    console.log(`[Historical Price] Searching authentic past prices for: ${cleanUrl}`);

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/json',
      'Referer': 'https://pricehistory.app/'
    };

    // 1. Search for indexed product code in archive database
    const searchRes = await fetch('https://pricehistory.app/api/search', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: cleanUrl }),
      signal: AbortSignal.timeout(15000)
    });

    if (!searchRes.ok) {
      console.log(`[Historical Price] Archive search returned status ${searchRes.status} for URL`);
      return null;
    }

    const searchData = await searchRes.json();
    if (!searchData?.status || !searchData?.code) {
      console.log(`[Historical Price] Product not indexed in public archive: ${searchData?.message || 'No code'}`);
      return null;
    }

    const code = searchData.code;
    const pageUrl = `https://pricehistory.app/p/${code}`;
    console.log(`[Historical Price] Found archived product code: ${code}`);

    // 2. Fetch archived product dataset page
    const pageRes = await fetch(pageUrl, {
      headers: {
        'User-Agent': headers['User-Agent'],
        'Referer': 'https://pricehistory.app/'
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!pageRes.ok) {
      console.log(`[Historical Price] Failed to fetch archive page for code: ${code}`);
      return null;
    }

    const html = await pageRes.text();

    // 3. Extract encrypted dataset and dynamic encryption key
    const matchData = html.match(/var\s+PagePriceHistoryDataSet\s*=\s*['"]([^'"]+)['"]/);
    const matchKey = html.match(/(?:let|var)\s+CachedKey\s*=\s*['"]([^'"]+)['"]/);

    if (!matchData || !matchKey) {
      console.log(`[Historical Price] Dataset or decryption key not present in archive response`);
      return null;
    }

    const rawB64 = matchData[1];
    const key = matchKey[1];

    // 4. Decrypt via XOR decoding
    const decoded = Buffer.from(rawB64, 'base64');
    const keyBuf = Buffer.from(key, 'utf-8');
    const decryptedBuf = Buffer.alloc(decoded.length);

    for (let i = 0; i < decoded.length; i++) {
      decryptedBuf[i] = decoded[i] ^ keyBuf[i % keyBuf.length];
    }

    const dataset = JSON.parse(decryptedBuf.toString('utf-8'));
    const rawHistory = dataset?.History?.Price || [];

    if (!Array.isArray(rawHistory) || rawHistory.length === 0) {
      console.log(`[Historical Price] Archive returned empty history list`);
      return null;
    }

    // 5. Build lookup map of authentic price changes by date (YYYY-MM-DD)
    const priceByDate = {};
    for (const entry of rawHistory) {
      if (entry?.y != null && entry?.x) {
        priceByDate[entry.x] = Number(entry.y);
      }
    }

    const sortedDates = Object.keys(priceByDate).sort();
    if (sortedDates.length === 0) return null;

    // 6. Build continuous daily history for the requested window (e.g. 180 days)
    const today = new Date();
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split('T')[0];

    // Find authentic baseline price at or immediately preceding startDate
    let priorPrice = null;
    for (const dStr of sortedDates) {
      if (dStr <= startDateStr) {
        priorPrice = priceByDate[dStr];
      } else {
        break;
      }
    }
    // If product launched or was first observed after startDate, anchor to first recorded price
    if (priorPrice == null) {
      priorPrice = priceByDate[sortedDates[0]];
    }

    let runningPrice = priorPrice;
    const history = [];

    for (let i = days; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dStr = d.toISOString().split('T')[0];

      // If price changed on this specific date, update the running price
      if (priceByDate[dStr] != null) {
        runningPrice = priceByDate[dStr];
      }

      history.push({
        price: runningPrice,
        date: d
      });
    }

    // Anchor the latest entry (today) to current scraped price if available
    if (currentPrice != null && history.length > 0) {
      history[history.length - 1].price = Number(currentPrice);
    }

    console.log(`[Historical Price] Successfully generated ${history.length} authentic past daily price records!`);
    return history;

  } catch (error) {
    console.warn(`[Historical Price] Error retrieving original price history: ${error.message}`);
    return null;
  }
};
