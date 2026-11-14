import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import axios from 'axios';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [accessToken, setAccessToken] = useState(
    localStorage.getItem('accessToken') || localStorage.getItem('token')
  );
  const [refreshToken, setRefreshToken] = useState(localStorage.getItem('refreshToken'));
  const [loading, setLoading] = useState(true);

  // Keep a ref to refreshToken and accessToken for interceptors
  const refreshTokenRef = useRef(refreshToken);
  refreshTokenRef.current = refreshToken;
  const isRefreshingRef = useRef(false);
  const refreshSubscribersRef = useRef([]);

  const subscribeTokenRefresh = (cb) => {
    refreshSubscribersRef.current.push(cb);
  };

  const onRefreshed = (newAccessToken) => {
    refreshSubscribersRef.current.forEach((cb) => cb(newAccessToken));
    refreshSubscribersRef.current = [];
  };

  // Helper to store tokens
  const saveTokens = (newAccessToken, newRefreshToken) => {
    if (newAccessToken) {
      localStorage.setItem('accessToken', newAccessToken);
      localStorage.setItem('token', newAccessToken); // For backwards compatibility
      setAccessToken(newAccessToken);
      axios.defaults.headers.common['Authorization'] = `Bearer ${newAccessToken}`;
    }
    if (newRefreshToken) {
      localStorage.setItem('refreshToken', newRefreshToken);
      setRefreshToken(newRefreshToken);
      refreshTokenRef.current = newRefreshToken;
    }
  };

  // Helper to clear tokens
  const clearTokens = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('token');
    setAccessToken(null);
    setRefreshToken(null);
    refreshTokenRef.current = null;
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  // Setup Axios interceptors
  useEffect(() => {
    // Request interceptor: attach access token
    const reqInterceptor = axios.interceptors.request.use(
      (config) => {
        const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
        if (token && !config.headers['Authorization']) {
          config.headers['Authorization'] = `Bearer ${token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor: handle 401 with refresh token
    const resInterceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Skip auth endpoints to prevent infinite refresh loops
        const isAuthRoute =
          originalRequest.url?.includes('/api/auth/login') ||
          originalRequest.url?.includes('/api/auth/register') ||
          originalRequest.url?.includes('/api/auth/refresh');

        if (error.response?.status === 401 && !originalRequest._retry && !isAuthRoute) {
          const currentRefreshToken = refreshTokenRef.current;

          if (!currentRefreshToken) {
            clearTokens();
            return Promise.reject(error);
          }

          if (isRefreshingRef.current) {
            // Another refresh is in flight, queue this request
            return new Promise((resolve) => {
              subscribeTokenRefresh((newAccessToken) => {
                originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;
                resolve(axios(originalRequest));
              });
            });
          }

          originalRequest._retry = true;
          isRefreshingRef.current = true;

          try {
            const { data } = await axios.post('/api/auth/refresh', {
              refreshToken: currentRefreshToken
            });

            const newAccessToken = data.accessToken || data.token;
            const newRefreshToken = data.refreshToken;

            saveTokens(newAccessToken, newRefreshToken);
            isRefreshingRef.current = false;
            onRefreshed(newAccessToken);

            originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;
            return axios(originalRequest);
          } catch (refreshErr) {
            isRefreshingRef.current = false;
            refreshSubscribersRef.current = [];
            clearTokens();
            return Promise.reject(refreshErr);
          }
        }

        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.request.eject(reqInterceptor);
      axios.interceptors.response.eject(resInterceptor);
    };
  }, []);

  // Initial user verification on load
  useEffect(() => {
    const verifyUser = async () => {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      if (token) {
        try {
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
          const response = await axios.get('/api/auth/me');
          setUser(response.data);
        } catch (error) {
          console.error('Initial user verification failed:', error);
          // If refresh token exists, the interceptor may have attempted or failed
          if (!localStorage.getItem('refreshToken')) {
            clearTokens();
          }
        }
      }
      setLoading(false);
    };

    verifyUser();
  }, []);

  const login = async (email, password) => {
    try {
      const response = await axios.post('/api/auth/login', { email, password });
      const { accessToken: newAccess, refreshToken: newRefresh, token: legacyToken, user: userData } = response.data;
      
      const currentAccess = newAccess || legacyToken;
      saveTokens(currentAccess, newRefresh);
      setUser(userData);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || 'Login failed'
      };
    }
  };

  const register = async (name, email, password) => {
    try {
      const response = await axios.post('/api/auth/register', { name, email, password });
      const { accessToken: newAccess, refreshToken: newRefresh, token: legacyToken, user: userData } = response.data;
      
      const currentAccess = newAccess || legacyToken;
      saveTokens(currentAccess, newRefresh);
      setUser(userData);
      
      return { success: true };
    } catch (error) {
      return {
        success: false,
        message: error.response?.data?.message || 'Registration failed'
      };
    }
  };

  const logout = async () => {
    const currentRefreshToken = refreshTokenRef.current;
    if (currentRefreshToken) {
      try {
        await axios.post('/api/auth/logout', { refreshToken: currentRefreshToken });
      } catch (err) {
        console.warn('Logout server request error:', err.message);
      }
    }
    clearTokens();
  };

  const value = {
    user,
    accessToken,
    refreshToken,
    token: accessToken, // Backwards compatibility for components expecting `token`
    loading,
    login,
    register,
    logout,
    isAuthenticated: !!accessToken
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
