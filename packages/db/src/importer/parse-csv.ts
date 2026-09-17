/**
 * Minimal RFC-4180 CSV parser (no dependencies, deterministic).
 *
 * Handles: quoted fields, embedded commas / newlines / escaped quotes ("" ),
 * CRLF, CR, and LF line endings, and a leading UTF-8 BOM.
 */

export interface ParsedCsv {
  header: string[];
  rows: { lineNumber: number; fields: string[] }[];
}

export function parseCsv(text: string): ParsedCsv {
  // Strip the UTF-8 BOM if present so the first header name compares cleanly.
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      record.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\r") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      // Handle CRLF as a single terminator.
      if (content[i + 1] === "\n") i += 1;
      i += 1;
      continue;
    }
    if (char === "\n") {
      record.push(field);
      field = "";
      records.push(record);
      record = [];
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  // Final record (file not ending with a newline).
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // Drop trailing fully-empty records (e.g. a trailing newline already handled
  // above, or blank separator lines in hand-edited files).
  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ""));
  const [header = [], ...dataRows] = nonEmpty;

  return {
    header: header.map((h) => h.trim()),
    rows: dataRows.map((fields, index) => ({ lineNumber: index + 2, fields })),
  };
}
