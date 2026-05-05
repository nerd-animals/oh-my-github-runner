/**
 * Per-task cache of successful AI step results so a rate-limit retry can
 * skip steps that already completed. The toolkit reads before each
 * `tk.ai.run({ stepKey })` and writes on success; the daemon drops the
 * task's directory on terminal transition (succeeded / failed / superseded)
 * and sweeps orphan directories at startup.
 *
 * The `fingerprint` field is a hash of every input that affects AI output
 * (rendered prompt, tool, intensity, allowedTools, disallowedTools,
 * outputSchema). Reads compare it against the current invocation's
 * fingerprint so context changes between retries (e.g. issue body edited)
 * invalidate stale results.
 */
export interface CheckpointEntry {
  readonly stepKey: string;
  readonly fingerprint: string;
  readonly tool: string;
  readonly succeededAt: string;
  readonly stdout: string;
}

export interface CheckpointStore {
  read(
    taskId: string,
    stepKey: string,
  ): Promise<CheckpointEntry | undefined>;
  write(taskId: string, entry: CheckpointEntry): Promise<void>;
  /**
   * Remove every checkpoint for the given task. Called on terminal
   * transition. Idempotent — must not throw when the directory does
   * not exist.
   */
  drop(taskId: string): Promise<void>;
  /**
   * Remove orphan task directories whose taskId is NOT in
   * `activeTaskIds`. Called once at daemon startup. Returns the number
   * of directories removed (best-effort; individual failures are logged
   * and skipped).
   */
  sweep(activeTaskIds: ReadonlySet<string>): Promise<number>;
}
