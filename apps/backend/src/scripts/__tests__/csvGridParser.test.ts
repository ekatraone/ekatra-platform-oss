import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCsvGrid, parseCsvRows } from '../csvGridParser.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../__fixtures__/designThinkingSample.csv');
const fixtureCsv = readFileSync(fixturePath, 'utf-8');

test('parseCsvRows handles quoted fields with embedded commas and newlines', () => {
  const rows = parseCsvRows('a,"b, with comma","c\nwith newline"\n1,2,3\n');
  assert.deepEqual(rows[0], ['a', 'b, with comma', 'c\nwith newline']);
  assert.deepEqual(rows[1], ['1', '2', '3']);
});

test('parseCsvGrid extracts two days with correct module counts', () => {
  const days = parseCsvGrid(fixtureCsv);
  assert.equal(days.length, 2);
  assert.equal(days[0].day, 1);
  assert.equal(days[0].dayTopic, 'What is Design Thinking?');
  assert.equal(days[0].modules.length, 3);
  assert.equal(days[1].day, 2);
  assert.equal(days[1].modules.length, 2); // Module 3 is entirely empty on day 2 — dropped
});

test('parseCsvGrid preserves # dividers inside a module Text cell verbatim', () => {
  const days = parseCsvGrid(fixtureCsv);
  const mod1 = days[0].modules.find((m) => m.moduleNumber === 1)!;
  assert.match(mod1.text!, /Intro screen one\.\n#\nIntro screen two\./);
});

test('parseCsvGrid drops modules where every field is empty', () => {
  const days = parseCsvGrid(fixtureCsv);
  const day2ModuleNumbers = days[1].modules.map((m) => m.moduleNumber);
  assert.deepEqual(day2ModuleNumbers, [1, 2]);
});

test('parseCsvGrid keeps a module with only an iButtons/next field (no Text) — multi-choice module 1 on day 2', () => {
  const days = parseCsvGrid(fixtureCsv);
  const mod1Day2 = days[1].modules.find((m) => m.moduleNumber === 1)!;
  assert.equal(mod1Day2.iButtons, 'Yes|No');
});
