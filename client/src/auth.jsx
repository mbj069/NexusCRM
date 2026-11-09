import { createContext, useContext, useEffect, useState } from 'react';
import { getStoredUser, setStoredUser, clearSession, setToken, post } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUser(getStoredUser());
    setLoading(false);
  }, []);

  async function login(username, password) {
    const data = await post('/api/auth/login', { username, password });
    setToken(data.token);
    setStoredUser(data.user);
    setUser(data.user);
    return data.user;
  }

  async function changePassword(currentPassword, newPassword) {
    await post('/api/auth/change-password', { currentPassword, newPassword });
    // Password changed: clear the must-change flag locally.
    const updated = { ...user, mustChangePassword: false };
    setStoredUser(updated);
    setUser(updated);
  }

  function logout() {
    clearSession();
    setUser(null);
  }

  const value = {
    user,
    loading,
    login,
    logout,
    changePassword,
    isAdmin: user?.role === 'admin',
    isManager: user?.role === 'manager' || user?.role === 'admin',
    isAgent: user?.role === 'agent',
    // Lead assignment is a manager/admin capability.
    canAssign: user?.role === 'manager' || user?.role === 'admin',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
