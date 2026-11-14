import { retrieveRelevantContext } from './retrieverService.js';
import { buildSellerIntelligencePrompt } from './promptBuilder.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import ProductChunk from '../../models/ProductChunk.js';
import Product from '../../models/Product.js';
import { buildChunks } from './chunkBuilder.js';
import { embedText } from './embeddingService.js';
import { upsertChunks } from './pineconeService.js';
import dotenv from 'dotenv';
dotenv.config();

export const answerRagQuestion = async ({ userId, productId, query, topK = 3, filters = {} }) => {
  // 1. Fetch product if productId is provided
  let product = null;
  if (productId) {
    try {
      product = await Product.findOne({ _id: productId, userId });
    } catch (err) {
      console.warn("Could not load product for RAG query:", err.message);
    }
  }

  // 2. Retrieve relevant context chunks using vector cosine similarity
  const retrievalResult = await retrieveRelevantContext({ 
    userId, 
    productId: productId || undefined, 
    query, 
    topK, 
    filters 
  });
  
  if (!retrievalResult.matches || retrievalResult.matches.length === 0) {
    return {
      answer: "No relevant historical or pricing data found for this product. Please refresh the product to load its 180-day price history.",
      retrievedChunks: [],
      sources: [],
      topK,
      source: 'none'
    };
  }

  // 3. Build focused prompt for LLM
  const prompt = buildSellerIntelligencePrompt({
    query,
    retrievedChunks: retrievalResult.matches,
    productTitle: product?.title || retrievalResult.matches[0]?.title || 'Competitor Product',
    metrics: null 
  });

  // 4. Call Gemini if API key is configured, else use query-focused local RAG engine
  let answer = "";
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const hasValidApiKey = apiKey && 
                        apiKey !== 'your_gemini_key' && 
                        apiKey !== 'your_api_key_here' && 
                        apiKey.length > 20;

  if (hasValidApiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const modelName = (process.env.GEMINI_MODEL && !process.env.GEMINI_MODEL.includes('2.5') && !process.env.GEMINI_MODEL.includes('3.5')) 
        ? process.env.GEMINI_MODEL 
        : 'gemini-2.0-flash';
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      answer = result.response.text();
    } catch (e) {
      console.warn("Gemini generation notice in RAG query:", e.message);
      answer = generateLocalRAGAnswer(query, retrievalResult.matches, product);
    }
  } else {
    answer = generateLocalRAGAnswer(query, retrievalResult.matches, product);
  }

  const sources = retrievalResult.matches.map(m => m.title).filter(Boolean);

  return {
    answer,
    retrievedChunks: retrievalResult.matches,
    sources: [...new Set(sources)],
    topK,
    source: retrievalResult.source || 'vector_cosine'
  };
};

export const generateLocalRAGAnswer = (query, matches, product = null) => {
  if (!matches || matches.length === 0) {
    return "No relevant historical or pricing data found for this question.";
  }

  const q = (query || '').toLowerCase();
  const topMatch = matches[0];
  const meta = topMatch.metadata || {};
  const currentPrice = meta.currentPrice || product?.currentPrice || 'N/A';
  const minPrice = meta.minPrice;
  const maxPrice = meta.maxPrice;
  const avgPrice = meta.avgPrice || meta.meanPrice;
  const trend = meta.trend || 'stable';

  // 1. Lowest / Minimum Price Query
  if (q.includes('low') || q.includes('min') || q.includes('cheapest') || q.includes('dip') || q.includes('bottom') || q.includes('floor')) {
    let ans = `### Lowest Price Analysis\n`;
    ans += `- **180-Day Lowest Price**: ₹${minPrice ?? 'N/A'}\n`;
    ans += `- **Current Price**: ₹${currentPrice}\n`;
    if (minPrice && currentPrice !== 'N/A') {
      const diff = currentPrice - minPrice;
      const pct = minPrice > 0 ? ((diff / minPrice) * 100).toFixed(1) : 0;
      if (diff === 0) {
        ans += `- **Position**: The competitor is currently selling at their **all-time lowest price** floor.\n`;
      } else {
        ans += `- **Difference**: Currently ₹${diff} (${pct}%) above their 180-day price floor.\n`;
      }
    }
    ans += `- **Trend**: ${trend.toUpperCase()}\n`;
    return ans;
  }

  // 2. Highest / Peak / Maximum Price Query
  if (q.includes('high') || q.includes('max') || q.includes('peak') || q.includes('top') || q.includes('expensive')) {
    let ans = `### Peak Price Analysis\n`;
    ans += `- **180-Day Highest Price**: ₹${maxPrice ?? 'N/A'}\n`;
    ans += `- **Current Price**: ₹${currentPrice}\n`;
    if (maxPrice && currentPrice !== 'N/A') {
      const discount = maxPrice - currentPrice;
      const pct = maxPrice > 0 ? ((discount / maxPrice) * 100).toFixed(1) : 0;
      ans += `- **Markdown from Peak**: Currently ₹${discount} (${pct}%) below the peak price.\n`;
    }
    return ans;
  }

  // 3. Average / Mean / Baseline Price Query
  if (q.includes('average') || q.includes('mean') || q.includes('median') || q.includes('normal') || q.includes('baseline')) {
    let ans = `### 180-Day Average Benchmark\n`;
    ans += `- **180-Day Average Price**: ₹${avgPrice ?? 'N/A'}\n`;
    ans += `- **Median Price**: ₹${meta.medianPrice ?? avgPrice ?? 'N/A'}\n`;
    ans += `- **Current Price**: ₹${currentPrice}\n`;
    if (avgPrice && currentPrice !== 'N/A') {
      const vsAvg = currentPrice - avgPrice;
      const vsAvgPct = avgPrice > 0 ? ((vsAvg / avgPrice) * 100).toFixed(1) : 0;
      ans += `- **Comparison**: Currently trading **${vsAvg < 0 ? 'below' : 'above'}** average by ${Math.abs(vsAvgPct)}% (₹${Math.abs(vsAvg)}).\n`;
    }
    return ans;
  }

  // 4. Repricing Strategy / Counter-Move / Guidance Query
  if (q.includes('strategy') || q.includes('recommend') || q.includes('action') || q.includes('undercut') || q.includes('should i') || q.includes('margin') || q.includes('price war')) {
    let ans = `### Strategic Repricing Recommendation\n`;
    if (minPrice && currentPrice <= minPrice * 1.05) {
      ans += `- **Recommended Action: Hold Price or Match (Do Not Undercut)**. The competitor is already near their historical price floor (₹${minPrice}). Further undercutting will erode profit margins and trigger a race to the bottom.\n`;
      ans += `- **Value Differentiation**: Win the sale through faster delivery, bundle accessories, or highlighted product warranties.\n`;
    } else if (maxPrice && currentPrice >= maxPrice * 0.95) {
      ans += `- **Recommended Action: Undercut by 2-4%**. The competitor is charging near peak historical prices, leaving substantial margin headroom for you to capture buy-box share.\n`;
    } else {
      ans += `- **Recommended Action: Match Competitive Price**. Maintain parity around ₹${currentPrice}. The competitor's pricing trajectory is currently **${trend}**.\n`;
    }
    ans += `- **Execution Note**: Use the 12-hour background tracker to detect competitor counter-moves immediately.\n`;
    return ans;
  }

  // 5. Price Change / Drop / History Timeline Query
  if (q.includes('drop') || q.includes('change') || q.includes('recent') || q.includes('when') || q.includes('history') || q.includes('shift')) {
    let ans = `### Competitor Price Movement\n`;
    ans += `- **Current Price**: ₹${currentPrice}\n`;
    if (product?.previousPrice && product.previousPrice !== currentPrice) {
      const change = currentPrice - product.previousPrice;
      const pct = product.previousPrice > 0 ? ((change / product.previousPrice) * 100).toFixed(1) : 0;
      ans += `- **Recent Price Change**: Shifted from ₹${product.previousPrice} to ₹${currentPrice} (${pct}%).\n`;
    }
    if (product?.lastPriceChange) {
      ans += `- **Detected On**: ${new Date(product.lastPriceChange).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}\n`;
    }
    ans += `- **180-Day Volatility Band**: ₹${minPrice ?? 'N/A'} (Floor) to ₹${maxPrice ?? 'N/A'} (Ceiling).\n`;
    return ans;
  }

  // 6. Volatility / Fluctuation Query
  if (q.includes('volatil') || q.includes('swing') || q.includes('fluctuat') || q.includes('stable')) {
    let ans = `### Price Volatility Assessment\n`;
    ans += `- **Trading Band**: ₹${minPrice ?? 'N/A'} - ₹${maxPrice ?? 'N/A'}\n`;
    ans += `- **Trend Direction**: ${trend.toUpperCase()}\n`;
    ans += `- **Stability**: ${trend === 'stable' ? 'High price stability with minimal fluctuations across 180 days.' : 'Active promotional cycle with regular discounting swings.'}\n`;
    return ans;
  }

  // 7. General / Other Query: Extract only relevant facts from top-scoring chunk
  const keyLines = topMatch.chunkText
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('Description') && !l.startsWith('Features'))
    .slice(0, 4);

  let ans = `### Intelligence Summary\n`;
  keyLines.forEach(line => {
    ans += `- ${line.replace(/^-\s*/, '')}\n`;
  });
  return ans;
};

export const indexSingleProduct = async (product, userId) => {
  // 1. Build RAG chunks from 180-day price history
  const chunks = buildChunks(product);
  
  // 2. Generate vector embeddings for every chunk
  for (const chunk of chunks) {
    chunk.embedding = await embedText(chunk.chunkText);
  }

  // 3. Delete existing chunks for this product in DB
  await ProductChunk.deleteMany({ productId: product._id, userId });

  // 4. Store new chunks with vector embeddings in DB
  const savedChunks = await ProductChunk.insertMany(chunks);
  console.log(`[RAG Indexer] Indexed ${savedChunks.length} vector chunks for "${product.title}"`);

  // 5. If Pinecone API keys are configured, upsert to Pinecone
  if (process.env.PINECONE_API_KEY && process.env.PINECONE_API_KEY !== 'your_pinecone_key' && process.env.PINECONE_API_KEY.length > 10) {
    try {
      await upsertChunks(savedChunks, userId);
      await ProductChunk.updateMany(
        { _id: { $in: savedChunks.map(c => c._id) } },
        { $set: { indexedInPinecone: true } }
      );
      console.log(`[RAG Indexer] Successfully pushed ${savedChunks.length} vector embeddings to Pinecone`);
      return {
        productId: product._id,
        chunksCreated: chunks.length,
        chunksIndexed: savedChunks.length
      };
    } catch (pineconeErr) {
      console.warn(`[RAG Indexer] Pinecone upsert notice: ${pineconeErr.message}`);
    }
  }

  return {
    productId: product._id,
    chunksCreated: chunks.length,
    chunksIndexed: savedChunks.length
  };
};
