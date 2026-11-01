import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/apiClient';
import type { MessageRecord } from '@/services/contracts';

/**
 * Message history and sending for one learner, on either channel. The backend routes
 * by the learner's phone ("tg:<chat_id>" goes to Telegram), so everything is keyed
 * by learner id — the id /api/learners/:id/send-message expects.
 */
export const useLearnerChat = (learnerId?: string, limit = 50) => {
  const { data, isLoading, refetch, error } = useQuery({
    queryKey: ['learner-messages', learnerId, limit],
    queryFn: async () => {
      const res = await api.getLearnerMessages(learnerId!, limit) as { data?: MessageRecord[] };
      // The API returns newest first; a chat reads oldest first.
      return [...(res?.data ?? [])].reverse();
    },
    enabled: !!learnerId,
    refetchInterval: 10000,
  });

  // Throws with the server's error (e.g. provider rejected the send) so callers can show it.
  const sendMessage = async (content: string) => {
    if (!learnerId) throw new Error('No learner selected');
    const result = await api.sendMessage(learnerId, { type: 'text', content });
    await refetch();
    return result;
  };

  return {
    messages: data ?? [],
    isLoading,
    error: error as Error | null,
    sendMessage,
    refetch,
  };
};
