import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient } from '@/services/apiClient';
import type { Pagination } from '@/lib/api/pagination';

/**
 * One page of GET /api/learners with server-side search, so records beyond the
 * first page are reachable and search covers every learner, not just loaded rows.
 */
export function usePagedLearners<T = any>(opts: { pageSize?: number; debounceMs?: number } = {}) {
  const { pageSize = 50, debounceMs = 300 } = opts;
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1); // a new search starts from the first page
    }, debounceMs);
    return () => clearTimeout(t);
  }, [search, debounceMs]);

  const query = useQuery({
    queryKey: ['learners', { search: debouncedSearch, page, limit: pageSize }],
    queryFn: async () => {
      const res = await apiClient.getLearners({
        page, limit: pageSize, ...(debouncedSearch ? { search: debouncedSearch } : {}),
      }) as { data?: T[]; pagination?: Pagination };
      return { rows: res?.data ?? [], pagination: res?.pagination };
    },
    placeholderData: keepPreviousData,
  });

  return {
    learners: query.data?.rows ?? [],
    pagination: query.data?.pagination,
    loading: query.isLoading,
    fetching: query.isFetching,
    error: query.error as Error | null,
    refetch: query.refetch,
    search, setSearch, page, setPage,
  };
}
