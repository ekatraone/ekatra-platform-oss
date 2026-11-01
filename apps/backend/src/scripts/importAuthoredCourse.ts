/**
 * Authored Course Importer (Milestone 12b, stage 3 of the pipeline)
 *
 * Thin CLI over the pure M12a pipeline (csvGridParser → fsmCompiler):
 *   1. Parse + hard-stop validate (day sequence, then structural graph checks)
 *   2. Re-host media: download each node's fileUrl into public/media/authored/<slug>/
 *      and rewrite the node to the locally served URL. Expired/dead source URLs
 *      (Airtable attachment links rot — observed HTTP 410 on this course) degrade
 *      gracefully: the node keeps its fileName as a re-attachment handle and gets
 *      mediaMissing: true; text/flow import fully either way.
 *   3. Write courses row (source='authored') + fsm_definitions row, link them.
 *
 * Usage:
 *   npx tsx src/scripts/importAuthoredCourse.ts <path-to-csv> --title "Course Title" [--publish] [--dry-run] [--media-dir <dir>]
 *
 * --media-dir: local folder of media files matched to nodes by filename (the CSV's
 * original attachment names, preserved on each node). Local files win over source
 * URLs — there is no external media dependency when a media dir is provided.
 *
 * Idempotency: re-running with the same title updates the existing authored
 * course's FSM definition in place (version bump via fsmDefinitions.update)
 * instead of creating a duplicate.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsvGrid } from './csvGridParser.js';
import { compileCourseFsm, validateFsmGraph, validateDaySequence, FsmGraph, FsmNode } from './fsmCompiler.js';

const getDb = () => import('@ekatra/database').then((m) => m.db);

interface CliArgs {
  csvPath: string;
  title: string;
  publish: boolean;
  dryRun: boolean;
  mediaDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let title = '';
  let publish = false;
  let dryRun = false;
  let mediaDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') title = argv[++i] ?? '';
    else if (a === '--publish') publish = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--media-dir') mediaDir = argv[++i];
    else positional.push(a);
  }
  if (positional.length !== 1 || !title) {
    console.error('Usage: importAuthoredCourse.ts <path-to-csv> --title "Course Title" [--publish] [--dry-run] [--media-dir <dir>]');
    process.exit(1);
  }
  return { csvPath: positional[0], title, publish, dryRun, mediaDir };
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Case-insensitive filename → absolute path index of a local media directory. */
function indexMediaDir(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) map.set(entry.name.toLowerCase(), path.join(dir, entry.name));
  }
  return map;
}

/**
 * Re-hosts every node's media into public/media/authored/<slug>/, rewriting nodes in place.
 * A local media dir (matched by the node's preserved fileName) takes priority; the node's
 * source URL is the fallback. Nodes whose media can't be found either way keep fileName as
 * a re-attachment handle and get mediaMissing: true.
 */
async function rehostMedia(graph: FsmGraph, slug: string, backendRoot: string, mediaDir?: string) {
  const mediaDirAbs = path.join(backendRoot, 'public', 'media', 'authored', slug);
  const localIndex = mediaDir ? indexMediaDir(mediaDir) : new Map<string, string>();
  const report = {
    fromLocal: 0,
    downloaded: 0,
    missing: [] as { nodeId: string; fileName?: string; sourceUrl?: string }[],
  };
  const nodesWithMedia = graph.states.filter((n) => n.fileUrl || n.fileName);
  if (nodesWithMedia.length > 0) mkdirSync(mediaDirAbs, { recursive: true });

  for (const node of nodesWithMedia) {
    const sourceUrl = node.fileUrl;
    const safeName = `${node.id}${path.extname(node.fileName || (sourceUrl ? new URL(sourceUrl).pathname : '')) || ''}`;
    const destAbs = path.join(mediaDirAbs, safeName);
    const servedUrl = `/media/authored/${slug}/${safeName}`;

    const localPath = node.fileName ? localIndex.get(node.fileName.toLowerCase()) : undefined;
    if (localPath) {
      copyFileSync(localPath, destAbs);
      node.fileUrl = servedUrl;
      delete (node as any).mediaMissing;
      report.fromLocal++;
      continue;
    }

    if (sourceUrl && /^https?:\/\//.test(sourceUrl)) {
      try {
        const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(destAbs, Buffer.from(await res.arrayBuffer()));
        node.fileUrl = servedUrl;
        report.downloaded++;
        continue;
      } catch {
        // fall through to missing
      }
    }

    report.missing.push({ nodeId: node.id, fileName: node.fileName, sourceUrl });
    // Keep the filename as the re-attachment handle; drop the dead URL so nothing
    // downstream ever tries to send it to a learner.
    delete (node as FsmNode).fileUrl;
    (node as any).mediaMissing = true;
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

  // ── Stage 1+2: parse and compile (pure) ──
  const csv = readFileSync(args.csvPath, 'utf-8');
  const days = parseCsvGrid(csv);
  const errors = [...validateDaySequence(days)];
  const graph = compileCourseFsm(days);
  errors.push(...validateFsmGraph(graph));

  if (errors.length > 0) {
    console.error(`VALIDATION FAILED — ${errors.length} error(s), refusing to import:`);
    for (const e of errors) console.error(`  [${e.code}] ${e.message}`);
    process.exit(1);
  }

  const typeCounts: Record<string, number> = {};
  for (const s of graph.states) typeCounts[s.type] = (typeCounts[s.type] || 0) + 1;
  console.log(`Compiled "${args.title}": ${days.length} days, ${graph.states.length} states, ${graph.transitions.length} transitions`);
  console.log('Node types:', typeCounts);

  // ── Media re-hosting ──
  const slug = slugify(args.title);
  const mediaReport = await rehostMedia(graph, slug, backendRoot, args.mediaDir);
  console.log(`Media: ${mediaReport.fromLocal} from local dir, ${mediaReport.downloaded} downloaded, ${mediaReport.missing.length} missing`);
  for (const m of mediaReport.missing) {
    console.log(`  MISSING ${m.nodeId}: ${m.fileName ?? '(unnamed)'} — not in media dir${m.sourceUrl ? ', source URL dead' : ''}`);
  }

  if (args.dryRun) {
    const outPath = path.join(backendRoot, `fsm-${slug}.json`);
    writeFileSync(outPath, JSON.stringify({ ...graph, startNodeId: graph.startNodeId }, null, 2));
    console.log(`\nDry run — no DB writes. Compiled graph written to ${outPath}`);
    return;
  }

  // ── Stage 3: DB writes ──
  const { initializeDatabase } = await import('@ekatra/database');
  initializeDatabase();
  const db = await getDb();
  const org = await db.organizations.getDefault();
  if (!org) {
    console.error('No organization found in DB — cannot import.');
    process.exit(1);
  }

  const fsmJson = { states: graph.states, transitions: graph.transitions, startNodeId: graph.startNodeId };
  const status = args.publish ? 'published' : 'draft';

  // Idempotent by title: update existing authored course's definition instead of duplicating.
  const existingCourses = await db.courses.findAll({ organizationId: org.id, search: args.title, limit: 50 });
  const existing = existingCourses.data.find(
    (c: any) => c.title === args.title && c.source === 'authored'
  );

  let courseId: string;
  let fsmId: string;
  if (existing && existing.fsm_definition_id) {
    await db.fsmDefinitions.update(existing.fsm_definition_id, { fsmJson });
    await db.courses.update(existing.id, { status });
    courseId = existing.id;
    fsmId = existing.fsm_definition_id;
    console.log(`Updated existing course ${courseId} (FSM ${fsmId}, version bumped)`);
  } else {
    const fsmDef = await db.fsmDefinitions.create({ organizationId: org.id, name: args.title, fsmJson });
    const course = await db.courses.create({
      organizationId: org.id,
      title: args.title,
      description: days[0]?.dayTopic?.split('\n')[0] ?? undefined,
      status,
      source: 'authored',
      settings: { totalDays: days.length, importedFrom: path.basename(args.csvPath), importedAt: new Date().toISOString() },
    });
    await db.courses.update(course.id, { fsm_definition_id: fsmDef.id });
    courseId = course.id;
    fsmId = fsmDef.id;
    console.log(`Created course ${courseId} (FSM ${fsmId})`);
  }

  console.log(`\nImport complete: "${args.title}" — status=${status}, source=authored`);
  console.log(`Course:  ${courseId}`);
  console.log(`FSM:     ${fsmId}`);
  if (mediaReport.missing.length > 0) {
    console.log(`\n⚠️  ${mediaReport.missing.length} media file(s) missing.`);
    console.log('   Drop the files (matching the names above) into a folder and re-run with --media-dir <folder> to attach them.');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('Import failed:', err?.message ?? err);
  process.exit(1);
});
