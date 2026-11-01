/**
 * WhatsApp Service - Backend API version
 */

import { api } from './apiClient';
import { fetchAllPages } from '@/lib/api/pagination';

// Addressed by learner id (not phone): /api/learners/:id/send-message looks the learner up by id.
export const sendWhatsAppMessage = async (learnerId: string, message: string) => {
  try {
    return await api.sendMessage(learnerId, { type: 'text', content: message });
  } catch (error) {
    console.error("Error sending WhatsApp message:", error);
    throw error;
  }
};

export const sendTestMessage = async (learnerId: string, message?: string) => {
  return sendWhatsAppMessage(learnerId, message || 'Test message from Ekatra');
};

export const getWhatsAppChatHistory = async (phone: string) => {
  try {
    return (await api.getChatHistory(phone)).data;
  } catch (error) {
    console.error("Error fetching chat history:", error);
    return [];
  }
};

export const fetchWhatsAppMessages = getWhatsAppChatHistory;

export const fetchWhatsAppAnalytics = async () => {
  try {
    return await api.getAnalytics();
  } catch (error) {
    console.error("Error fetching WhatsApp analytics:", error);
    return { totalMessages: 0, activeConversations: 0 };
  }
};

export const fetchWhatsAppTemplates = async () => {
  // Templates would come from WhatsApp Cloud API
  return [];
};

export const fetchContacts = async () => {
  try {
    // The server serves at most 100 rows per page; walk them all.
    return await fetchAllPages((page, limit) => api.getLearners({ page, limit }) as any);
  } catch (error) {
    console.error("Error fetching contacts:", error);
    return [];
  }
};

export const syncWhatsAppTemplates = async () => {
  // Sync templates from WhatsApp Cloud API
  console.log("Template sync not implemented - requires WhatsApp Business API");
  return [];
};

export const syncWhatsAppContacts = async () => {
  // Sync contacts
  return fetchContacts();
};

export const whatsappService = {
  sendMessage: sendWhatsAppMessage,
  sendTestMessage,
  getChatHistory: getWhatsAppChatHistory,
  fetchMessages: fetchWhatsAppMessages,
  fetchAnalytics: fetchWhatsAppAnalytics,
  fetchTemplates: fetchWhatsAppTemplates,
  fetchContacts,
  syncTemplates: syncWhatsAppTemplates,
  syncContacts: syncWhatsAppContacts,
};
