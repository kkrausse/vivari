import type { DiagnosticEvent } from "./types.js";

/** Observers are optional and must never affect storage/runtime correctness. */
export function diagnosticReporter(observer?: (event: DiagnosticEvent) => void) {
  const started = performance.now();
  let lastStage = "open.requested";
  return {
    emit(stage: string, detail?: Record<string, unknown>) {
      lastStage = stage;
      try { observer?.({ stage, elapsedMs: Math.round(performance.now() - started), detail }); } catch {}
    },
    failure(error: unknown) {
      const elapsedMs = Math.round(performance.now() - started);
      const failure = new Error(`Workspace open failed after ${elapsedMs}ms; last stage: ${lastStage}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      try { observer?.({ stage: "open.failed", elapsedMs, detail: { lastStage, error: failure } }); } catch {}
      return failure;
    },
  };
}
