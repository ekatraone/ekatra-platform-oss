/**
 * Telegram Service - Backend API version
 */

import { api } from './apiClient';

export const getTelegramAnalytics = async () => {
  try {
    return await api.getAnalytics();
  } catch (error) {
    console.error("Error fetching Telegram analytics:", error);
    return { totalUsers: 0, activeUsers: 0, messages: 0 };
  }
};

export const sendTelegramMessage = async (chatId: string, message: string) => {
  try {
    return await api.sendMessage(chatId, { type: 'text', content: message });
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    throw error;
  }
};

export const fetchTelegramUpdates = async () => {
  // Get recent Telegram updates/messages
  try {
    return await api.getAnalytics();
  } catch (error) {
    console.error("Error fetching Telegram updates:", error);
    return [];
  }
};

export const telegramService = {
  getAnalytics: getTelegramAnalytics,
  sendMessage: sendTelegramMessage,
  fetchUpdates: fetchTelegramUpdates,
};
