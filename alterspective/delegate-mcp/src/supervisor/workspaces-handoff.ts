// MOD-01 workspaces: the hand-off folder the box shares with the host (review C-4).
//
// Layout (host `<home>/handoff`, box `/handoff`):
//   in/   host writes the owner's bundle; the box only reads it  (mount read-only in the box)
//   out/  the box writes the session bundle; the host takes it   (mount read-write in the box)
//
// The box is untrusted, so every host-side step assumes it may have planted something:
// - in-bundle: a fresh unique name; any existing entry there (file, symlink, junction) is removed
//   with lstat semantics (never followed), then the name is reserved with an exclusive create.
// - out-bundle: moved (rename, not copy) into a host-only quarantine folder first, so the box can no
//   longer swap it, then refused unless it is a regular file within the size cap. Only then fetched.
import { randomBytes } from "node:crypto"
import { closeSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, type Stats, unlinkSync } from "node:fs"
import path from "node:path"
import { DelegateError } from "../shared/errors.ts"

export const HANDOFF_IN = "in"
export const HANDOFF_OUT = "out"
export const DEFAULT_MAX_BUNDLE_BYTES = 500 * 1024 * 1024

const refused = (message: string, detail?: string) =>
  new DelegateError("policy_violation", message, "Run oc_doctor; if it repeats, stop the box and clear the hand-off folder.", detail)

export const randomNonce = () => randomBytes(8).toString("hex")

function lstatOrUndefined(p: string): Stats | undefined {
  try {
    return lstatSync(p)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/** Create `dir` if missing; refuse when it is a link or not a directory (the box may have swapped it). */
export function ensureRealDir(dir: string): void {
  const stat = lstatOrUndefined(dir)
  if (!stat) {
    mkdirSync(dir, { recursive: true })
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
  } catch {
    rmdirSync(p) // a directory symlink or junction on Windows
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
    throw refused("The hand-off bundle name was taken while it was being reserved.", `${hostPath}: ${(error as NodeJS.ErrnoException).code}`)
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

export type OutBundle = { hostPath: string; boxPath: string; quarantinePath: string }

/** Pick a fresh out-bundle name for `key` and clear anything planted at it. */
export function planOutBundle(handoffDir: string, boxHandoff: string, quarantineDir: string, key: string, nonce: string): OutBundle {
  ensureRealDir(handoffDir)
  const dir = path.join(handoffDir, HANDOFF_OUT)
  ensureRealDir(dir)
  const name = `${key}-${nonce}-out.bundle`
  const hostPath = path.join(dir, name)
  removeEntry(hostPath)
  return { hostPath, boxPath: `${boxHandoff}/${HANDOFF_OUT}/${name}`, quarantinePath: path.join(quarantineDir, name) }
}

/** Move the box's bundle out of its reach, then check type and size. Returns the host-only path. */
export function takeOutBundle(bundle: OutBundle, maxBytes: number): string {
  assertRegularFile(bundle.hostPath, "session bundle") // clear message when the box wrote nothing
  ensureRealDir(path.dirname(bundle.quarantinePath))
  removeEntry(bundle.quarantinePath)
  try {
    renameSync(bundle.hostPath, bundle.quarantinePath) // moves the entry itself, never a link target
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new DelegateError("upstream_error", "The session bundle could not be moved off the hand-off folder.", "Keep the bridge home on one drive (OPENCODE_DELEGATE_HOME).", String(code))
  }
  const stat = assertRegularFile(bundle.quarantinePath, "session bundle")
  if (stat.size > maxBytes) {
    removeQuietly(bundle.quarantinePath)
    throw new DelegateError("bundle_too_large", `The session bundle is ${stat.size} bytes, over the ${maxBytes}-byte limit; nothing was fetched.`, "Ask the delegate to drop large or generated files from its commits, then collect again.")
  }
  return bundle.quarantinePath
}
