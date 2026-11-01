/**
 * Dry-run driver for M12a: parses + compiles a real CSV file and prints a
 * publish-readiness report (validator errors, node/transition counts, a
 * sample of node types) without writing anything to the DB. Not part of the
 * M12b importer — throwaway verification tool for milestone-12 development.
 *
 * Usage: npx tsx src/scripts/dryRunCompile.ts <path-to-csv>
 */
import { readFileSync } from 'node:fs';
import { parseCsvGrid } from './csvGridParser.js';
import { compileCourseFsm, validateFsmGraph, validateDaySequence } from './fsmCompiler.js';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: dryRunCompile.ts <path-to-csv>');
  process.exit(1);
}

const csv = readFileSync(filePath, 'utf-8');
const days = parseCsvGrid(csv);

console.log(`Parsed ${days.length} day(s):`);
for (const d of days) {
  console.log(`  Day ${d.day} — "${d.dayTopic ?? ''}" — ${d.modules.length} non-empty module(s): [${d.modules.map((m) => m.moduleNumber).join(', ')}]`);
}

const daySeqErrors = validateDaySequence(days);
if (daySeqErrors.length > 0) {
  console.log(`\nDAY SEQUENCE CHECK FAILED — ${daySeqErrors.length} error(s):`);
  for (const e of daySeqErrors) console.log(`  [${e.code}] ${e.message}`);
}

const graph = compileCourseFsm(days);
const errors = [...daySeqErrors, ...validateFsmGraph(graph)];

const typeCounts: Record<string, number> = {};
for (const s of graph.states) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;

console.log(`\nCompiled graph: ${graph.states.length} states, ${graph.transitions.length} transitions`);
console.log('Node type breakdown:', typeCounts);
console.log('Start node:', graph.startNodeId);

if (errors.length > 0) {
  console.log(`\nVALIDATION FAILED — ${errors.length} error(s), NOT publishable:`);
  for (const e of errors) console.log(`  [${e.code}] ${e.message}`);
  process.exit(1);
} else {
  console.log('\nValidation PASSED — structurally publishable.');
}
