import type { Host } from "./host.js";
import { WorkspaceError, type Execution, type NodeLaunchOptions } from "./types.js";

/** Bound the retained host queue. Overflow kills execution, never drops bytes. */
export class ByteQueue implements AsyncIterable<Uint8Array> {
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private error?: Error;
  private claimed = false;
  private wake?: () => void;
  private overflow: (error: Error) => void;
  readonly limit: number;
  private consumed: (bytes: number) => void;
  constructor(overflow: (error: Error) => void, limit = 1024 * 1024, consumed: (bytes: number) => void = () => {}) {
    this.overflow = overflow; this.limit = limit; this.consumed = consumed;
  }
  push(chunk: Uint8Array): void {
    if (this.ended) { this.consumed(chunk.length); return; }
    if (this.bytes + chunk.length > this.limit) {
      const error = new WorkspaceError("OUTPUT_OVERFLOW", `Unread output exceeded ${this.limit} bytes`);
      this.end(error); this.overflow(error); return;
    }
    if (chunk.length) { this.chunks.push(chunk); this.bytes += chunk.length; }
    this.wake?.();
  }
  end(error?: Error): void { this.ended = true; this.error ??= error; this.wake?.(); }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.claimed) throw new Error("Execution streams permit one reader");
    this.claimed = true;
    try {
      while (true) {
        if (this.error) throw this.error;
        const chunk = this.chunks.shift();
        if (chunk) { this.bytes -= chunk.length; this.consumed(chunk.length); yield chunk; continue; }
        if (this.ended) return;
        await new Promise<void>(resolve => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally {
      this.consumed(this.bytes); this.chunks = []; this.bytes = 0;
      // Cancelling one stream discards only that stream, not the process.
      this.ended = true;
    }
  }
}

export async function launch(host: Host, options: NodeLaunchOptions, binding: Record<string, unknown> = {}): Promise<Execution> {
  options.signal?.throwIfAborted();
  if (!options.entry.startsWith("/")) throw new WorkspaceError("LAUNCH_REJECTED", "entry must be an absolute runtime path");
  const entry = await host.request("vv-stat", { path: options.entry });
  if (!entry.exists || entry.isDir) throw new WorkspaceError("ENTRY_NOT_FOUND", options.entry);
  options.signal?.throwIfAborted();
  const execId = host.nextExecution++;
  const credits = new Int32Array(new SharedArrayBuffer(8));
  let done = false, started = false, stopped = false;
  let resolveExit!: (result: Awaited<Execution["exited"]>) => void;
  let resolveStart!: () => void, rejectStart!: (error: Error) => void;
  const exited = new Promise<Awaited<Execution["exited"]>>(resolve => { resolveExit = resolve; });
  const accepted = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const stop = async () => {
    if (!done && !stopped) { stopped = true; host.post("proc-kill", { execId }); }
    const result = await exited;
    if (result.cleanupError) throw new WorkspaceError("CLEANUP_FAILED", result.cleanupError);
  };
  const overflow = () => { void stop().catch(() => {}); };
  const stdout = new ByteQueue(overflow, 1048576, n => { Atomics.sub(credits, 0, n); });
  const stderr = new ByteQueue(overflow, 1048576, n => { Atomics.sub(credits, 1, n); });
  const abort = () => { void stop().catch(() => {}); };
  const off = host.on(m => {
    if (m.type === "host-error") {
      const error = new Error(String(m.error));
      done = true; off(); stdout.end(error); stderr.end(error); rejectStart(error);
      options.signal?.removeEventListener("abort", abort);
      // A deliberate workspace close is a kill, not a failed cleanup: stop() must not throw.
      resolveExit({ exitCode: 143, signal: "SIGTERM", forced: true, ...(m.closed ? {} : { cleanupError: String(m.error) }) });
      return;
    }
    if (m.execId !== execId) return;
    if (m.type === "proc-output-error") {
      const error = new WorkspaceError("OUTPUT_OVERFLOW", "Unread output exceeded 1048576 bytes (including worker transit)");
      (m.channel === 1 ? stderr : stdout).end(error);
    }
    if (m.type === "proc-started") {
      started = true; resolveStart();
      if (stopped) host.post("proc-kill", { execId });
    }
    if (m.type === "proc-out") {
      const bytes = typeof m.chunk === "string" ? new TextEncoder().encode(m.chunk) : m.chunk as Uint8Array;
      (m.stream === "stderr" ? stderr : stdout).push(bytes);
    }
    if (m.type === "proc-exit") {
      done = true; off(); options.signal?.removeEventListener("abort", abort);
      stdout.end(); stderr.end();
      if (!started) rejectStart(new WorkspaceError("LAUNCH_REJECTED", String(m.error ?? "Launch failed")));
      resolveExit({ exitCode: Number(m.code), signal: m.signal ? String(m.signal) : null, forced: !!m.signal, ...(m.cleanupError ? { cleanupError: String(m.cleanupError) } : {}) });
    }
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  // /bin/node.js selects the installed frontend explicitly, independently of PATH.
  host.post("proc-spawn", { execId, command: "/bin/node.js", args: [options.entry, ...(options.args ?? [])], cwd: options.cwd ?? "/workspace", env: { ...options.env, VV_BYTE_STDIO: "1" }, stdioCredits: credits.buffer, ...binding });
  await accepted;
  return {
    stdout, stderr, exited, stop,
    writeStdin(bytes) { if (done) throw new WorkspaceError("CLOSED", "Execution exited"); host.post("proc-input", { execId, chunk: bytes }); },
    closeStdin() { if (!done) host.post("proc-input", { execId, chunk: null }); },
  };
}
