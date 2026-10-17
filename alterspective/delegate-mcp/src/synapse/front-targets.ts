// #178: since #171/#172 two box generations can run at once, each with its own `front` and its own
// include folder (shared/config.ts frontDir). The token state is one per bridge home, so a renewal
// must reach every front this home runs: the bridge that wins the lock is often bound to the
// other box, and the box it did not write keeps serving an expired bearer (Synapse answers 401).
import { stat } from "node:fs/promises"
import { frontDir } from "../shared/config.ts"
import { readGenerations } from "../supervisor/generations.ts"

/** One box's front: the host folder its includes are read from, and its container. */
export type FrontTarget = { frontDir: string; frontContainer: string }

const isDir = (dir: string) => stat(dir).then((s) => s.isDirectory(), () => false)

/**
 * Every front this bridge home runs: `own` first, then the base project's and each remembered
 * generation's. A folder that does not exist yet is left out (its box never started, and writing
 * there would create it); `own` is always kept.
 *
 * @param home the bridge home
 * @param base the base compose project (config.project)
 * @param own the front this bridge is bound to
 * @returns the targets, `own` first, each container once
 */
export async function frontTargets(home: string, base: string, own: FrontTarget): Promise<FrontTarget[]> {
  const projects = [base, ...(await readGenerations(home))]
  const targets: FrontTarget[] = [own]
  for (const project of projects) {
    const target = { frontDir: frontDir({ home, project }), frontContainer: `${project}-front` }
    if (targets.some((t) => t.frontContainer === target.frontContainer || t.frontDir === target.frontDir)) continue
    if (await isDir(target.frontDir)) targets.push(target)
  }
  return targets
}
