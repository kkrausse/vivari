// A timer that came due while the process was busy runs before a file-watch event that
// arrived during the same busy stretch, as on Node (timers phase, then I/O).
//
// Why it matters: chokidar (Vite's watcher) suppresses a path's repeated events with
// short timers (5 ms per raw event, 50 ms per 'change') and has no trailing emit. The
// loop ran due timers once per turn, at its start, and delivered watch events at its
// end. A turn that spent longer than those timers in between (a dev server transforming
// a stylesheet for the previous edit) handed chokidar the next write's event while the
// expired throttle was still standing, and that write was dropped for good: the preview
// kept the old content until the file was written again. Seen live in the browser
// (toolkit docs/experiments/2026-10-03-startup-combined.md).
//
// The loop alone, with the watch drain stubbed: whether the browser has already queued
// the kernel's message by the end of the busy callback is the host's timing, not the
// contract under test.
import assert from "node:assert/strict";
import { createEventLoop } from "../packages/runtime/loop.js";

const order = [];
let watchEventQueued = false;
let watching = true;
const loop = createEventLoop({
  isAlive: () => watching,
  doWatch: () => {
    if (!watchEventQueued) return;
    watchEventQueued = false;
    order.push("watch");
    watching = false;
  },
});
// One callback after the turn's timers have run (as a request handler is): it arms a
// 10 ms timer, a watched file changes (the kernel queues the event at once), and it
// stays busy for 40 ms. Both are waiting when it returns.
loop.setImmediate(() => {
  loop.setTimeout(() => order.push("timer"), 10);
  watchEventQueued = true;
  const until = Date.now() + 40;
  while (Date.now() < until);
});
const deadline = setTimeout(() => { console.error("FAIL: watch-after-timers deadline"); process.exit(1); }, 10_000);
await loop.drive();
clearTimeout(deadline);
assert.deepEqual(order, ["timer", "watch"], "a due timer must run before a watch event queued in the same turn");
console.log("PASS a timer that came due during a busy turn runs before a watch event queued in that turn");
process.exit(0); // the loop's MessageChannel would keep Node alive
