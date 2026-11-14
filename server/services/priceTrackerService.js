import Product from '../models/Product.js';
import { scrapeProductPrice } from '../utils/scraper.js';
import { indexSingleProduct } from './rag/ragService.js';

let trackerIntervalId = null;

/**
 * Checks and updates prices for all tracked products.
 * Records authentic price observations into product.priceHistory.
 */
export const checkAllProductPrices = async () => {
  console.log('[Price Tracker] Starting scheduled authentic price check cycle...');

  try {
    const products = await Product.find({});
    if (!products || products.length === 0) {
      console.log('[Price Tracker] No products currently tracked.');
      return;
    }

    console.log(`[Price Tracker] Checking ${products.length} product(s)...`);

    for (const product of products) {
      try {
        console.log(`[Price Tracker] Checking product: "${product.title}" (${product.platform})`);
        const productData = await scrapeProductPrice(product.url);

        if (!productData || typeof productData.price !== 'number') {
          console.warn(`[Price Tracker] Could not retrieve price for: ${product.url}`);
          continue;
        }

        const oldPrice = product.currentPrice;
        const newPrice = productData.price;
        const now = new Date();
        const priceHasChanged = oldPrice !== newPrice;

        product.currentPrice = newPrice;
        product.lastChecked = now;

        if (priceHasChanged) {
          product.previousPrice = oldPrice;
          product.priceChanged = true;
          product.lastPriceChange = now;
        }

        if (!product.priceHistory) {
          product.priceHistory = [];
        }

        const lastEntry = product.priceHistory[product.priceHistory.length - 1];
        const lastDate = lastEntry?.date ? new Date(lastEntry.date) : null;
        const hoursSinceLast = lastDate ? (now - lastDate) / (1000 * 60 * 60) : 999;

        // Log entry if price has changed or at least 24 hours have passed since last record
        if (!lastEntry || lastEntry.price !== newPrice || hoursSinceLast >= 24) {
          product.priceHistory.push({
            price: newPrice,
            date: now
          });
          console.log(`[Price Tracker] Recorded price observation for "${product.title}": ${product.currency || 'INR'} ${newPrice} (Previous: ${oldPrice})`);
        }

        await product.save();

        // Re-index for RAG if price changed
        if (priceHasChanged) {
          try {
            await indexSingleProduct(product, product.userId);
            console.log(`[Price Tracker] Updated RAG index for "${product.title}" due to price change.`);
          } catch (ragError) {
            console.warn(`[Price Tracker] RAG re-index notice: ${ragError.message}`);
          }
        }
      } catch (productErr) {
        console.error(`[Price Tracker] Error checking product ${product._id}:`, productErr.message);
      }
    }

    console.log('[Price Tracker] Price check cycle complete.');
  } catch (error) {
    console.error('[Price Tracker] Global tracker cycle error:', error.message);
  }
};

/**
 * Starts the automatic background price tracking service.
 * @param {number} intervalHours Interval between checks in hours (default: 12)
 */
export const startPriceTrackingScheduler = (intervalHours = 12) => {
  if (trackerIntervalId) {
    clearInterval(trackerIntervalId);
  }

  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;
  console.log(`[Price Tracker] Scheduler initialized to run every ${intervalHours} hour(s).`);

  // Run initial check after 30 seconds to allow server & scraper to settle
  setTimeout(() => {
    checkAllProductPrices().catch((err) =>
      console.warn('[Price Tracker] Initial cycle skipped/error:', err.message)
    );
  }, 30000);

  // Set recurring interval
  trackerIntervalId = setInterval(() => {
    checkAllProductPrices().catch((err) =>
      console.error('[Price Tracker] Recurring cycle error:', err.message)
    );
  }, intervalMs);
};

export const stopPriceTrackingScheduler = () => {
  if (trackerIntervalId) {
    clearInterval(trackerIntervalId);
    trackerIntervalId = null;
    console.log('[Price Tracker] Scheduler stopped.');
  }
};
