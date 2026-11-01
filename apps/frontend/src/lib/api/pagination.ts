/** Pagination block returned by the list endpoints (/api/courses, /api/learners). */
export interface Pagination { total: number; page: number; limit: number; pages: number; }
export interface PageResult<T> { data?: T[]; pagination?: Pagination; }

/** Largest page the list endpoints serve; the server clamps `limit` to this. */
export const MAX_PAGE_SIZE = 100;

/**
 * Walk every page of a paginated list endpoint. Used for pickers that must offer
 * every record (e.g. all published courses), not just the server's default first page.
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number, limit: number) => Promise<PageResult<T>>,
  limit = MAX_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const res = await fetchPage(page, limit);
    const data = res?.data ?? [];
    rows.push(...data);
    const pages = res?.pagination?.pages;
    // Stop on the last page; without a pagination block, a short page is the last one.
    if (pages !== undefined ? page >= pages : data.length < limit) return rows;
    if (data.length === 0) return rows;
  }
}
