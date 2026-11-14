export const buildSellerIntelligencePrompt = ({ query, retrievedChunks, productTitle, metrics }) => {
  let prompt = `You are a precision e-commerce pricing intelligence assistant for the product: "${productTitle || 'Tracked Competitor Product'}".

INSTRUCTIONS:
1. Answer the user's specific question directly, concisely, and accurately based strictly on the retrieved competitor data below.
2. Focus ONLY on answering what was asked. DO NOT regurgitate all retrieved chunks, and do NOT provide irrelevant background info.
3. Keep the response crisp (typically 2 to 4 bullet points or a concise paragraph) highlighting exact prices, percentages, or dates.
4. If the question asks for a recommendation or strategy, provide actionable seller guidance in 2-3 bullet points.

USER QUESTION:
"${query}"

RETRIEVED VECTOR CONTEXT:
`;

  retrievedChunks.forEach((chunk, index) => {
    prompt += `--- Source ${index + 1} (${chunk.chunkType}) [Similarity: ${(chunk.score * 100).toFixed(0)}%] ---
${chunk.chunkText}
\n`;
  });

  if (metrics) {
    prompt += `KEY PRICE METRICS:\n${JSON.stringify(metrics, null, 2)}\n\n`;
  }

  return prompt;
};
