// #132: which Claude Code session delegated. Every session starts its bridge with the same
// OPENCODE_DELEGATE_NAME (the ownership key, which must stay fixed), so the name cannot say. This
// separate label is for the dashboard and oc_report only; it is never an ownership key.
import path from "node:path"

export const MAX_CALLER_CHARS = 128
export const UNKNOWN_CALLER = "(unknown)"

/** OPENCODE_DELEGATE_CALLER if set and non-empty, else the last folder name of the working directory. */
export function callerName(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  // Control characters (a tab or newline in the variable) become spaces: the record would drop the whole label.
  const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()
  const chosen = clean(env.OPENCODE_DELEGATE_CALLER ?? "") || folderName(clean(cwd))
  return chosen.trim().slice(0, MAX_CALLER_CHARS).trim() || UNKNOWN_CALLER
}

/** Windows or POSIX path; a drive root (`C:\`) or `/` has no folder name, so it is returned as it is. */
function folderName(cwd: string): string {
  if (/^[A-Za-z]:[\\/]*$/.test(cwd) || /^[\\/]+$/.test(cwd)) return cwd
  return path.posix.basename(cwd.replaceAll("\\", "/"))
}
