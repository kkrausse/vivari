// A spawned in-VM process, exposed with Web Streams for stdio.
//
// Output (stdout + stderr, terminal-style) arrives as string chunks on a
// ReadableStream; stdin is a WritableStream; `exit` resolves with the code. This
// maps onto the kernel worker's generic `proc-spawn` / `proc-out` / `proc-exit`
// protocol (one process per `execId`).

import type { KernelBridge } from "./bridge";
import type { KernelMessage, SpawnOptions } from "./types";

export class VivariProcess {
  /** Merged stdout + stderr as UTF-8 string chunks (raw, ANSI escapes intact). */
  readonly output: ReadableStream<string>;
  /** Process stdin. Writing a string forwards it; closing the stream sends EOF. */
  readonly input: WritableStream<string>;
  /** Resolves with the exit code when the process ends. */
  readonly exit: Promise<number>;

  private readonly bridge: KernelBridge;
  private readonly execId: number;
  private killed = false;
  private started = false;
  private terminal?: { cols: number; rows: number };

  constructor(
    bridge: KernelBridge,
    execId: number,
    command: string,
    args: string[],
    options: SpawnOptions,
  ) {
    this.bridge = bridge;
    this.execId = execId;
    if (options.terminal) this.validateTerminal(options.terminal);
    this.terminal = options.terminal;
    const offStarted = bridge.on("proc-started", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      this.started = true;
      offStarted();
      if (this.terminal) this.resize(this.terminal);
    });

    let outController!: ReadableStreamDefaultController<string>;
    let resolveExit!: (code: number) => void;
    this.exit = new Promise<number>((resolve) => (resolveExit = resolve));

    const offOut = bridge.on("proc-out", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      try {
        // There is no worker-side credit protocol yet. Bound the SDK queue and
        // fail/terminate explicitly rather than silently dropping terminal bytes.
        if ((m.chunk as string).length > (outController.desiredSize ?? 0)) {
          outController.error(new Error("Vivari process output backlog exceeded 1 Mi characters"));
          this.kill();
          return;
        }
        outController.enqueue(m.chunk as string);
      } catch {
        /* consumer cancelled the stream */
      }
    });
    const offExit = bridge.on("proc-exit", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      offOut();
      offExit();
      offStarted();
      this.killed = true;
      try {
        outController.close();
      } catch {
        /* already closed */
      }
      resolveExit(typeof m.code === "number" ? m.code : 0);
    });

    this.output = new ReadableStream<string>({
      start: (controller) => {
        outController = controller;
      },
      cancel: () => this.kill(),
    }, { highWaterMark: 1 << 20, size: chunk => chunk?.length ?? 0 });

    this.input = new WritableStream<string>({
      write: (chunk) => {
        bridge.post("proc-input", { execId, chunk });
      },
      close: () => {
        bridge.post("proc-input", { execId, chunk: null });
      },
      abort: () => this.kill(),
    });

    // Listeners are wired; launch the process.
    bridge.post("proc-spawn", {
      execId,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      terminal: options.terminal,
    });
  }

  private validateTerminal(size: { cols: number; rows: number }): void {
    if (![size.cols, size.rows].every(n => Number.isInteger(n) && n > 0 && n <= 65535))
      throw new RangeError("Terminal cols/rows must be integers from 1 to 65535");
  }

  /** Update the owned terminal and its descendants asynchronously. */
  resize(size: { cols: number; rows: number }): void {
    this.validateTerminal(size);
    if (this.killed) return;
    this.terminal = { ...size };
    if (this.started) this.bridge.post("proc-resize", { execId: this.execId, ...size });
  }

  /** Force termination and subtree cleanup. Its `exit` still resolves. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.bridge.post("proc-kill", { execId: this.execId });
  }
}
