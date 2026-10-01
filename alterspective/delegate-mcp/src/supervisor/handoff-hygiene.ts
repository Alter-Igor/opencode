// G-7 follow-ups (review L5, L6): keep the hand-off clean on every box start and reuse.
// - The box-only volume /handoff/out outlives the box. A collect that crashed before its cleanup
//   leaves a bundle there, so every start and reuse sweeps it (best effort). Only bundles older
//   than SWEEP_MIN_AGE_MINUTES go (review N1): a collect in another bridge holds no lock, and its
//   bundle lives for seconds (written, checked, copied out, removed), so a fresh one is never
//   swept from under it. No shell: `find` gets its arguments as an array.
// - Before G-7 the host had <home>/handoff/out (a bind source). It is removed with rmdir only:
//   an empty folder goes, anything else (not empty, a file, a link on POSIX) stays and is logged.
import { rmdir } from "node:fs/promises"
import path from "node:path"
import type { Run } from "./run.ts"

export const SWEEP_MIN_AGE_MINUTES = 30
/** The only thing the sweep removes: plain files named like a session bundle (planOutBundle), older than 30 minutes. */
export const SWEEP_ARGS = ["find", "/handoff/out", "-maxdepth", "1", "-type", "f", "-name", "*-out.bundle", "-mmin", `+${SWEEP_MIN_AGE_MINUTES}`, "-delete"] as const

/** Best effort: a failed sweep is logged, never fatal (the bundles are box-only). */
export async function sweepOutBundles(run: Run): Promise<void> {
  const result = await run.deps.exec(["docker", "exec", run.container, ...SWEEP_ARGS], { timeoutMs: 20_000 }).catch((error: unknown) => ({ code: -1, stdout: "", stderr: String(error) }))
  if (result.code === 0) run.note("info", "swept leftover session bundles from the box", {})
  else run.note("warn", "could not sweep leftover session bundles from the box", { detail: result.stderr.slice(0, 200) })
}

/** Remove the pre-G-7 host folder <home>/handoff/out when it is empty. Never throws. */
export async function removeLegacyOut(run: Run): Promise<void> {
  const legacy = path.join(run.dirs.handoff, "out")
  try {
    await rmdir(legacy)
    run.note("info", "removed the legacy empty handoff/out folder", {})
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"
    if (code !== "ENOENT") run.note("warn", "left the legacy handoff/out folder in place", { code })
  }
}
