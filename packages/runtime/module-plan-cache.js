// Remembered load plans for very large ES modules.
//
// A bundled server is one multi-megabyte ES module that every process start loads
// again: read, transpile to CJS, compile, evaluate. Two parts of that are pure
// functions of the source text and were recomputed each time: the transpile plan
// (esm.js planEsm: the lexer parse, the export scan and the used-name pass), and
// the fact that the module has top-level await, which the loader only learns by
// compiling it as a plain function, failing, and compiling it again as an async
// one. For a 27.5 M-character bundle those are about 290 ms and 135 ms.
//
// This keeps both as a small JSON record (the plan's head, tail and edit list are
// a few tens of KB whatever the module's size) in a directory the kernel mirrors
// to durable storage, so a later process — in this kernel or after a reopen —
// applies the plan and compiles once.
//
// Safety:
// - The record's name is a 64-bit content hash of the exact source being
//   transpiled plus a hash of the filename (the plan's head embeds the path), and
//   the record repeats the filename, the length and the transpiler version
//   (esm.js esmPlanVersion, derived from the transpiler's own code) which are all
//   checked. A changed file, path or transpiler simply misses.
//   Nothing is keyed by mtime or size alone.
// - A record that does not parse or fails validation is ignored and replaced.
// - "Needs the async wrapper" only reorders the two compile attempts. If the
//   async compile fails, the loader runs its ordinary sequence, so errors are
//   reported exactly as without the cache.
// - Any filesystem error makes the cache a no-op; loading never depends on it.
// - Only modules of MIN_CHARS or more are looked up, so ordinary modules pay
//   nothing (no hash, no read).
// - VV_NO_MODULE_PLAN_CACHE=1 in the process environment turns it off.
import { esmPlanVersion, hashText } from "./esm.js";

const MIN_CHARS = 2 * 1024 * 1024;
const DIRECTORY = "/var/lib/vivari/module-plans";
// Records are one per distinct (large module, version of it); stale ones are only
// ever superseded, so the directory is emptied when it grows past this.
const MAX_RECORDS = 32;

function validPlan(record, filename, chars) {
  if (!record || record.version !== esmPlanVersion() || record.filename !== filename || record.chars !== chars) return false;
  if (typeof record.head !== "string" || typeof record.tail !== "string" || typeof record.async !== "boolean") return false;
  if (!Array.isArray(record.edits)) return false;
  let last = 0;
  for (const edit of record.edits) {
    if (!Array.isArray(edit) || edit.length !== 3) return false;
    const [start, end, text] = edit;
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof text !== "string") return false;
    if (start < last || end < start || end > chars) return false;
    last = end;
  }
  return true;
}

export function createModulePlanCache({ fs, process }) {
  // The cache entry for a module, or null when the module is not large enough (or
  // the cache is off). `plan` is the remembered `{ head, edits, tail, async }`, or
  // null when there is none yet: the caller makes one and hands it to store().
  function lookup(source, filename) {
    if (source.length < MIN_CHARS || process?.env?.VV_NO_MODULE_PLAN_CACHE) return null;
    const entry = { path: `${DIRECTORY}/${hashText(source)}-${hashText(filename)}.json`, filename, chars: source.length, plan: null };
    try {
      const record = JSON.parse(fs.readFileSync(entry.path, "utf8"));
      if (validPlan(record, filename, source.length)) entry.plan = record;
    } catch {
      /* no record, or an unreadable one: make the plan as usual */
    }
    return entry;
  }

  function store(entry, plan, needsAsync) {
    try {
      fs.mkdirSync(DIRECTORY, { recursive: true });
      const existing = fs.readdirSync(DIRECTORY);
      if (existing.length >= MAX_RECORDS) for (const name of existing) fs.unlinkSync(`${DIRECTORY}/${name}`);
      fs.writeFileSync(entry.path, JSON.stringify({
        version: esmPlanVersion(), filename: entry.filename, chars: entry.chars, async: needsAsync,
        head: plan.head, edits: plan.edits, tail: plan.tail,
      }));
    } catch {
      /* read-only or full filesystem: the next start plans again */
    }
  }

  return { lookup, store };
}
