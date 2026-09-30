/** Concrete Vivari workspace-host contracts. Paths are runtime-absolute. */
export type DiagnosticEvent = { stage: string; elapsedMs: number; detail?: Record<string, unknown> };
export interface Distribution {
  readonly name: string;
  readonly version: string;
  readonly assetBaseUrl: string;
}
export type PersistenceState =
  | { status: "opening" }
  | { status: "durable" }
  | { status: "ephemeral"; reason: string }
  | { status: "failed"; error: string };
export type InstallTreeEntry =
  | { kind: "directory"; path: string; mode: number }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "file"; path: string; mode: number; bytes: Uint8Array; sha256: string; verifyReadback?: boolean };
export type InstallTreeImageEntry =
  | { kind: "directory"; path: string; mode: number }
  | { kind: "symlink"; path: string; target: string }
  | { kind: "file"; path: string; mode: number; bytes: Uint8Array; logicalBytes: number; encoding: 0 | 1; sha256: string };
export interface TreeInstallResult { files: number; verifyMs: number; installMs: number; readbackMs: number }
export interface NodeLaunchOptions {
  entry: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
export interface Execution {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<{ exitCode: number; signal: string | null; forced: boolean; cleanupError?: string }>;
  writeStdin(bytes: Uint8Array): void;
  closeStdin(): void;
  stop(): Promise<void>;
}
export interface PreviewAttachment { dispose(): void }
export interface PreviewOptions {
  /** Host application chooses routing; transport only validates and carries it. */
  hostPaths?: readonly string[];
}
export interface Endpoint {
  readonly url: string;
  readonly port: number;
  readonly closed: Promise<{ reason: string }>;
  /** Admission closure is not cleanup. Settles after disposal and every owned
   * request read/cancel continuation; rejects if source cleanup failed. */
  readonly settled: Promise<void>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  attachPreview(iframe: HTMLIFrameElement, options?: PreviewOptions): PreviewAttachment;
  dispose(): void;
}
export type ErrorCode = "ENTRY_NOT_FOUND" | "LAUNCH_REJECTED" | "BACKEND_UNAVAILABLE"
  | "CLOSED" | "ATTACHED" | "STORAGE_BUSY" | "UNSUPPORTED_WORKSPACE" | "CLEANUP_FAILED"
  | "DISTRIBUTION_MISMATCH" | "OUTPUT_OVERFLOW" | "TOOL_FAILED";
export class WorkspaceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; this.name = "WorkspaceError"; }
}
