
import { useState } from 'react';
import { apiClient } from '@/services/apiClient';

export const useAITutor = () => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const askAITutor = async (query: string, tutorId?: string, context: any[] = []) => {
    setLoading(true);
    setError(null);

    try {
      // Call backend AI tutor endpoint
      const response = await apiClient.post('/ai/tutor', {
        query,
        context,
        tutorId
      });

      const data = response.data;

      setLoading(false);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
      return null;
    }
  };

  return {
    askAITutor,
    loading,
    error
  };
};

