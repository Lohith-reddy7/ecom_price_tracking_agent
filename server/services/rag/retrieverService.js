import { embedText, cosineSimilarity } from './embeddingService.js';
import { querySimilarChunks } from './pineconeService.js';
import ProductChunk from '../../models/ProductChunk.js';

export const retrieveRelevantContext = async ({ userId, productId, query, topK = 3, filters = {} }) => {
  // 1. Generate 768-D query vector embedding
  let queryEmbedding;
  try {
    queryEmbedding = await embedText(query);
  } catch (err) {
    console.warn('[RAG Retriever] Query embedding generation fallback:', err.message);
  }

  const hasPinecone = process.env.PINECONE_API_KEY && 
                      process.env.PINECONE_API_KEY !== 'your_pinecone_key' &&
                      process.env.PINECONE_API_KEY.length > 10;

  // 2. Try Pinecone Vector Search if configured
  if (hasPinecone && queryEmbedding) {
    try {
      const pineconeFilters = { ...filters };
      if (productId) {
        pineconeFilters.productId = { $eq: String(productId) };
      }

      const matches = await querySimilarChunks(queryEmbedding, userId, topK, pineconeFilters);
      if (matches && matches.length > 0) {
        const chunkIds = matches.map(match => match.metadata?.chunkId || match.id);
        const chunks = await ProductChunk.find({
          userId,
          chunkId: { $in: chunkIds }
        });

        const chunkMap = new Map(chunks.map(c => [c.chunkId, c]));
        const orderedChunks = chunkIds
          .map((id, index) => {
            const c = chunkMap.get(id);
            if (!c) return null;
            return {
              chunkId: c.chunkId,
              score: matches[index]?.score ?? 0.85,
              chunkType: c.chunkType,
              productId: c.productId,
              title: c.metadata?.title || '',
              chunkText: c.chunkText,
              metadata: c.metadata
            };
          })
          .filter(Boolean);

        if (orderedChunks.length > 0) {
          console.log(`[RAG Retriever] Retrieved ${orderedChunks.length} chunks via Pinecone vector index`);
          return { query, topK, matches: orderedChunks, source: 'pinecone' };
        }
      }
    } catch (pineconeErr) {
      console.warn('[RAG Retriever] Pinecone search fallback to local vector cosine search:', pineconeErr.message);
    }
  }

  // 3. High-Precision Local Vector Cosine Similarity Search
  const dbFilter = { userId };
  if (productId) {
    dbFilter.productId = productId;
  }

  const candidates = await ProductChunk.find(dbFilter);
  if (!candidates || candidates.length === 0) {
    return {
      query,
      topK,
      matches: [],
      source: 'local_vector'
    };
  }

  // Score candidate chunks by vector cosine similarity
  const scoredChunks = [];
  for (const chunk of candidates) {
    let chunkVec = chunk.embedding;
    if (!chunkVec || chunkVec.length === 0) {
      chunkVec = await embedText(chunk.chunkText);
      // Persist generated embedding for future instant queries
      ProductChunk.updateOne({ _id: chunk._id }, { $set: { embedding: chunkVec } }).catch(() => {});
    }

    let score = queryEmbedding ? cosineSimilarity(queryEmbedding, chunkVec) : 0.5;

    // Additional keyword reinforcement for exact match terms
    const qLower = query.toLowerCase();
    const typeLower = (chunk.chunkType || '').toLowerCase();
    const textLower = (chunk.chunkText || '').toLowerCase();

    if (qLower.includes('low') || qLower.includes('min') || qLower.includes('cheap')) {
      if (typeLower === 'price_history_summary') score += 0.25;
    }
    if (qLower.includes('high') || qLower.includes('max') || qLower.includes('peak')) {
      if (typeLower === 'price_history_summary') score += 0.25;
    }
    if (qLower.includes('strategy') || qLower.includes('recommend') || qLower.includes('action') || qLower.includes('undercut') || qLower.includes('should i')) {
      if (typeLower === 'recommendation_context') score += 0.3;
    }
    if (qLower.includes('week') || qLower.includes('trend') || qLower.includes('volatil') || qLower.includes('swing') || qLower.includes('history')) {
      if (typeLower === 'weekly_price_analysis') score += 0.25;
    }
    if (qLower.includes('feature') || qLower.includes('spec') || qLower.includes('detail') || qLower.includes('what is')) {
      if (typeLower === 'product_features' || typeLower === 'product_description') score += 0.25;
    }

    scoredChunks.push({
      chunkId: chunk.chunkId,
      score: Math.min(0.99, Math.max(0.1, Number(score.toFixed(4)))),
      chunkType: chunk.chunkType,
      productId: chunk.productId,
      title: chunk.metadata?.title || '',
      chunkText: chunk.chunkText,
      metadata: chunk.metadata
    });
  }

  // Sort descending by vector similarity score
  scoredChunks.sort((a, b) => b.score - a.score);

  // Return the top K most relevant chunks
  const topMatches = scoredChunks.slice(0, topK);
  console.log(`[RAG Retriever] Selected ${topMatches.length} chunks via vector cosine ranking (top score: ${topMatches[0]?.score || 0}, type: ${topMatches[0]?.chunkType || 'none'})`);

  return {
    query,
    topK,
    matches: topMatches,
    source: hasPinecone ? 'pinecone' : 'local_vector'
  };
};
