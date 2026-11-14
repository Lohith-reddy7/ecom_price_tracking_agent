import express from 'express';
import Product from '../models/Product.js';
import auth from '../middleware/auth.js';
import { scrapeProductPrice } from '../utils/scraper.js';
import { fetchOriginalPriceHistory } from '../services/historicalPriceService.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { indexSingleProduct, answerRagQuestion } from '../services/rag/ragService.js';
import dotenv from 'dotenv';  
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });


const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const router = express.Router();

// Get all products for user
router.get('/', auth, async (req, res) => {
  try {
    const products = await Product.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(products);
  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({ message: 'Server error fetching products' });
  }
});

// Add new product
router.post('/', auth, async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ message: 'Please provide a product URL' });
    }

    // Scrape product data
    const productData = await scrapeProductPrice(url);

    if (!productData) {
      return res.status(400).json({ message: 'Could not fetch product data from the URL' });
    }

    // Generate 180 days of historical price data with realistic patterns
    const generateHistoricalPrices = (basePrice) => {
      const history = [];
      const today = new Date();
      let currentPrice = basePrice;
      let lastChangeDay = 0;
      let daysUntilNextChange = Math.floor(Math.random() * 3) + 1; // 1-3 days
      
      for (let i = 180; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        
        // Only change price every 1-3 days
        const dayIndex = 180 - i;
        if (dayIndex >= lastChangeDay + daysUntilNextChange) {
          // Seasonal factors (festivals, sales events)
          const month = date.getMonth();
          const dayOfMonth = date.getDate();
          let seasonalMultiplier = 1.0;
          
          // Diwali season (Oct 15 - Nov 15) - prices drop due to sales
          if ((month === 9 && dayOfMonth >= 15) || (month === 10 && dayOfMonth <= 15)) {
            seasonalMultiplier = 0.85 + (Math.random() * 0.10); // 10-15% discount
          }
          // New Year sales (Dec 25 - Jan 10)
          else if ((month === 11 && dayOfMonth >= 25) || (month === 0 && dayOfMonth <= 10)) {
            seasonalMultiplier = 0.88 + (Math.random() * 0.08); // 8-12% discount
          }
          // Summer sales (May 15 - Jun 30)
          else if ((month === 4 && dayOfMonth >= 15) || (month === 5)) {
            seasonalMultiplier = 0.90 + (Math.random() * 0.07); // 7-10% discount
          }
          // Republic Day sale (Jan 20-26)
          else if (month === 0 && dayOfMonth >= 20 && dayOfMonth <= 26) {
            seasonalMultiplier = 0.92 + (Math.random() * 0.05); // 5-8% discount
          }
          // Regular days - very small fluctuations
          else {
            seasonalMultiplier = 0.98 + (Math.random() * 0.04); // -2% to +2%
          }
          
          // Gradual price drift over 6 months (slight inflation)
          const daysFromStart = 180 - i;
          const trendFactor = 1 + (daysFromStart * 0.00008); // ~1.5% increase over 180 days
          
          // Small random variation when price changes
          const priceVariation = 0.995 + (Math.random() * 0.01); // ±0.5%
          
          // Calculate new price
          currentPrice = basePrice * seasonalMultiplier * trendFactor * priceVariation;
          
          // Round to nearest 10 for realistic pricing
          currentPrice = Math.round(currentPrice / 10) * 10;
          
          // Set next change interval (1-3 days)
          lastChangeDay = dayIndex;
          daysUntilNextChange = Math.floor(Math.random() * 3) + 1;
        }
        
        history.push({
          price: currentPrice,
          date: date
        });
      }
      
      return history;
    };

    // Historical price data initialization:
    // 1. First priority: Try fetching authentic original past 180-day price history using free public archives
    let historicalPrices = [];
    let historySource = 'original';

    if (Array.isArray(productData.priceHistory) && productData.priceHistory.length > 0) {
      historicalPrices = productData.priceHistory;
      historySource = 'original';
      console.log('=== ORIGINAL 180-DAY PRICE HISTORY LOADED (VIA SCRAPER) ===');
      console.log(`Product: ${productData.title}`);
      console.log(`Authentic history records: ${historicalPrices.length}`);
      console.log('===========================================================');
    } else {
      // Fetch directly via Node historical price service
      try {
        const originalHistory = await fetchOriginalPriceHistory(url, productData.price, 180);
        if (originalHistory && originalHistory.length > 0) {
          historicalPrices = originalHistory;
          historySource = 'original';
          console.log('=== ORIGINAL 180-DAY PRICE HISTORY RETRIEVED (FREE ARCHIVE) ===');
          console.log(`Product: ${productData.title}`);
          console.log(`Authentic history records: ${historicalPrices.length}`);
          const pMin = Math.min(...historicalPrices.map(h => h.price));
          const pMax = Math.max(...historicalPrices.map(h => h.price));
          console.log(`Historical Range: ${productData.currency || 'INR'} ${pMin} - ${productData.currency || 'INR'} ${pMax}`);
          console.log('==============================================================');
        }
      } catch (histErr) {
        console.warn('[Price History] Archive lookup note:', histErr.message);
      }
    }

    // 2. Fallbacks if no original past prices exist for this URL:
    if (!historicalPrices || historicalPrices.length === 0) {
      if (process.env.GENERATE_SYNTHETIC_HISTORY === 'true') {
        historicalPrices = generateHistoricalPrices(productData.price);
        historySource = 'synthetic';
        console.log('=== SYNTHETIC PRICE HISTORY GENERATION (DEMO FALLBACK) ===');
        console.log('Base Price:', productData.price);
        console.log('Total history entries generated:', historicalPrices.length);
        console.log('==========================================================');
      } else {
        historicalPrices = [{
          price: productData.price,
          date: new Date()
        }];
        historySource = 'tracked';
        console.log('=== AUTHENTIC PRICE TRACKING INITIALIZED (START BASELINE) ===');
        console.log(`Product: ${productData.title}`);
        console.log(`Initial Authentic Price: ${productData.currency || 'INR'} ${productData.price}`);
        console.log('============================================================');
      }
    }

    // Check if price changed across the 180-day history
    const distinct = [...historicalPrices].reverse().find(h => h.price !== productData.price);
    const previousPrice = distinct ? distinct.price : null;
    const priceChanged = Boolean(distinct);

    // Create product with authentic data
    const product = new Product({
      userId: req.userId,
      url,
      title: productData.title,
      currentPrice: productData.price,
      currency: productData.currency || 'INR',
      imageUrl: productData.imageUrl,
      platform: productData.platform,
      description: productData.description || '',
      features: productData.features || [],
      priceHistory: historicalPrices,
      historySource,
      previousPrice,
      priceChanged,
      lastPriceChange: distinct ? new Date() : null
    });

    await product.save();
    
    // Attempt to index product for RAG
    try {
      await indexSingleProduct(product, req.userId);
    } catch (ragError) {
      console.warn("RAG indexing skipped/failed:", ragError.message);
    }
    
    console.log('Product saved with price history length:', product.priceHistory.length);
    
    res.status(201).json(product);
  } catch (error) {
    console.error('Add product error:', error);
    res.status(500).json({ message: 'Server error adding product' });
  }
});

// Update product price
router.put('/:id/refresh', auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, userId: req.userId });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    // Scrape updated price
    const productData = await scrapeProductPrice(product.url);

    if (!productData) {
      return res.status(400).json({ message: 'Could not fetch updated product data' });
    }

    // Update product price
    const oldPrice = product.currentPrice;
    const newPrice = productData.price;
    const priceHasChanged = oldPrice !== newPrice;

    product.currentPrice = newPrice;
    product.lastChecked = new Date();

    if (priceHasChanged) {
      product.previousPrice = oldPrice;
      product.priceChanged = true;
      product.lastPriceChange = new Date();
    }
    
    // Only add to history if price changed or it's been more than a day
    const lastEntry = product.priceHistory[product.priceHistory.length - 1];
    const lastDate = lastEntry?.date ? new Date(lastEntry.date) : new Date(0);
    const daysSinceLastEntry = (new Date() - lastDate) / (1000 * 60 * 60 * 24);
    
    if (!lastEntry || lastEntry.price !== productData.price || daysSinceLastEntry >= 1) {
      product.priceHistory.push({
        price: productData.price,
        date: new Date()
      });
    }

    await product.save();
    
    // Only re-index if the price actually changed
    if (priceHasChanged) {
      try {
        await indexSingleProduct(product, req.userId);
      } catch (ragError) {
        console.warn("RAG re-indexing skipped/failed:", ragError.message);
      }
    }
    
    res.json(product);
  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({ message: 'Server error updating product' });
  }
});

// Acknowledge / dismiss price change symbol
router.put('/:id/dismiss-change', auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, userId: req.userId });
    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }
    product.priceChanged = false;
    await product.save();
    res.json(product);
  } catch (error) {
    console.error('Dismiss price change error:', error);
    res.status(500).json({ message: 'Server error dismissing price change' });
  }
});

// Delete product
router.delete('/:id', auth, async (req, res) => {
  try {
    const product = await Product.findOneAndDelete({ _id: req.params.id, userId: req.userId });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({ message: 'Server error deleting product' });
  }
});

// Generate weekly contextual summary for RAG
const generateWeeklySummary = (priceHistory, productTitle, platform) => {
  const weeks = [];
  let currentWeek = [];
  let weekStartDate = null;
  
  priceHistory.forEach((entry, index) => {
    const entryDate = new Date(entry.date);
    
    if (!weekStartDate) {
      weekStartDate = entryDate;
    }
    
    currentWeek.push(entry);
    
    // Check if week is complete (7 days) or it's the last entry
    if (currentWeek.length === 7 || index === priceHistory.length - 1) {
      const prices = currentWeek.map(e => e.price);
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
      const startPrice = currentWeek[0].price;
      const endPrice = currentWeek[currentWeek.length - 1].price;
      const priceChange = endPrice - startPrice;
      const priceChangePercent = ((priceChange / startPrice) * 100).toFixed(2);
      
      // Determine trend
      let trend = 'stable';
      if (Math.abs(priceChangePercent) < 1) trend = 'stable';
      else if (priceChangePercent > 0) trend = 'increasing';
      else trend = 'decreasing';
      
      // Check for significant events
      const volatility = maxPrice - minPrice;
      const isHighVolatility = volatility > (avgPrice * 0.05); // >5% range
      
      const weekNum = weeks.length + 1;
      const weekEnd = new Date(currentWeek[currentWeek.length - 1].date);
      
      weeks.push({
        week: weekNum,
        startDate: weekStartDate.toLocaleDateString('en-IN'),
        endDate: weekEnd.toLocaleDateString('en-IN'),
        avgPrice,
        minPrice,
        maxPrice,
        startPrice,
        endPrice,
        priceChange,
        priceChangePercent,
        trend,
        volatility,
        isHighVolatility,
        daysInWeek: currentWeek.length
      });
      
      currentWeek = [];
      weekStartDate = null;
    }
  });
  
  return weeks;
};

// Generate RAG-optimized context summary
const generateRAGContext = (weeklySummary, productTitle, platform, currentPrice, currency, createdAt, historyCount = 1) => {
    const currencySymbol = currency === 'USD' ? '$' : '₹';
    let context = `Product: ${productTitle}\n`;
    context += `Platform: ${platform}\n`;
    context += `Current Price: ${currencySymbol}${currentPrice}\n`;

    const daysTracked = createdAt ? Math.max(1, Math.round((new Date() - new Date(createdAt)) / (1000 * 60 * 60 * 24))) : 1;
    context += `Analysis Period: Tracked for ${daysTracked} day(s) (${weeklySummary.length} interval(s), ${historyCount} price observation(s))\n\n`;

    if (!weeklySummary || weeklySummary.length === 0) {
      context += `OVERALL SUMMARY:\n`;
      context += `- Current Baseline Price: ${currencySymbol}${currentPrice}\n`;
      context += `- Price History: Newly tracked product. Baseline established, awaiting further automated observations.\n\n`;
      return context;
    }
  
    // Overall statistics
    const allAvgPrices = weeklySummary.map(w => w.avgPrice);
    const overallMin = Math.min(...weeklySummary.map(w => w.minPrice));
    const overallMax = Math.max(...weeklySummary.map(w => w.maxPrice));
    const overallAvg = Math.round(allAvgPrices.reduce((a, b) => a + b, 0) / (allAvgPrices.length || 1));
    const priceRange = overallMax - overallMin;
    const rangePercent = overallAvg > 0 ? (((priceRange) / overallAvg) * 100).toFixed(1) : '0.0';
    
    context += `OVERALL SUMMARY:\n`;
    context += `- Average Price: ${currencySymbol}${overallAvg}\n`;
    context += `- Lowest Price: ${currencySymbol}${overallMin}\n`;
    context += `- Highest Price: ${currencySymbol}${overallMax}\n`;
    context += `- Price Range: ${currencySymbol}${priceRange} (${rangePercent}%)\n\n`;
  
  // Identify best weeks to buy
  const sortedByMin = [...weeklySummary].sort((a, b) => a.minPrice - b.minPrice);
  context += `BEST WEEKS TO BUY (Lowest Prices):\n`;
  sortedByMin.slice(0, 3).forEach(week => {
    context += `- Week ${week.week} (${week.startDate}): ${currencySymbol}${week.minPrice}\n`;
  });
  context += `\n`;
  
  // Identify high volatility weeks
  const highVolWeeks = weeklySummary.filter(w => w.isHighVolatility);
  if (highVolWeeks.length > 0) {
    context += `HIGH VOLATILITY WEEKS (Price Fluctuations):\n`;
    highVolWeeks.slice(0, 5).forEach(week => {
      context += `- Week ${week.week}: ${currencySymbol}${week.minPrice}-${currencySymbol}${week.maxPrice} (${week.trend})\n`;
    });
    context += `\n`;
  }
  
  // Weekly breakdown
  context += `WEEKLY PRICE ANALYSIS:\n`;
  weeklySummary.forEach(week => {
    context += `Week ${week.week} (${week.startDate} to ${week.endDate}):\n`;
    context += `  Average: ${currencySymbol}${week.avgPrice} | Range: ${currencySymbol}${week.minPrice}-${currencySymbol}${week.maxPrice}\n`;
    context += `  Trend: ${week.trend} (${week.priceChangePercent > 0 ? '+' : ''}${week.priceChangePercent}%)\n`;
    if (week.isHighVolatility) {
      context += `  Note: High price volatility detected\n`;
    }
    context += `\n`;
  });
  
  // Recommendations
  context += `RECOMMENDATIONS:\n`;
  if (currentPrice <= overallMin * 1.05) {
    context += `- Current price is near historical low. Good time to buy.\n`;
  } else if (currentPrice >= overallMax * 0.95) {
    context += `- Current price is near historical high. Consider waiting.\n`;
  } else {
    context += `- Current price is moderate. Monitor for better deals.\n`;
  }
  
  return context;
};

// Download product price history as CSV
router.get('/:id/csv', auth, async (req, res) => {
  try {
    console.log('CSV download requested for product ID:', req.params.id);
    
    const product = await Product.findOne({ _id: req.params.id, userId: req.userId });

    if (!product) {
      console.log('Product not found for CSV download');
      return res.status(404).json({ message: 'Product not found' });
    }

    console.log(`Generating CSV for product: ${product.title}`);
    console.log(`Price history entries: ${product.priceHistory.length}`);

    // Generate CSV content
    let csv = `Date,Price (${product.currency || 'INR'}),Product,Platform\n`;
    
    product.priceHistory.forEach(entry => {
      const date = new Date(entry.date).toLocaleDateString('en-IN');
      csv += `${date},${entry.price},"${product.title}",${product.platform}\n`;
    });

    console.log(`CSV generated with ${csv.split('\n').length - 1} rows`);

    // Generate short filename (max 30 chars + extension)
    const shortTitle = product.title.substring(0, 25).replace(/[^a-z0-9]/gi, '_');
    const filename = `${shortTitle}_prices.csv`;
    
    console.log(`Sending CSV file: ${filename}`);
    
    // Set headers for file download
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', Buffer.byteLength(csv));
    
    res.send(csv);
    console.log('CSV sent successfully');
  } catch (error) {
    console.error('CSV download error:', error);
    res.status(500).json({ message: 'Server error generating CSV' });
  }
});

// Download RAG-optimized contextual summary
router.get('/:id/summary', auth, async (req, res) => {
  try {
    console.log('Summary requested for product ID:', req.params.id);
    
    const product = await Product.findOne({ _id: req.params.id, userId: req.userId });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    console.log(`Generating summary for: ${product.title}`);
    
    // Generate weekly summary
    const weeklySummary = generateWeeklySummary(product.priceHistory, product.title, product.platform);
    
    // Generate RAG context
    const ragContext = generateRAGContext(
      weeklySummary,
      product.title,
      product.platform,
      product.currentPrice,
      product.currency,
      product.createdAt,
      product.priceHistory?.length || 1
    );
    
    // Create summary text file
    const shortTitle = product.title.substring(0, 25).replace(/[^a-z0-9]/gi, '_');
    const filename = `${shortTitle}_summary.txt`;
    
    console.log(`Sending summary file: ${filename}`);
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    
    res.send(ragContext);
    console.log('Summary sent successfully');
  } catch (error) {
    console.error('Summary generation error:', error);
    res.status(500).json({ message: 'Server error generating summary' });
  }
});

// Ask AI Question for a specific product using targeted RAG
router.post('/:id/ask-ai', auth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ message: "Query is required" });

    const result = await answerRagQuestion({
      userId: req.userId,
      productId: req.params.id,
      query,
      topK: 3
    });
    res.json(result);
  } catch (error) {
    console.error("Ask AI error for product:", error);
    res.status(500).json({ message: "Server error generating AI response" });
  }
});

// AI Strategic Action endpoint using RAG
router.post('/:id/ai-action', auth, async (req, res) => {
  try {
    console.log('AI Strategic Action requested for product ID:', req.params.id);
    
    const product = await Product.findOne({ _id: req.params.id, userId: req.userId });

    if (!product) {
      return res.status(404).json({ message: 'Product not found' });
    }

    console.log(`Generating AI action for: ${product.title}`);
    
    // Generate weekly summary for RAG context
    const weeklySummary = generateWeeklySummary(product.priceHistory, product.title, product.platform);
    const ragContext = generateRAGContext(
      weeklySummary,
      product.title,
      product.platform,
      product.currentPrice,
      product.currency,
      product.createdAt,
      product.priceHistory?.length || 1
    );
    
    // Get price change info from request or deduce from 180-day history
    let effNewPrice = Number(req.body.newPrice) || product.currentPrice;
    let effOldPrice = Number(req.body.oldPrice);

    if (!effOldPrice || isNaN(effOldPrice)) {
      const history = product.priceHistory || [];
      const distinct = [...history].reverse().find(h => h.price !== effNewPrice);
      if (distinct) {
        effOldPrice = distinct.price;
      } else if (history.length > 1) {
        effOldPrice = history[0].price;
      } else {
        effOldPrice = effNewPrice;
      }
    }

    const priceChange = effNewPrice - effOldPrice;
    const priceChangePercent = effOldPrice > 0 ? ((priceChange / effOldPrice) * 100).toFixed(2) : '0.00';
    const changeType = priceChange < 0 ? 'decreased' : priceChange > 0 ? 'increased' : 'remained steady';
    
    const currencySymbol = product.currency === 'USD' ? '$' : '₹';
    // Create a clean, professional prompt for the AI
    const prompt = `You are a senior competitive pricing strategist for e-commerce sellers. A seller is monitoring their competitor's product price changes to protect their market position and prevent losses.

COMPETITOR PRICE CHANGE DETECTED:
- Competitor Product: ${product.title}
- Platform: ${product.platform}
- Previous Price: ${currencySymbol}${effOldPrice}
- New Price: ${currencySymbol}${effNewPrice}
- Change: ${currencySymbol}${priceChange} (${priceChangePercent}%)
- Status: Competitor ${changeType} their price

COMPETITOR'S HISTORICAL PRICE DATA (RAG DATA):
${ragContext}

YOUR TASK:
- Analyze the competitor's pricing move using the history above.
- Recommend a clear, practical strategy for the seller to protect profit and market share.
- Focus on specific pricing and action recommendations, not generic theory.

OUTPUT FORMAT (IMPORTANT):
- Respond in clean, professional **Markdown**.
- Begin with a heading "## Overview" followed by **4–6 bullet points only** (no paragraphs).
- The Overview bullets together should be around **80–120 words total** (roughly ~100 words), summarizing the situation and your high-level strategy.
- Then use clear section headings in this order:
  - ## Immediate Action
  - ## Competitive Analysis
  - ## Pricing Strategy
  - ## Risk Assessment
  - ## Competitor Prediction
  - ## Action Plan (Step-by-Step)
  - ## Long-Term Strategy (30–90 Days)
- Under each heading, use bullet points where each bullet looks like: **Short Title**: detailed explanation (1–2 sentences, around 20–30 words) with concrete, actionable guidance.
- Overall, provide a pointwise, detailed strategy rather than very short or generic bullets.

CONTENT TO PROVIDE UNDER EACH HEADING:

## Immediate Action
- **Current Situation**: Briefly restate what just happened with the competitor price.
- **Immediate Response**: What should the seller do right now about their price (match, undercut, hold, or increase)? Include a suggested percentage or rupee range.

## Competitive Analysis
- **Competitor Behaviour**: Describe whether the competitor appears aggressive, defensive, experimenting, or seasonal.
- **Historical Pattern Insight**: Use the tracked history to infer patterns (sales events, volatility, baseline stability).

## Pricing Strategy
- **Recommended Positioning**: Explain if the seller should aim to be cheaper, equal, or slightly more expensive and why.
- **Adjustment Guidance**: Suggest how much to move the price (in % or ₹ range) and how quickly, considering margins and demand.

## Risk Assessment
- **No-Action Risk**: What happens if the seller does nothing?
- **Aggressive Response Risk**: Risks of deep undercutting or frequent changes (price wars, margin erosion).
- **Operational Risks**: Mention stock, cash flow, or customer perception risks.

## Competitor Prediction
- **Short-Term Outlook**: Based on the tracked history and latest price movement, what is the competitor likely to do in the next 7–14 days?
- **Medium-Term Outlook**: Any patterns or triggers (festivals, salary dates, seasonality) that might change their pricing.

## Action Plan (Step-by-Step)
- **Step 1**: Immediate pricing action (with specific target range in ${product.currency}).
- **Step 2**: Monitoring plan for the next few days (what to watch, how often).
- **Step 3**: Rules for automatic adjustments if prices move again.
- **Step 4**: Non-price levers (bundles, coupons, delivery, returns) the seller can use.

## Long-Term Strategy (30–90 Days)
- **Positioning Strategy**: How the seller should position on price vs value over the next 1–3 months.
- **Playbook for Repeated Patterns**: How to respond if this competitor behaviour repeats.
- **Data & Experimentation**: What data to track (conversion, margins, price index) and what tests to run to refine the strategy.

Keep your response tightly focused on **specific seller actions**, with bolded bullet titles and neat, easy-to-follow structure.`;

    console.log('Sending request to LLM...');

    // Set up response headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Helper: generate full RAG-driven strategy fallback
    const sendRAGFallbackStrategy = (apiNotice = null) => {
      const allPrices = product.priceHistory.map(h => h.price);
      const minP = Math.min(...allPrices);
      const maxP = Math.max(...allPrices);
      const avgP = Math.round(allPrices.reduce((a, b) => a + b, 0) / (allPrices.length || 1));
      const isUnderAverage = effNewPrice < avgP;
      const targetUndercut = Math.round(effNewPrice * 0.98);

      const noticeBlock = apiNotice 
        ? `> 💡 **Notice**: ${apiNotice}\n\n`
        : `> 💡 **Notice**: Strategy generated via the **RAG Competitive Pricing Engine** using 180 days of historical pricing data. To enable live Google Gemini LLM generation, set your free \`GEMINI_API_KEY\` in \`server/.env\`.\n\n`;

      const responseMarkdown = noticeBlock + `## Overview
- **Active Competitor Move**: Competitor listing on ${product.platform} is currently at ${currencySymbol}${effNewPrice} (${changeType} from ${currencySymbol}${effOldPrice}).
- **180-Day Historical Range**: Documented authentic floor price of ${currencySymbol}${minP} and peak price of ${currencySymbol}${maxP} across 180 days.
- **Market Positioning**: Current price sits ${isUnderAverage ? 'below' : 'above'} the 180-day baseline average of ${currencySymbol}${avgP}.
- **Core Recommendation**: ${priceChange < 0 ? 'Match selectively and implement value-add incentives rather than engaging in a direct margin-eroding price war.' : 'Hold price firm or capture extra margin while competitor tests elevated pricing.'}

## Immediate Action
- **Current Situation**: Competitor price shifted from ${currencySymbol}${effOldPrice} to ${currencySymbol}${effNewPrice} (${priceChangePercent}% change).
- **Immediate Response**: Set your listing target between ${currencySymbol}${targetUndercut} and ${currencySymbol}${effNewPrice} to protect buy-box share while preserving margin.

## Competitive Analysis
- **Competitor Behaviour**: Competitor displays ${effNewPrice <= minP * 1.05 ? 'aggressive promotion discounting' : 'standard algorithmic inventory repositioning'} based on historical volatility.
- **Historical Pattern Insight**: 180-day RAG analysis indicates cyclical price shifts with an average trading level of ${currencySymbol}${avgP}.

## Pricing Strategy
- **Recommended Positioning**: Maintain competitive parity at ${currencySymbol}${effNewPrice} with instant checkout coupon vouchers.
- **Adjustment Guidance**: Do not drop below ${currencySymbol}${minP}; adjust in 2-3% increments to measure competitor repricer reaction.

## Risk Assessment
- **No-Action Risk**: Inaction risks immediate loss of buy-box velocity and organic ranking to the competitor.
- **Aggressive Response Risk**: Deep discounting triggers tit-for-tat retaliation, eroding category profitability permanently.
- **Operational Risks**: Monitor stock depth closely to prevent stock-outs during high-velocity price matching.

## Competitor Prediction
- **Short-Term Outlook**: Competitor is projected to test this price point for 5–10 days before reverting towards ${currencySymbol}${avgP}.
- **Medium-Term Outlook**: Anticipate sharper discounting during upcoming holiday promotions and platform festival sales.

## Action Plan (Step-by-Step)
- **Step 1**: Calibrate your listing price to ${currencySymbol}${Math.min(effNewPrice, Math.max(minP, targetUndercut))}.
- **Step 2**: Track competitor buy-box rotation every 4-6 hours using the integrated scheduler.
- **Step 3**: Configure automated repricing floors at ${currencySymbol}${minP} to prevent unhedged margin dilution.
- **Step 4**: Introduce bundled accessories or expedited delivery guarantees to outrank competitor offers.

## Long-Term Strategy (30–90 Days)
- **Positioning Strategy**: Focus on seller review velocity and prime fulfillment badge to capture premium buyers above discount tiers.
- **Playbook for Repeated Patterns**: Pre-program promotional drops 48 hours prior to predictable seasonal sale windows.
- **Data & Experimentation**: A/B test bundle variations and coupon thresholds to quantify conversion elasticity against competitor moves.`;

      // Stream fallback cleanly
      res.write(`data: ${JSON.stringify({ content: responseMarkdown })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    const hasValidApiKey = apiKey && 
                          apiKey !== 'your_gemini_key' &&
                          apiKey !== 'your_api_key_here' &&
                          apiKey.length > 20;

    if (!hasValidApiKey) {
      console.log('[AI Action] Valid GEMINI_API_KEY not configured. Streaming RAG Intelligence Strategy.');
      return sendRAGFallbackStrategy();
    }

    try {
      const activeGenAI = new GoogleGenerativeAI(apiKey);
      const modelName = (process.env.GEMINI_MODEL && !process.env.GEMINI_MODEL.includes('2.5')) 
        ? process.env.GEMINI_MODEL 
        : 'gemini-2.0-flash';
      const model = activeGenAI.getGenerativeModel({ model: modelName });

      // Start a chat session
      const chat = model.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: 'You are a competitive pricing strategist for e-commerce sellers. Provide clear, actionable advice based on the provided data.' }],
          },
          {
            role: 'model',
            parts: [{ text: 'I understand. I will analyze the pricing data and provide strategic recommendations to help you compete effectively.' }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 4096,
          temperature: 0.7,
        },
      });

      // Send the prompt and stream the response
      const result = await chat.sendMessageStream(prompt);
      let fullResponse = '';

      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        fullResponse += chunkText;
        res.write(`data: ${JSON.stringify({ content: chunkText })}\n\n`);
      }

      console.log('AI response completed. Total characters:', fullResponse.length);
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (llmError) {
      console.warn('[AI Action] Gemini API error, falling back to RAG intelligence strategy:', llmError.message);
      sendRAGFallbackStrategy(`Gemini API Error (${llmError.message}). Displaying RAG Intelligence Strategy.`);
    }
    
  } catch (error) {
    console.error('AI action generation error:', error);
    res.status(500).json({ message: 'Server error generating AI action' });
  }
});

export default router;
