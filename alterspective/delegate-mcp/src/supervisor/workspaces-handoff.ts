// MOD-01 workspaces: the hand-off folder the box shares with the host (review C-4, R3-08).
//
// Layout:
//   in/   host `<home>/handoff/in`, mounted READ-ONLY at box `/handoff/in`: the owner's bundle.
//   out/  box-only: `/handoff/out` is a named Docker volume, never a host folder (issue G-7). The
//         bridge copies the session bundle out with `docker cp` (workspaces-copyout.ts).
//
// The box is untrusted, so every host-side step assumes it may have planted something:
// - in-bundle: a fresh unique name; any existing entry there (file, symlink, junction) is removed
//   with lstat semantics (never followed), then the name is reserved with an exclusive create.
// - out-bundle: streamed into a host-only quarantine folder, refused unless it is one regular file
//   within the size cap, checked again on the host. Only then fetched.
// Every file-system failure is a DelegateError; host paths and errno go to `detail` only (A-07).
import { randomBytes } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, rmdirSync, type Stats, unlinkSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"

export const HANDOFF_IN = "in"
export const HANDOFF_OUT = "out"
export const DEFAULT_MAX_BUNDLE_BYTES = 500 * 1024 * 1024

/** policy_violation: the box planted or swapped something; nothing was used. */
export const refused = (message: string, detail?: string) =>
  new DelegateError("policy_violation", message, "Run oc_doctor; if it repeats, stop the box and clear the hand-off folder.", detail)

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown"

/** A file-system failure in the bridge's hand-off folder (A-07): path and errno in detail only. */
export function handoffFailure(what: string, error: unknown, p: string): DelegateError {
  return new DelegateError(
    "upstream_error",
    `The bridge could not ${what} in its hand-off folder.`,
    "Check the bridge home folder (OPENCODE_DELEGATE_HOME) is on a local drive and writable, then retry. Run oc_doctor if it repeats.",
    `${errno(error)} ${p}`,
  )
}

export const randomNonce = () => randomBytes(8).toString("hex")

function lstatOrUndefined(p: string): Stats | undefined {
  try {
    return lstatSync(p)
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined
    throw handoffFailure("check an entry", error, p)
  }
}

/** Create `dir` if missing; refuse when it is a link or not a directory (the box may have swapped it). */
export function ensureRealDir(dir: string): void {
  const stat = lstatOrUndefined(dir)
  if (!stat) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      throw handoffFailure("create a folder", error, dir)
    }
    return ensureRealDir(dir)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused("A hand-off folder was replaced by a link or a file; nothing was written.", dir)
}

/** Remove whatever is at `p` without following it. A real directory there is refused. */
export function removeEntry(p: string): void {
  const stat = lstatOrUndefined(p)
  if (!stat) return
  if (stat.isDirectory() && !stat.isSymbolicLink()) throw refused("The hand-off folder holds an unexpected directory; nothing was written.", p)
  try {
    unlinkSync(p)
  } catch (unlinkError) {
    try {
      rmdirSync(p) // a directory symlink or junction on Windows
    } catch (error) {
      throw refused("A planted hand-off entry could not be removed.", `${errno(unlinkError)}/${errno(error)} ${p}`)
    }
  }
  if (lstatOrUndefined(p)) throw refused("A planted hand-off entry could not be removed.", p)
}

/** Best-effort removal for `finally` blocks; never throws. */
export function removeQuietly(p: string | undefined): void {
  if (!p) return
  try {
    removeEntry(p)
  } catch {
    // Left for the next run to refuse or clear.
  }
}

export type InBundle = { hostPath: string; boxPath: string }

/** Reserve a fresh in-bundle name for `key` (exclusive create). */
export function reserveInBundle(handoffDir: string, boxHandoff: string, key: string, nonce: string): InBundle {
  ensureRealDir(handoffDir)
  const dir = path.join(handoffDir, HANDOFF_IN)
  ensureRealDir(dir)
  const name = `${key}-${nonce}-in.bundle`
  const hostPath = path.join(dir, name)
  removeEntry(hostPath)
  try {
    closeSync(openSync(hostPath, "wx"))
  } catch (error) {
    throw refused("The hand-off bundle name was taken while it was being reserved.", `${hostPath}: ${errno(error)}`)
  }
  return { hostPath, boxPath: `${boxHandoff}/${HANDOFF_IN}/${name}` }
}

/** Refuse unless `p` is a regular file (lstat: a symlink is never followed). */
export function assertRegularFile(p: string, what: string): Stats {
  const stat = lstatOrUndefined(p)
  if (!stat) throw new DelegateError("upstream_error", `The ${what} did not reach the host.`, "Check the hand-off folder mount (oc_doctor).", p)
  if (stat.isSymbolicLink() || !stat.isFile()) throw refused(`The ${what} is not a regular file; it was not used.`, p)
  return stat
}

export type OutBundle = { boxPath: string; quarantinePath: string }

/** A fresh out-bundle name for `key`: written in the box's own volume, copied into host quarantine. */
export function planOutBundle(boxHandoff: string, quarantineDir: string, key: string, nonce: string): OutBundle {
  const name = `${key}-${nonce}-out.bundle`
  return { boxPath: `${boxHandoff}/${HANDOFF_OUT}/${name}`, quarantinePath: path.join(quarantineDir, name) }
}
