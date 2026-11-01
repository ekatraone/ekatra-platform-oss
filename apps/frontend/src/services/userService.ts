/**
 * User Service - Backend API version
 * Replaces Supabase user management with backend API calls
 */

import { api } from './apiClient';

import type { UserRole } from '../lib/types/user';
export type { UserRole } from '../lib/types/user';

export interface AppUser {
  id: string;
  email: string;
  name?: string;
  role: UserRole;
  created_at?: string;
}

export interface UserUpdatePayload {
  name?: string;
  email?: string;
  role?: UserRole;
}

/**
 * Fetch all users (admin only)
 */
export const fetchUsersList = async (): Promise<AppUser[]> => {
  try {
    const response = await api.getUsers() as any;
    return response?.data || response || [];
  } catch (error) {
    console.error("Error fetching users:", error);
    return [];
  }
};

/**
 * Invite a new user
 */
export const inviteUser = async (email: string, role: UserRole) => {
  try {
    return await api.createUser({ email, role });
  } catch (error) {
    console.error("Error inviting user:", error);
    throw error;
  }
};

/**
 * Update user profile
 */
export const updateUserProfile = async (userId: string, updates: UserUpdatePayload) => {
  try {
    return await api.updateUser(userId, updates);
  } catch (error) {
    console.error("Error updating user:", error);
    throw error;
  }
};

/**
 * Delete user
 */
export const deleteUser = async (userId: string) => {
  try {
    return await api.deleteUser(userId);
  } catch (error) {
    console.error("Error deleting user:", error);
    throw error;
  }
};

// Alias for backwards compatibility
export const deleteUserAccount = deleteUser;

/**
 * Get current user from localStorage
 */
export const getCurrentUser = (): AppUser | null => {
  try {
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
  } catch (error) {
    return null;
  }
};
