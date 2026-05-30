import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User } from '../api/types';
import { tokenStorage } from '../api/tokens';

// Helper function to check if JWT token is expired
const isTokenExpired = (token: string): boolean => {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    const currentTime = Date.now() / 1000;
    return payload.exp < currentTime;
  } catch {
    return true; // If token is malformed, consider it expired
  }
};

interface AuthContextValue {
  user: User | null;
  setUser: (user: User | null) => void;
  isAuthenticated: boolean;
  isLoading: boolean;
  clearAuth: () => void;
  login: (accessToken: string, refreshToken: string, user: User) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUserState] = useState<User | null>(() => {
    try {
      const raw = localStorage.getItem('user');
      return raw ? (JSON.parse(raw) as User) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    // Check token expiration on app load
    const checkTokenExpiration = () => {
      const accessToken = tokenStorage.getAccessToken();
      
      if (accessToken && isTokenExpired(accessToken)) {
        // Token is expired, clear auth state
        console.warn('Access token expired, clearing authentication state');
        tokenStorage.clearTokens();
        setUserState(null);
        localStorage.removeItem('user');
      } else if (!accessToken) {
        // No token, clear user state
        setUserState(null);
        localStorage.removeItem('user');
      }
      
      setIsLoading(false);
    };

    checkTokenExpiration();

    // Set up periodic token expiration check (every 5 minutes)
    const interval = setInterval(checkTokenExpiration, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (user) {
      try {
        localStorage.setItem('user', JSON.stringify(user));
      } catch {}
      return;
    }

    localStorage.removeItem('user');
    tokenStorage.clearTokens();
  }, [user]);

  const setUser = (nextUser: User | null) => setUserState(nextUser);

  const clearAuth = () => {
    setUserState(null);
    tokenStorage.clearTokens();
    localStorage.removeItem('user');
  };

  const login = (accessToken: string, refreshToken: string, nextUser: User) => {
    // Validate token before setting
    if (isTokenExpired(accessToken)) {
      console.error('Attempted to login with expired token');
      return;
    }
    
    tokenStorage.setAccessToken(accessToken);
    tokenStorage.setRefreshToken(refreshToken);
    setUserState(nextUser);
  };

  // Check if user is authenticated (has valid token and user data)
  const isAuthenticated = !!user && !!tokenStorage.getAccessToken() && !isTokenExpired(tokenStorage.getAccessToken()!);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        setUser,
        isAuthenticated,
        isLoading,
        clearAuth,
        login,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
