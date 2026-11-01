/**
 * FSM Compiler (Milestone 12a)
 *
 * Compiles parsed CSV grid records (csvGridParser.ts output) into the
 * {states, transitions} shape stored in fsm_definitions.fsm_json (migration 007)
 * and executed live by conversationFSM.processDynamic() (Milestone 10).
 *
 * Pure function — no I/O, no DB. Runs its own structural validator before
 * returning; a course with validation errors must not be published (AC4 —
 * this is a hard stop, not a warning).
 *
 * New node types this milestone adds to the dynamic FSM engine (screen /
 * choice / quiz / day_end) render straight from this node data via
 * authoredContentRenderer.ts — they do NOT go through the lessons-table-backed
 * sendNextLesson()/runDayEndReview() path that the pre-existing lesson/question
 * node types use, because there is no backing `lessons` row for authored content.
 */

import { DayRecord, ModuleRecord } from './csvGridParser.js';

export type FsmNodeType = 'screen' | 'choice' | 'quiz' | 'day_end' | 'end';

export interface FsmOption {
  id: string;
  label: string;
  correct?: boolean;
}

export interface FsmNode {
  id: string;
  type: FsmNodeType;
  day: number;
  moduleNumber?: number;
  text?: string;
  fileUrl?: string;
  fileName?: string;
  link?: string;
  question?: string;
  options?: FsmOption[];
  feedback?: string;
}

export interface FsmTransition {
  from: string;
  to: string;
  trigger: string; // normalized button label the learner sends, or AUTO_TRIGGER for non-interactive continue
  label?: string;  // original display text for the button (absent on auto-advance edges)
}

export interface FsmGraph {
  states: FsmNode[];
  transitions: FsmTransition[];
  startNodeId: string;
}

export const AUTO_TRIGGER = '__auto__';

export interface ValidationError {
  code: 'DANGLING_TRANSITION' | 'UNREACHABLE_NODE' | 'EMPTY_GRAPH' | 'DUPLICATE_NODE_ID' | 'NON_MONOTONIC_DAY';
  message: string;
}

/**
 * Source-data integrity check: real-world exports sometimes concatenate two
 * unrelated tables into one CSV (e.g. a second, differently-scoped block that
 * happens to restart its own Day numbering at 1). compileCourseFsm has no way
 * to detect this on its own — chaining "Day 1" (block A) into "Day 1" (block B)
 * produces a structurally valid but semantically wrong graph. Call this BEFORE
 * compileCourseFsm and treat any error as a hard stop, same as validateFsmGraph.
 */
export function validateDaySequence(days: { day: number }[]): ValidationError[] {
  const errors: ValidationError[] = [];
  let prev = -Infinity;
  const seen = new Set<number>();
  for (const d of days) {
    if (seen.has(d.day)) {
      errors.push({
        code: 'NON_MONOTONIC_DAY',
        message: `Day ${d.day} appears more than once — the source CSV likely concatenates two unrelated tables. Split them before compiling.`,
      });
    }
    if (d.day < prev) {
      errors.push({ code: 'NON_MONOTONIC_DAY', message: `Day ${d.day} appears out of order after day ${prev}` });
    }
    seen.add(d.day);
    prev = d.day;
  }
  return errors;
}

/** Splits a module's Text/iBody cell into a sequence of screen segments on a `#`-only line. */
function splitScreenSegments(raw: string): string[] {
  return raw
    .split(/\r?\n\s*#\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** iButtons is one button label per real-world data, but supports `|`-separated multi-button for choice nodes. */
function parseButtonLabels(raw: string): string[] {
  return raw
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function normalizeTrigger(label: string): string {
  return label.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '').trim();
}

interface FileRef { url: string; name?: string }

function parseFileCell(raw: string): FileRef[] {
  // Cell format: "name1.ext (https://...),name2.ext (https://...)" — comma-separated attachments.
  // The filename matters independently of the URL: Airtable attachment URLs expire (observed HTTP 410
  // on this course's export), so the name is the only stable handle for re-attaching media later.
  // Filenames may themselves contain parentheses ("2022-12-02 (1).png"), so anchor each match on
  // its "(https://...)" group; names can't contain commas in this export format.
  const refs: FileRef[] = [];
  for (const m of raw.matchAll(/([^,]*?)\s*\((https?:\/\/[^)\s]+)\)/g)) {
    refs.push({ url: m[2], name: m[1].trim() || undefined });
  }
  if (refs.length === 0) {
    const trimmed = raw.trim();
    if (trimmed) refs.push({ url: trimmed });
  }
  return refs;
}

/** "Image 0" / "*Image 1*" segments are the CSV's placeholder convention pointing at the module's Nth attachment. */
function imagePlaceholderIndex(segment: string): number | undefined {
  const m = segment.trim().match(/^\**\s*Image\s+(\d+)\s*\**$/i);
  return m ? parseInt(m[1], 10) : undefined;
}

function extractQuizOptions(m: ModuleRecord): FsmOption[] | undefined {
  const optionsRaw = m.list;
  const correct = m.ans?.trim();
  if (!optionsRaw) {
    // No option list present in this cell (plain Question/Ans pair with no List column populated).
    // Known limitation: real per-option text isn't recoverable from this shape without the source
    // file's actual column alignment — emit the correct answer as the sole option rather than guess.
    if (!correct) return undefined;
    return [{ id: 'opt_0', label: correct, correct: true }];
  }
  return optionsRaw
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((label, i) => ({ id: `opt_${i}`, label, correct: correct !== undefined && label === correct }));
}

let nodeCounter = 0;
function nextId(prefix: string): string {
  nodeCounter += 1;
  return `${prefix}_${nodeCounter}`;
}

/** Compiles a full course. Resets internal id counter for deterministic output across calls. */
export function compileCourseFsm(days: DayRecord[]): FsmGraph {
  nodeCounter = 0;
  const states: FsmNode[] = [];
  const transitions: FsmTransition[] = [];

  const endNode: FsmNode = { id: nextId('end'), type: 'end', day: days.length > 0 ? days[days.length - 1].day : 0 };

  let startNodeId: string | undefined;
  let prevTailId: string | undefined; // id of the last node created so far, awaiting an outgoing transition
  let prevTailTrigger: string = AUTO_TRIGGER;
  let prevTailLabel: string | undefined; // display text for the button that fires prevTailTrigger

  const link = (toId: string) => {
    if (prevTailId) {
      transitions.push({
        from: prevTailId,
        to: toId,
        trigger: prevTailTrigger,
        ...(prevTailLabel ? { label: prevTailLabel } : {}),
      });
    }
    if (!startNodeId) startNodeId = toId;
  };

  for (const day of days) {
    for (const mod of day.modules) {
      let lastNodeIdInModule: string | undefined;

      const textSegments = mod.text ? splitScreenSegments(mod.text) : [];
      const iBodySegments = mod.iBody ? splitScreenSegments(mod.iBody) : [];
      let allSegments = [...textSegments, ...iBodySegments];
      // A module carrying only an attachment (File with no Text/iBody) still needs a node,
      // or the media would be silently dropped from the flow.
      if (allSegments.length === 0 && mod.file) allSegments = [''];
      const fileRefs = mod.file ? parseFileCell(mod.file) : [];
      const link_ = mod.link?.trim() || undefined;
      // "Image N" placeholder segments consume the module's attachments by index; if none do,
      // the first attachment falls back to riding on the module's last segment (legacy shape).
      const placeholdersPresent = allSegments.some((s) => imagePlaceholderIndex(s) !== undefined);

      allSegments.forEach((segment, i) => {
        const isLast = i === allSegments.length - 1;
        const imgIdx = imagePlaceholderIndex(segment);
        const ref: FileRef | undefined =
          imgIdx !== undefined ? fileRefs[imgIdx]
          : !placeholdersPresent && isLast ? fileRefs[0]
          : undefined;
        const node: FsmNode = {
          id: nextId(`screen_d${day.day}_m${mod.moduleNumber}`),
          type: 'screen',
          day: day.day,
          moduleNumber: mod.moduleNumber,
          // A resolved placeholder becomes a pure media screen; an unresolvable one keeps its
          // text so the reference isn't silently lost.
          text: imgIdx !== undefined && ref ? '' : segment,
          ...(ref ? { fileUrl: ref.url, ...(ref.name ? { fileName: ref.name } : {}) } : {}),
          ...(isLast && link_ ? { link: link_ } : {}),
        };
        states.push(node);
        link(node.id);
        prevTailId = node.id;
        prevTailTrigger = AUTO_TRIGGER;
        prevTailLabel = undefined;
        lastNodeIdInModule = node.id;
      });

      // iButtons turns the tail screen (or, if there were no screens at all, a synthetic
      // choice node) into a branch point.
      if (mod.iButtons) {
        const labels = parseButtonLabels(mod.iButtons);
        if (lastNodeIdInModule) {
          // retarget: last screen already linked in as a screen node; convert its outgoing
          // edge into N button-triggered edges instead of a single auto edge. Since we only
          // emit the outgoing transition when the NEXT node is linked, we just need the tail's
          // trigger set to be resolved per-label at the point the next node attaches. With
          // multiple labels we need a distinct edge per label — but they'd all point at the
          // same next node here (chaining continues linearly); real per-button branching to
          // different targets happens across modules, not within one, so multi-label iButtons
          // fan-in to the same follow-on node with distinct accepted triggers.
          prevTailId = lastNodeIdInModule;
          prevTailTrigger = normalizeTrigger(labels[0]);
          prevTailLabel = labels[0];
          // additional labels get their own edge to the same eventual target, added lazily below
          (states[states.length - 1] as any)._extraTriggers = labels.slice(1).map((l) => ({ trigger: normalizeTrigger(l), label: l }));
        }
      }

      const quizOptions = extractQuizOptions(mod);
      const questionText = mod.lTitle || mod.question;
      if (quizOptions && questionText) {
        const quizNode: FsmNode = {
          id: nextId(`quiz_d${day.day}_m${mod.moduleNumber}`),
          type: 'quiz',
          day: day.day,
          moduleNumber: mod.moduleNumber,
          question: questionText,
          options: quizOptions,
        };
        states.push(quizNode);
        link(quizNode.id);
        prevTailId = quizNode.id;
        prevTailTrigger = AUTO_TRIGGER;
        prevTailLabel = undefined;
        lastNodeIdInModule = quizNode.id;
      }

      if (mod.next) {
        prevTailTrigger = normalizeTrigger(mod.next);
        prevTailLabel = mod.next.trim();
      }
    }

    const dayEndNode: FsmNode = { id: nextId(`day_end_d${day.day}`), type: 'day_end', day: day.day };
    states.push(dayEndNode);
    link(dayEndNode.id);
    prevTailId = dayEndNode.id;
    prevTailTrigger = AUTO_TRIGGER;
    prevTailLabel = undefined;
  }

  states.push(endNode);
  link(endNode.id);

  // Resolve the deferred multi-label iButtons edges: any screen node tagged with
  // _extraTriggers gets additional transitions to whatever node its primary trigger points to.
  for (const s of states) {
    const extra: { trigger: string; label: string }[] | undefined = (s as any)._extraTriggers;
    if (!extra || extra.length === 0) continue;
    delete (s as any)._extraTriggers;
    const primaryEdge = transitions.find((t) => t.from === s.id);
    if (!primaryEdge) continue;
    for (const { trigger, label } of extra) {
      transitions.push({ from: s.id, to: primaryEdge.to, trigger, label });
    }
  }

  if (!startNodeId) startNodeId = endNode.id;

  return { states, transitions, startNodeId };
}

/** Hard-stop structural validator (AC4). A course failing this must not be marked publishable. */
export function validateFsmGraph(graph: FsmGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  if (graph.states.length === 0) {
    return [{ code: 'EMPTY_GRAPH', message: 'FSM graph has no states' }];
  }

  const seenIds = new Set<string>();
  for (const s of graph.states) {
    if (seenIds.has(s.id)) {
      errors.push({ code: 'DUPLICATE_NODE_ID', message: `Duplicate node id: ${s.id}` });
    }
    seenIds.add(s.id);
  }

  for (const t of graph.transitions) {
    if (!seenIds.has(t.from)) {
      errors.push({ code: 'DANGLING_TRANSITION', message: `Transition references missing "from" node: ${t.from}` });
    }
    if (!seenIds.has(t.to)) {
      errors.push({ code: 'DANGLING_TRANSITION', message: `Transition references missing "to" node: ${t.to}` });
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const t of graph.transitions) {
    if (!adjacency.has(t.from)) adjacency.set(t.from, []);
    adjacency.get(t.from)!.push(t.to);
  }

  const reachable = new Set<string>();
  const queue = [graph.startNodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of adjacency.get(cur) || []) {
      if (!reachable.has(next)) queue.push(next);
    }
  }

  for (const s of graph.states) {
    if (!reachable.has(s.id)) {
      errors.push({ code: 'UNREACHABLE_NODE', message: `Node unreachable from start: ${s.id}` });
    }
  }

  return errors;
}
