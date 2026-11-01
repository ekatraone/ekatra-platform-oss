
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/services/apiClient";
import { fetchWhatsAppAnalytics } from "@/services/whatsappService";

interface AnalyticsData {
  totalUsers: number;
  activeCourses: number;
  completionRate: number;
  messagesSent: number;
  whatsappStats?: any;
  telegramStats?: any;
}

export const useAnalytics = () => {
  // Base analytics query
  const baseQuery = useQuery({
    queryKey: ["base-analytics"],
    queryFn: async (): Promise<Omit<AnalyticsData, 'whatsappStats' | 'telegramStats'>> => {
      const { data: stats } = await apiClient.getStats();
      
      return {
        totalUsers: stats.totalUsers || 0,
        activeCourses: stats.activeCourses || 0,
        completionRate: Math.round(stats.completionRate || 0),
        messagesSent: stats.messagesSent || 0
      };
    }
  });

  // WhatsApp analytics query
  const whatsappQuery = useQuery({
    queryKey: ["whatsapp-analytics"],
    queryFn: async () => {
      try {
        // Get last 30 days of analytics
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const startDate = thirtyDaysAgo.toISOString().split('T')[0];
        const endDate = new Date().toISOString().split('T')[0];
        
        return await fetchWhatsAppAnalytics();
      } catch (error) {
        console.error("Error fetching WhatsApp analytics:", error);
        return null;
      }
    },
    enabled: true // Always fetch WhatsApp analytics
  });

  // Telegram analytics query
  const telegramQuery = useQuery({
    queryKey: ["telegram-analytics"],
    queryFn: async () => {
      try {
        // Reuse the same backend analytics endpoint as WhatsApp
        return await fetchWhatsAppAnalytics();
      } catch (error) {
        console.error("Error fetching Telegram analytics:", error);
        return null;
      }
    },
    enabled: true // Always fetch Telegram analytics
  });

  // Combine all data
  const isLoading = baseQuery.isLoading || whatsappQuery.isLoading || telegramQuery.isLoading;
  const data: AnalyticsData | undefined = baseQuery.data ? {
    ...baseQuery.data,
    whatsappStats: whatsappQuery.data || {},
    telegramStats: telegramQuery.data || {}
  } : undefined;

  return {
    data,
    isLoading,
    error: baseQuery.error || whatsappQuery.error || telegramQuery.error
  };
};
