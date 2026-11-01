import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllPages } from '../pagination';

test('fetchAllPages walks every page reported by the pagination block', async () => {
  const all = Array.from({ length: 25 }, (_, i) => i);
  const requested: number[] = [];
  const rows = await fetchAllPages<number>(async (page, limit) => {
    requested.push(page);
    return { data: all.slice((page - 1) * limit, page * limit), pagination: { total: 25, page, limit, pages: Math.ceil(25 / limit) } };
  }, 10);
  assert.deepEqual(requested, [1, 2, 3]);
  assert.deepEqual(rows, all);
});

test('fetchAllPages stops on an empty result and on a short page without pagination', async () => {
  assert.deepEqual(await fetchAllPages<number>(async (_p, _l) => ({ data: [], pagination: { total: 0, page: 1, limit: 10, pages: 0 } }), 10), []);
  let calls = 0;
  const rows = await fetchAllPages<number>(async () => { calls++; return { data: [1, 2] }; }, 10);
  assert.deepEqual(rows, [1, 2]);
  assert.equal(calls, 1);
});
