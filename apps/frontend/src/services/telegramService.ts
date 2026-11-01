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

// Addressed by learner id (not Telegram chat id): /api/learners/:id/send-message looks the learner up by id.
export const sendTelegramMessage = async (learnerId: string, message: string) => {
  try {
    return await api.sendMessage(learnerId, { type: 'text', content: message });
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    throw error;
  }
};

export const fetchTelegramUpdates = async (chatId?: string) => {
  if (!chatId) return [];
  const { data } = await api.getChatHistory(`tg:${chatId}`);
  return data.map(row => ({
    update_id: row.id,
    message: {
      chat: { id: chatId }, text: row.content || '',
      date: new Date(row.created_at).getTime() / 1000,
      from: { is_bot: row.direction === 'outbound' },
    },
  }));
};

export const telegramService = {
  getAnalytics: getTelegramAnalytics,
  sendMessage: sendTelegramMessage,
  fetchUpdates: fetchTelegramUpdates,
};
