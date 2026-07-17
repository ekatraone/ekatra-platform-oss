/**
 * Admin Service - Backend API version
 * Replaces Supabase admin functions with backend API calls
 */

import { api } from './apiClient';

/**
 * Check if the current user has admin privileges
 */
export const checkAdminAccess = async (): Promise<boolean> => {
  try {
    const user = localStorage.getItem('user');
    if (!user) return false;
    
    const userData = JSON.parse(user);
    return userData.role === 'admin' || userData.role === 'super_admin';
  } catch (error) {
    console.error("Error checking admin access:", error);
    return false;
  }
};

/**
 * Get current user
 */
export const getCurrentUser = async () => {
  try {
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
  } catch (error) {
    console.error("Error getting current user:", error);
    return null;
  }
};

/**
 * Get admin dashboard stats
 */
export const getAdminStats = async () => {
  try {
    return await api.getStats();
  } catch (error) {
    console.error("Error fetching admin stats:", error);
    throw error;
  }
};

/**
 * Admin service object for backwards compatibility
 */
export const adminService = {
  checkAdminAccess,
  getCurrentUser,
  getAdminStats,
  fetchUsers: async () => {
    const response = await api.getUsers() as any;
    return response?.data || response || [];
  },
  inviteUser: async (email: string, role: string) => {
    return await api.createUser({ email, role });
  },
  updateUser: async (userId: string, data: any) => {
    return await api.updateUser(userId, data);
  },
  deleteUser: async (userId: string) => {
    return await api.deleteUser(userId);
  }
};
