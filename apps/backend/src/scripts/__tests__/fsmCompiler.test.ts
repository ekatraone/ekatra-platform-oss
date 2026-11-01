import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseCsvGrid } from '../csvGridParser.js';
import { compileCourseFsm, validateFsmGraph, validateDaySequence, AUTO_TRIGGER, FsmGraph } from '../fsmCompiler.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../__fixtures__/designThinkingSample.csv');
const fixtureCsv = readFileSync(fixturePath, 'utf-8');

function compileFixture(): FsmGraph {
  const days = parseCsvGrid(fixtureCsv);
  return compileCourseFsm(days);
}

test('compileCourseFsm splits a #-delimited Text cell into two chained screen nodes', () => {
  const graph = compileFixture();
  const screens = graph.states.filter((s) => s.type === 'screen' && s.day === 1 && s.moduleNumber === 1);
  assert.equal(screens.length, 2);
  assert.equal(screens[0].text, 'Intro screen one.');
  assert.equal(screens[1].text, 'Intro screen two.');
  const edge = graph.transitions.find((t) => t.from === screens[0].id);
  assert.equal(edge?.to, screens[1].id);
  assert.equal(edge?.trigger, AUTO_TRIGGER);
});

test('compileCourseFsm attaches File/Link only to the last screen segment of a module', () => {
  const graph = compileFixture();
  const screens = graph.states.filter((s) => s.type === 'screen' && s.day === 1 && s.moduleNumber === 1);
  assert.equal(screens[0].fileUrl, undefined);
  assert.equal(screens[1].fileUrl, 'https://example.com/image.png');
});

test('compileCourseFsm wires a module\'s `next` button label as the outgoing trigger to the following module', () => {
  const graph = compileFixture();
  const module2Screen = graph.states.find((s) => s.type === 'screen' && s.day === 1 && s.moduleNumber === 2)!;
  const module3Quiz = graph.states.find((s) => s.type === 'quiz' && s.day === 1 && s.moduleNumber === 3)!;
  const edge = graph.transitions.find((t) => t.from === module2Screen.id && t.to === module3Quiz.id);
  assert.ok(edge, 'expected an edge from module 2 screen to module 3 quiz');
  assert.equal(edge!.trigger, 'continue'); // normalized from "Continue"
});

test('compileCourseFsm builds a quiz node from LTitle/List/Ans with the correct option flagged', () => {
  const graph = compileFixture();
  const quiz = graph.states.find((s) => s.type === 'quiz' && s.day === 1 && s.moduleNumber === 3)!;
  assert.equal(quiz.question, 'Which question comes first?');
  assert.equal(quiz.options?.length, 3);
  const correct = quiz.options!.filter((o) => o.correct);
  assert.equal(correct.length, 1);
  assert.equal(correct[0].label, 'What is?');
});

test('compileCourseFsm folds a multi-label iButtons module (day 2, module 1) into a branch with one edge per button', () => {
  const graph = compileFixture();
  const branchNode = graph.states.find((s) => s.type === 'screen' && s.day === 2 && s.moduleNumber === 1)!;
  const outEdges = graph.transitions.filter((t) => t.from === branchNode.id);
  assert.equal(outEdges.length, 2);
  const triggers = outEdges.map((e) => e.trigger).sort();
  assert.deepEqual(triggers, ['no', 'yes']);
  // both buttons lead to the same next module (module 2) in this fixture
  assert.equal(new Set(outEdges.map((e) => e.to)).size, 1);
});

test('compileCourseFsm inserts a day_end node after the last module of each day, chaining into the next day', () => {
  const graph = compileFixture();
  const dayEnd1 = graph.states.find((s) => s.type === 'day_end' && s.day === 1)!;
  assert.ok(dayEnd1);
  const module1Day2 = graph.states.find((s) => s.type === 'screen' && s.day === 2 && s.moduleNumber === 1)!;
  const edge = graph.transitions.find((t) => t.from === dayEnd1.id);
  assert.equal(edge?.to, module1Day2.id);
});

test('compileCourseFsm terminates the last day into a single end node', () => {
  const graph = compileFixture();
  const endNodes = graph.states.filter((s) => s.type === 'end');
  assert.equal(endNodes.length, 1);
  const dayEnd2 = graph.states.find((s) => s.type === 'day_end' && s.day === 2)!;
  const edge = graph.transitions.find((t) => t.from === dayEnd2.id);
  assert.equal(edge?.to, endNodes[0].id);
});

test('validateFsmGraph passes on the compiled fixture (every node reachable, no dangling edges)', () => {
  const graph = compileFixture();
  const errors = validateFsmGraph(graph);
  assert.deepEqual(errors, []);
});

test('validateFsmGraph is a hard stop: catches a dangling transition', () => {
  const graph = compileFixture();
  graph.transitions.push({ from: graph.states[0].id, to: 'node_does_not_exist', trigger: AUTO_TRIGGER });
  const errors = validateFsmGraph(graph);
  assert.ok(errors.some((e) => e.code === 'DANGLING_TRANSITION'));
});

test('validateFsmGraph is a hard stop: catches an unreachable node', () => {
  const graph = compileFixture();
  graph.states.push({ id: 'orphan', type: 'screen', day: 99, text: 'unreachable' });
  const errors = validateFsmGraph(graph);
  assert.ok(errors.some((e) => e.code === 'UNREACHABLE_NODE' && e.message.includes('orphan')));
});

test('compileCourseFsm maps "Image N" placeholder segments to the module\'s Nth attachment', () => {
  const graph = compileCourseFsm([{
    day: 1,
    modules: [{
      day: 1,
      moduleNumber: 1,
      text: 'Intro text.\n#\nImage 0\n#\nMore text.\n#\nImage 1',
      file: 'first (1).png (https://example.com/a.png),second.jpg (https://example.com/b.jpg)',
    }],
  }]);
  const screens = graph.states.filter((s) => s.type === 'screen');
  assert.equal(screens.length, 4);
  assert.equal(screens[0].text, 'Intro text.');
  assert.equal(screens[0].fileUrl, undefined);
  // "Image 0" → first attachment, as a pure media screen
  assert.equal(screens[1].text, '');
  assert.equal(screens[1].fileUrl, 'https://example.com/a.png');
  assert.equal(screens[1].fileName, 'first (1).png');
  assert.equal(screens[2].text, 'More text.');
  assert.equal(screens[2].fileUrl, undefined);
  // "Image 1" → second attachment
  assert.equal(screens[3].fileUrl, 'https://example.com/b.jpg');
  assert.equal(screens[3].fileName, 'second.jpg');
});

test('validateDaySequence passes on a properly ordered day list', () => {
  const errors = validateDaySequence([{ day: 1 }, { day: 2 }, { day: 3 }]);
  assert.deepEqual(errors, []);
});

test('validateDaySequence is a hard stop: catches a repeated day number (concatenated-tables case)', () => {
  // Regression case: the real Design Thinking export concatenates two unrelated
  // tables, the second of which restarts its own numbering at Day 1 — this must
  // never be silently chained onto the end of the real Day 1.
  const errors = validateDaySequence([{ day: 1 }, { day: 2 }, { day: 3 }, { day: 1 }, { day: 2 }]);
  assert.ok(errors.length > 0);
  assert.ok(errors.some((e) => e.code === 'NON_MONOTONIC_DAY' && e.message.includes('Day 1 appears more than once')));
  assert.ok(errors.some((e) => e.code === 'NON_MONOTONIC_DAY' && e.message.includes('Day 2 appears more than once')));
});

test('validateDaySequence catches an out-of-order day', () => {
  const errors = validateDaySequence([{ day: 1 }, { day: 3 }, { day: 2 }]);
  assert.ok(errors.some((e) => e.code === 'NON_MONOTONIC_DAY' && e.message.includes('day 3')));
});

test('validateFsmGraph is a hard stop: catches a duplicate node id', () => {
  const graph = compileFixture();
  const dup = { ...graph.states[0] };
  graph.states.push(dup);
  const errors = validateFsmGraph(graph);
  assert.ok(errors.some((e) => e.code === 'DUPLICATE_NODE_ID'));
});
