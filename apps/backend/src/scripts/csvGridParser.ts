/**
 * CSV Grid Parser (Milestone 12a)
 *
 * Parses the "wide grid" authored-course CSV format: one row per Day, with
 * up to N "Module" column-groups per row (Module 1 Text, Module 1 Question,
 * Module 1 iBody, Module 1 iButtons, Module 1 LTitle, Module 1 List,
 * Module 1 Ans, Module 1 File, Module 1 Link, Module 1 next, ...).
 *
 * Pure functions only — no I/O, no DB. fsmCompiler.ts consumes this output.
 */

export interface ModuleRecord {
  day: number;
  moduleNumber: number;
  text?: string;
  question?: string;
  iBody?: string;
  iButtons?: string;
  lTitle?: string;
  list?: string;
  ans?: string;
  file?: string;
  link?: string;
  next?: string;
}

export interface DayRecord {
  day: number;
  dayTopic?: string;
  modules: ModuleRecord[];
}

const MODULE_FIELD_MAP: Record<string, keyof ModuleRecord> = {
  Text: 'text',
  Question: 'question',
  iBody: 'iBody',
  iButtons: 'iButtons',
  LTitle: 'lTitle',
  List: 'list',
  Ans: 'ans',
  File: 'file',
  Link: 'link',
  next: 'next',
};

/** RFC4180 CSV row tokenizer: handles quoted fields with embedded commas, newlines, and "" escapes. */
export function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = csvText.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = csvText[i];
    if (inQuotes) {
      if (c === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      endField();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // trailing field/row (file may or may not end with a newline)
  if (field.length > 0 || row.length > 0) {
    endRow();
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

interface HeaderMap {
  dayIdx: number;
  dayTopicIdx: number;
  moduleFields: { moduleNumber: number; field: keyof ModuleRecord; colIdx: number }[];
}

function parseHeader(headerRow: string[]): HeaderMap {
  const dayIdx = headerRow.indexOf('Day');
  const dayTopicIdx = headerRow.indexOf('Day Topic');
  if (dayIdx === -1) throw new Error('CSV missing required "Day" column');

  const moduleFields: HeaderMap['moduleFields'] = [];
  const re = /^Module (\d+) (.+)$/;
  headerRow.forEach((colName, colIdx) => {
    const m = colName.match(re);
    if (!m) return;
    const moduleNumber = parseInt(m[1], 10);
    const suffix = m[2];
    const field = MODULE_FIELD_MAP[suffix];
    if (!field) return; // unrecognized suffix — ignore rather than fail the whole import
    moduleFields.push({ moduleNumber, field, colIdx });
  });

  return { dayIdx, dayTopicIdx, moduleFields };
}

function isModuleRecordEmpty(m: ModuleRecord): boolean {
  return !m.text && !m.question && !m.iBody && !m.iButtons && !m.lTitle && !m.list && !m.ans && !m.file && !m.link;
  // note: `next` alone (a trailing button label with no content) does not count as a real module
}

/** Parses the full wide-grid CSV into per-day, per-module records. Rows with an empty Day cell are skipped. */
export function parseCsvGrid(csvText: string): DayRecord[] {
  const rows = parseCsvRows(csvText.trim());
  if (rows.length === 0) return [];
  const header = parseHeader(rows[0]);

  const days: DayRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const dayCell = row[header.dayIdx]?.trim();
    if (!dayCell) continue;
    const day = parseInt(dayCell, 10);
    if (Number.isNaN(day)) continue;

    const modulesByNumber = new Map<number, ModuleRecord>();
    for (const { moduleNumber, field, colIdx } of header.moduleFields) {
      const raw = row[colIdx];
      if (raw === undefined || raw === '') continue;
      let rec = modulesByNumber.get(moduleNumber);
      if (!rec) {
        rec = { day, moduleNumber };
        modulesByNumber.set(moduleNumber, rec);
      }
      (rec[field] as string) = raw;
    }

    const modules = Array.from(modulesByNumber.values())
      .filter((m) => !isModuleRecordEmpty(m))
      .sort((a, b) => a.moduleNumber - b.moduleNumber);

    days.push({
      day,
      dayTopic: header.dayTopicIdx !== -1 ? row[header.dayTopicIdx]?.trim() || undefined : undefined,
      modules,
    });
  }

  return days.sort((a, b) => a.day - b.day);
}
