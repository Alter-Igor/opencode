// The warnings every tool that fetches a session branch reports (oc_collect, oc_land, oc_verify).
import type { ToolContext } from "./context.ts"
import { untrusted } from "./shape.ts"

type CollectResult = Awaited<ReturnType<ToolContext["workspaces"]["collect"]>>

/**
 * The collect warnings every tool that fetches a branch reports (#186: oc_land and oc_verify
 * collect too, and once dropped them). `summary` is "" when there is nothing to warn about.
 */
export function collectWarnings(result: CollectResult) {
  const risky = result.hostExecutableChanges
  const warning = risky.length
    ? `WARNING: ${risky.length} changed file${risky.length === 1 ? "" : "s"} can run on the host (hooks, scripts or CI). Review them before running anything from ${result.branch}.`
    : undefined
  // #162: the box's git filter rewrites the npm lockfiles; anything it misses is flagged here.
  // null: the host check failed after the fetch; the branch is still here, so it is a warning.
  const mirror = result.mirrorAddressFiles ?? []
  const mirrorWarning = result.mirrorAddressFiles === null
    ? "WARNING: the check for the sandbox's package cache address (npm-cache:4873, pypi-cache:5000) in changed files could not run. Search the branch for those addresses before merging."
    : mirror.length
      ? `WARNING: ${mirror.length} changed file${mirror.length === 1 ? "" : "s"} still name${mirror.length === 1 ? "s" : ""} the sandbox's package cache (http://npm-cache:4873 or http://pypi-cache:5000), which a build outside the sandbox cannot reach. Point them at the public registry before merging.`
      : undefined
  return {
    summary: [warning, mirrorWarning].filter(Boolean).join(" "),
    fields: {
      hostExecutableChanges: { count: risky.length, ...(warning ? { warning, paths: untrusted(risky.join("\n"), 4000) } : {}) },
      // The reason quotes git's stderr, which can name the agent's files: untrusted.
      mirrorAddressFiles: result.mirrorAddressFiles === null
        ? { checked: false, warning: mirrorWarning, ...(result.mirrorCheckError ? { reason: untrusted(result.mirrorCheckError, 400) } : {}) }
        : { count: mirror.length, ...(mirrorWarning ? { warning: mirrorWarning, paths: untrusted(mirror.join("\n"), 4000) } : {}) },
    },
  }
}
