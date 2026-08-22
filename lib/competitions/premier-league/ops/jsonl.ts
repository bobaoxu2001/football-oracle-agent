import fs from "node:fs";
import path from "node:path";

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

export function appendJsonl(file: string, row: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Replace a file's contents atomically: full write to a sibling temp file, then
 * rename. Same-directory rename is atomic on POSIX, so a crash leaves either
 * the old complete file or the new one — never a half-written document.
 */
function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp already gone */
    }
    throw err;
  }
}

export function rewriteJsonl(file: string, rows: unknown[]): void {
  const text = rows.map((r) => JSON.stringify(r)).join("\n");
  writeFileAtomic(file, text ? `${text}\n` : "");
}

/**
 * Read a whole-file JSON document, or null.
 *
 * A crash mid-write leaves a truncated file; throwing here would wedge every
 * subsequent ops tick on unparseable state instead of rebuilding from the
 * caller's default. Corrupt is therefore treated as absent — and reported.
 */
export function readJsonFile<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    console.warn(`[ops] unreadable JSON at ${file} — treating as absent`);
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function unlinkIfExists(file: string): void {
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
