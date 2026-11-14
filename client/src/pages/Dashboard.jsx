import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../context/AuthContext';
import axios from 'axios';
import './Dashboard.css';

const Dashboard = () => {
  const { user, logout } = useAuth();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addingProduct, setAddingProduct] = useState(false);
  const [productUrl, setProductUrl] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshingId, setRefreshingId] = useState(null);
  const [priceAlerts, setPriceAlerts] = useState({}); // Track price alerts per product

  // AI Strategic Repricing Modal State
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiResponse, setAiResponse] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);

  // Product-Specific "Ask AI" Modal State
  const [askAiModalOpen, setAskAiModalOpen] = useState(false);
  const [askAiProduct, setAskAiProduct] = useState(null);
  const [askAiQuery, setAskAiQuery] = useState('');
  const [askAiAnswer, setAskAiAnswer] = useState('');
  const [askAiLoading, setAskAiLoading] = useState(false);

  const ALERT_STORAGE_KEY = 'priceAlerts';
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const isExpired = (alert) => {
    if (!alert || !alert.firstDetectedAt) return true;
    return Date.now() - alert.firstDetectedAt > ONE_DAY_MS;
  };

  useEffect(() => {
    fetchProducts();
  }, []);

  // Load persisted alerts from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ALERT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) || {};
        // prune expired
        const pruned = Object.fromEntries(
          Object.entries(parsed).filter(([, a]) => a && a.firstDetectedAt && Date.now() - a.firstDetectedAt <= ONE_DAY_MS && !a.acknowledged)
        );
        setPriceAlerts(pruned);
      }
    } catch (e) {
      // ignore storage errors
    }
  }, []);

  // Persist alerts to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(priceAlerts));
    } catch (e) {
      // ignore storage errors
    }
  }, [priceAlerts]);

  const fetchProducts = async () => {
    try {
      const response = await axios.get('/api/products');
      setProducts(response.data);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching products:', error);
      setError('Failed to load products');
      setLoading(false);
    }
  };

  const handleAddProduct = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setAddingProduct(true);

    try {
      const response = await axios.post('/api/products', { url: productUrl });
      setProducts([response.data, ...products]);
      setProductUrl('');
      setSuccess('Product added successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      setError(error.response?.data?.message || 'Failed to add product');
    } finally {
      setAddingProduct(false);
    }
  };

  const acknowledgeAlert = (productId) => {
    setPriceAlerts(prev => {
      const next = { ...prev };
      if (next[productId]) {
        next[productId] = { ...next[productId], acknowledged: true };
      }
      return next;
    });
  };

  const handleDismissPriceChange = async (productId) => {
    try {
      await axios.put(`/api/products/${productId}/dismiss-change`);
      setProducts(prev =>
        prev.map(p => (p._id === productId ? { ...p, priceChanged: false } : p))
      );
      acknowledgeAlert(productId);
    } catch (err) {
      console.error('Error dismissing price change badge:', err);
      setProducts(prev =>
        prev.map(p => (p._id === productId ? { ...p, priceChanged: false } : p))
      );
    }
  };

  const handleAIAction = async (product, priceAlert) => {
    setSelectedProduct(product);
    setAiModalOpen(true);
    setAiResponse('');
    setAiLoading(true);

    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      
      let oldPrice = priceAlert?.oldPrice || product.previousPrice;
      let newPrice = priceAlert?.newPrice || product.currentPrice;

      if (!oldPrice) {
        const history = product.priceHistory || [];
        const distinct = [...history].reverse().find(h => h.price !== newPrice);
        if (distinct) {
          oldPrice = distinct.price;
        } else if (history.length > 1) {
          oldPrice = history[0].price;
        } else {
          oldPrice = newPrice;
        }
      }

      const response = await fetch(`/api/products/${product._id}/ai-action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          oldPrice,
          newPrice
        })
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              setAiLoading(false);
              break;
            }
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                fullResponse += parsed.content;
                setAiResponse(fullResponse);
              }
              if (parsed.error) {
                setAiResponse(`### AI Notice\n${parsed.error}`);
                setAiLoading(false);
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    } catch (error) {
      console.error('AI action error:', error);
      setAiResponse('Error: Could not connect to AI service. Please ensure the server is running.');
      setAiLoading(false);
    }
  };

  // Product-Specific "Ask AI" Handlers
  const handleOpenAskAI = (product) => {
    setAskAiProduct(product);
    setAskAiModalOpen(true);
    setAskAiQuery('');
    setAskAiAnswer('');
  };

  const handleCloseAskAI = () => {
    setAskAiModalOpen(false);
    setAskAiProduct(null);
    setAskAiQuery('');
    setAskAiAnswer('');
  };

  const handleAskProductAI = async (e, customPrompt) => {
    if (e && e.preventDefault) e.preventDefault();
    const promptToSend = customPrompt || askAiQuery;
    if (!promptToSend || !promptToSend.trim() || !askAiProduct) return;

    setAskAiLoading(true);
    setAskAiAnswer('');

    try {
      // Direct call to product-scoped AI endpoint
      const response = await axios.post(`/api/products/${askAiProduct._id}/ask-ai`, {
        query: promptToSend
      });

      if (response.data) {
        setAskAiAnswer(response.data.answer || 'No answer generated.');
      }
    } catch (err) {
      console.warn('Direct product ask-ai error, falling back to /api/rag/query:', err.message);
      try {
        const fallbackRes = await axios.post('/api/rag/query', {
          query: promptToSend,
          productId: askAiProduct._id,
          topK: 3
        });
        if (fallbackRes.data) {
          setAskAiAnswer(fallbackRes.data.answer || 'No answer generated.');
        }
      } catch (fErr) {
        setAskAiAnswer(`Error generating targeted answer: ${err.response?.data?.message || err.message}`);
      }
    } finally {
      setAskAiLoading(false);
    }
  };

  const handleRefreshPrice = async (productId) => {
    setRefreshingId(productId);
    setError('');
    
    try {
      const product = products.find(p => p._id === productId);
      const oldPrice = product.currentPrice;
      
      const response = await axios.put(`/api/products/${productId}/refresh`);
      const newProduct = response.data;
      
      // Update products list
      setProducts(products => products.map(p => p._id === productId ? newProduct : p));
      
      // Check for price change and update alert
      if (newProduct.currentPrice !== oldPrice || newProduct.priceChanged) {
        const alert = {
          oldPrice: newProduct.previousPrice || oldPrice,
          newPrice: newProduct.currentPrice,
          firstDetectedAt: Date.now(),
          acknowledged: false
        };
        
        setPriceAlerts(prev => ({ ...prev, [productId]: alert }));
        setSuccess(`Price change detected: ${formatPrice(alert.oldPrice, newProduct.currency)} → ${formatPrice(newProduct.currentPrice, newProduct.currency)}! AI Strategy ready.`);
      } else {
        setSuccess('Price updated successfully (no change detected).');
      }
      
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      setError(error.response?.data?.message || 'Failed to refresh price');
    } finally {
      setRefreshingId(null);
    }
  };

  const handleDeleteProduct = async (productId) => {
    if (!window.confirm('Are you sure you want to delete this product?')) {
      return;
    }

    try {
      await axios.delete(`/api/products/${productId}`);
      setProducts(products.filter(p => p._id !== productId));
      setSuccess('Product deleted successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      setError('Failed to delete product');
    }
  };

  const formatPrice = (price, currency) => {
    const locale = currency === 'USD' ? 'en-US' : 'en-IN';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: currency || 'USD'
    }).format(price);
  };

  const handleDownloadCSV = async (productId, productTitle) => {
    try {
      const response = await axios.get(`/api/products/${productId}/csv`, {
        responseType: 'blob'
      });
      
      const shortTitle = productTitle.substring(0, 25).replace(/[^a-z0-9]/gi, '_');
      const filename = `${shortTitle}_prices.csv`;
      
      const blob = new Blob([response.data], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);
      
      setSuccess('CSV downloaded successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      console.error('CSV download error:', error);
      setError(`Failed to download CSV: ${error.message}`);
      setTimeout(() => setError(''), 5000);
    }
  };

  const handleDownloadSummary = async (productId, productTitle) => {
    try {
      const response = await axios.get(`/api/products/${productId}/summary`, {
        responseType: 'blob'
      });
      
      const shortTitle = productTitle.substring(0, 25).replace(/[^a-z0-9]/gi, '_');
      const filename = `${shortTitle}_summary.txt`;
      
      const blob = new Blob([response.data], { type: 'text/plain' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', filename);
      document.body.appendChild(link);
      link.click();
      
      setTimeout(() => {
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      }, 100);
      
      setSuccess('Summary downloaded successfully!');
      setTimeout(() => setSuccess(''), 3000);
    } catch (error) {
      console.error('Summary download error:', error);
      setError(`Failed to download summary: ${error.message}`);
      setTimeout(() => setError(''), 5000);
    }
  };

  const formatDate = (date) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  return (
    <div className="dashboard">
      <nav className="navbar">
        <div className="container nav-content">
          <div className="nav-brand">
            <h2 style={{ letterSpacing: '1px', fontWeight: '800' }}>COMPETITIVE TRACKER</h2>
          </div>
          <div className="nav-user">
            <span>Welcome, {user?.name}!</span>
            <button onClick={logout} className="btn btn-secondary btn-sm">
              Logout
            </button>
          </div>
        </div>
      </nav>

      <main className="main-content">
        <div className="container">
          <div className="dashboard-header">
            <div>
              <h1>Competitor Intelligence</h1>
              <p>Professional competitor monitoring and strategic price analysis</p>
            </div>
            <div className="stats">
              <div className="stat-card">
                <div>
                  <div className="stat-value">{products.length}</div>
                  <div className="stat-label">Competitors Tracked</div>
                </div>
              </div>
            </div>
          </div>

          {error && (
            <div className="alert alert-error">
              {error}
            </div>
          )}

          {success && (
            <div className="alert alert-success">
              {success}
            </div>
          )}

          {/* Add Competitor Product Section */}
          <div className="add-product-section card">
            <h3>Add Competitor Product</h3>
            <form onSubmit={handleAddProduct} className="add-product-form">
              <input
                type="url"
                className="input"
                placeholder="Paste competitor's product URL to track their pricing"
                value={productUrl}
                onChange={(e) => setProductUrl(e.target.value)}
                required
              />
              <button 
                type="submit" 
                className="btn btn-primary"
                disabled={addingProduct}
              >
                {addingProduct ? 'Adding...' : 'Track Competitor'}
              </button>
            </form>
          </div>

          {loading ? (
            <div className="loading-container">
              <div className="spinner"></div>
              <p>Loading products...</p>
            </div>
          ) : products.length === 0 ? (
            <div className="empty-state">
              <h3>No competitors tracked yet</h3>
              <p>Add your first competitor product to start monitoring their pricing strategy</p>
            </div>
          ) : (
            <div className="products-grid">
              {products.map((product) => {
                const priceAlert = priceAlerts[product._id];
                const hasExplicitPriceChange = Boolean(
                  product.priceChanged || 
                  (product.previousPrice && product.previousPrice !== product.currentPrice) ||
                  (priceAlert && !priceAlert.acknowledged && !isExpired(priceAlert))
                );

                const oldRefPrice = product.previousPrice || priceAlert?.oldPrice;
                const isPriceDrop = oldRefPrice ? product.currentPrice < oldRefPrice : false;
                
                return (
                <div key={product._id} className={`product-card card ${hasExplicitPriceChange ? 'price-changed' : ''}`}>
                  {product.imageUrl && (
                    <div className="product-image">
                      <img src={product.imageUrl} alt={product.title} />
                    </div>
                  )}
                  <div className="product-content">
                    <div className="product-header">
                      <span className="platform-badge">{product.platform}</span>
                      {product.priceHistory && product.priceHistory.length >= 30 && (
                        <span className="history-badge">
                          180D History
                        </span>
                      )}
                      <h3 className="product-title">{product.title}</h3>
                    </div>

                    {/* Price Changed Symbol & AI Strategy Action Badge */}
                    {hasExplicitPriceChange && (
                      <div className={`price-changed-badge ${isPriceDrop ? 'drop' : 'rise'}`}>
                        <div className="symbol-text">
                          <span className="badge-icon">{isPriceDrop ? '📉' : '📈'}</span>
                          <span>
                            <strong>Price {isPriceDrop ? 'Dropped' : 'Changed'}:</strong>{' '}
                            {oldRefPrice ? `${formatPrice(oldRefPrice, product.currency)} → ` : ''}
                            {formatPrice(product.currentPrice, product.currency)}
                          </span>
                        </div>
                        <div className="symbol-actions">
                          <button
                            className="btn-take-strategy"
                            onClick={() => handleAIAction(product, {
                              oldPrice: oldRefPrice || product.currentPrice,
                              newPrice: product.currentPrice
                            })}
                            title="Analyze competitor price change and get AI strategy"
                          >
                            Take AI Strategy
                          </button>
                          <button
                            className="btn-dismiss-badge"
                            onClick={() => handleDismissPriceChange(product._id)}
                            title="Dismiss price change indicator"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    )}
                    
                    <div className="product-price">
                      <div>
                        <div className="price-current">
                          {formatPrice(product.currentPrice, product.currency)}
                        </div>
                        <div className="price-label">Current Price</div>
                      </div>
                    </div>

                    <div className="product-meta">
                      <div className="meta-item">
                        <span className="meta-label">Added:</span>
                        <span className="meta-value">{formatDate(product.createdAt)}</span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">History:</span>
                        <span className="meta-value">
                          {product.priceHistory?.length ? `${product.priceHistory.length} days` : '1 day'}
                        </span>
                      </div>
                      <div className="meta-item">
                        <span className="meta-label">Last Checked:</span>
                        <span className="meta-value">{formatDate(product.lastChecked)}</span>
                      </div>
                    </div>

                    <div className="product-actions">
                      {/* Product-Specific Ask AI Button */}
                      <button
                        onClick={() => handleOpenAskAI(product)}
                        className="btn btn-primary btn-sm btn-ask-ai"
                        title="Ask AI questions specifically about this competitor product"
                      >
                        💬 Ask AI
                      </button>

                      {/* AI Strategy Modal Button */}
                      <button
                        onClick={() => handleAIAction(product, {
                          oldPrice: oldRefPrice || product.currentPrice,
                          newPrice: product.currentPrice
                        })}
                        className="btn btn-primary btn-sm"
                        title="Get Gemini AI Competitive Strategy & RAG Insights"
                        style={{ background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)', color: '#fff', border: 'none', fontWeight: 'bold' }}
                      >
                        AI Strategy
                      </button>

                      <a 
                        href={product.url} 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="btn btn-secondary btn-sm"
                      >
                        View
                      </a>
                      <button
                        onClick={() => handleRefreshPrice(product._id)}
                        className="btn btn-secondary btn-sm"
                        disabled={refreshingId === product._id}
                      >
                        {refreshingId === product._id ? 'Refreshing...' : 'Refresh'}
                      </button>
                      <button
                        onClick={() => handleDownloadCSV(product._id, product.title)}
                        className="btn btn-secondary btn-sm"
                        title="Download 180-day price history as CSV"
                      >
                        CSV
                      </button>
                      <button
                        onClick={() => handleDownloadSummary(product._id, product.title)}
                        className="btn btn-secondary btn-sm"
                        title="Download contextual intelligence summary"
                      >
                        Summary
                      </button>
                      <button
                        onClick={() => handleDeleteProduct(product._id)}
                        className="btn btn-danger btn-sm"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Product-Specific "Ask AI" Modal */}
      {askAiModalOpen && askAiProduct && (
        <div className="modal-overlay" onClick={handleCloseAskAI}>
          <div className="modal-content ai-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>💬 Ask AI about Competitor Product</h2>
              </div>
              <button 
                className="modal-close" 
                onClick={handleCloseAskAI}
                aria-label="Close modal"
              >
                Close
              </button>
            </div>

            <div className="modal-product-info">
              <h3>{askAiProduct.title}</h3>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' }}>
                <span className="platform-badge">{askAiProduct.platform}</span>
                <span className="platform-badge" style={{ background: 'rgba(14, 165, 233, 0.15)', color: '#0284c7' }}>
                  Current Price: {formatPrice(askAiProduct.currentPrice, askAiProduct.currency)}
                </span>
                {askAiProduct.priceHistory?.length > 0 && (
                  <span className="history-badge">
                    {askAiProduct.priceHistory.length} Days 180D Real History
                  </span>
                )}
              </div>
            </div>

            <div className="rag-indicator">
              <div className="rag-badge">
                <span>⚡ 180-Day Competitor Price Movement & Strategic Repricing Analysis</span>
              </div>
            </div>

            <div className="modal-body">
              <form onSubmit={handleAskProductAI} className="rag-form" style={{ marginTop: '4px' }}>
                <input
                  type="text"
                  className="input"
                  placeholder={`Ask a specific question about ${askAiProduct.title.substring(0, 30)}...`}
                  value={askAiQuery}
                  onChange={(e) => setAskAiQuery(e.target.value)}
                  disabled={askAiLoading}
                  autoFocus
                />
                <button 
                  type="submit" 
                  className="btn btn-primary" 
                  disabled={askAiLoading || !askAiQuery.trim()}
                  style={{ background: '#0284c7' }}
                >
                  {askAiLoading ? 'Analyzing...' : 'Ask AI'}
                </button>
              </form>

              <div className="ask-ai-chips">
                {[
                  "What was the lowest price for this product in 180 days?",
                  "Is the current price above or below its 180-day average?",
                  "When did this competitor last change their price?",
                  "What repricing strategy should I use against this competitor?",
                  "How volatile is this competitor's pricing?"
                ].map((prompt, i) => (
                  <button
                    key={i}
                    type="button"
                    className="ask-ai-chip"
                    onClick={() => {
                      setAskAiQuery(prompt);
                      handleAskProductAI(null, prompt);
                    }}
                  >
                    💡 {prompt}
                  </button>
                ))}
              </div>

              {askAiLoading && (
                <div className="ai-loading" style={{ margin: '20px 0' }}>
                  <div className="spinner"></div>
                  <p>Analyzing competitor's 180-day price history...</p>
                  <p className="rag-status">Generating focused answer for your question...</p>
                </div>
              )}

              {askAiAnswer && (
                <div className="ask-ai-answer-card">
                  <div className="rag-answer-header">
                    <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>🎯</span> Focused Answer
                    </span>
                    <button
                      className="btn-dismiss-badge"
                      onClick={() => setAskAiAnswer('')}
                      title="Clear answer"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="rag-answer-body">
                    <ReactMarkdown>{askAiAnswer}</ReactMarkdown>
                  </div>
                </div>
              )}

              {!askAiLoading && !askAiAnswer && (
                <div className="ai-waiting" style={{ padding: '24px 0' }}>
                  <p>Type a question above or click one of the suggestion chips to get instant, focused AI analysis for this product.</p>
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={handleCloseAskAI}
              >
                Close
              </button>
              <a
                href={askAiProduct.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                View Listing
              </a>
            </div>
          </div>
        </div>
      )}

      {/* AI Strategic Repricing Modal */}
      {aiModalOpen && (
        <div className="modal-overlay" onClick={() => setAiModalOpen(false)}>
          <div className="modal-content ai-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <h2>Competitive Strategy Analysis</h2>
              </div>
              <button 
                className="modal-close" 
                onClick={() => setAiModalOpen(false)}
                aria-label="Close modal"
              >
                Close
              </button>
            </div>
            
            {selectedProduct && (
              <div className="modal-product-info">
                <h3>Competitor: {selectedProduct.title}</h3>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                  <span className="platform-badge">{selectedProduct.platform}</span>
                  <span className="platform-badge" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#4f46e5' }}>
                    Current: {formatPrice(selectedProduct.currentPrice, selectedProduct.currency)}
                  </span>
                  {selectedProduct.priceHistory?.length > 0 && (
                    <span className="history-badge">
                      {selectedProduct.priceHistory.length} Days History
                    </span>
                  )}
                </div>
              </div>
            )}
            
            <div className="rag-indicator">
              <div className="rag-badge">
                <span>180-Day Competitor Price Movement & Strategic Repricing Analysis</span>
              </div>
            </div>
            
            <div className="modal-body">
              {aiLoading && (
                <div className="ai-loading">
                  <div className="spinner"></div>
                  <p>Loading competitor's historical price summary...</p>
                  <p className="rag-status">Processing 180-day price history...</p>
                  <p className="rag-status">Analyzing competitive strategy...</p>
                </div>
              )}
              
              {aiResponse && (
                <div className="ai-response">
                  <div className="response-content">
                    <ReactMarkdown>{aiResponse}</ReactMarkdown>
                  </div>
                </div>
              )}
              
              {!aiLoading && !aiResponse && (
                <div className="ai-waiting">
                  <p>Waiting for AI response...</p>
                </div>
              )}
            </div>
            
            <div className="modal-footer">
              <button 
                className="btn btn-secondary"
                onClick={() => setAiModalOpen(false)}
              >
                Close
              </button>
              {selectedProduct && (
                <a
                  href={selectedProduct.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-primary"
                >
                  View Competitor Product
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
