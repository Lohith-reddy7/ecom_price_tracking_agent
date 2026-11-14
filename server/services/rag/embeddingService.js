import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Calculates cosine similarity between two normalized float vectors.
 */
export const cosineSimilarity = (vecA, vecB) => {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
};

/**
 * Deterministic, high-dimensional semantic vector generator (768 dimensions).
 * Computes normalized feature vectors with domain-specific pricing/volatility weightings.
 */
export const generateSemanticEmbedding = (text, dimensions = 768) => {
  const vec = new Float64Array(dimensions);
  if (!text || typeof text !== 'string') return Array.from(vec);

  const clean = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = clean.split(/\s+/).filter(t => t.length > 1);

  const pricingWeights = {
    lowest: 3.2, min: 3.0, minimum: 3.0, cheap: 2.6, dip: 2.6, bottom: 2.8,
    highest: 3.2, max: 3.0, maximum: 3.0, peak: 2.8, surge: 2.6, top: 2.6,
    average: 2.8, mean: 2.8, median: 2.8, baseline: 2.6, normal: 2.4,
    drop: 3.2, dropped: 3.2, decrease: 3.0, fell: 3.0, discount: 2.8, slash: 2.8,
    increase: 3.0, hike: 3.0, raised: 3.0, grew: 2.6, jump: 2.8,
    trend: 2.8, volatility: 3.0, volatile: 3.0, stable: 2.6, fluctuation: 2.8, range: 2.6,
    strategy: 3.2, recommend: 3.0, action: 2.8, undercut: 3.2, hold: 2.8, margin: 2.8, match: 2.8,
    week: 2.6, history: 2.8, days: 2.6, recent: 2.8, competitor: 2.6, price: 2.4
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const weight = pricingWeights[t] || 1.0;

    let h = 2166136261;
    for (let j = 0; j < t.length; j++) {
      h = Math.imul(h ^ t.charCodeAt(j), 16777619);
    }
    const idx = Math.abs(h) % dimensions;
    vec[idx] += weight;

    // Bi-gram
    if (i + 1 < tokens.length) {
      const bigram = `${t}_${tokens[i + 1]}`;
      let h2 = 2166136261;
      for (let j = 0; j < bigram.length; j++) {
        h2 = Math.imul(h2 ^ bigram.charCodeAt(j), 16777619);
      }
      const idx2 = Math.abs(h2) % dimensions;
      vec[idx2] += 1.8;
    }
  }

  // L2-Normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  }

  return Array.from(vec);
};

export const embedText = async (text) => {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  const isValidApiKey = apiKey && 
                        apiKey !== 'your_gemini_key' && 
                        apiKey !== 'your_api_key_here' && 
                        apiKey.length > 20;

  if (isValidApiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
      const model = genAI.getGenerativeModel({ model: embeddingModel });

      let cleanText = text.replace(/\s+/g, ' ').trim();
      if (cleanText.length > 8000) cleanText = cleanText.substring(0, 8000);

      const result = await model.embedContent(cleanText);
      if (result?.embedding?.values && result.embedding.values.length > 0) {
        return result.embedding.values;
      }
    } catch (err) {
      console.warn(`[EmbeddingService] Remote embedding failed (${err.message}). Using local 768-D semantic vectorizer.`);
    }
  }

  // Fallback to high-dimensional deterministic vectorizer
  return generateSemanticEmbedding(text, 768);
};

export const embedBatch = async (texts) => {
  return await Promise.all(texts.map(text => embedText(text)));
};
