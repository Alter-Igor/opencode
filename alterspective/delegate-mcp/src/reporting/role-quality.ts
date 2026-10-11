// Quality-loop guard: is Synapse's published suitability table good enough that the bridge's
// client-side tie-break can be dropped (the deal on Synapse #1926/#1918)? Never trust memory for
// this - compare the LIVE table against our measured outcomes. Pure over (suitability, rates, dead,
// offered): no clock, no disk, no network. Roles are discovered from the table, never listed here.
//
// A role is `baked` when its published top pick is a model that is (a) offered by the box, (b) not
// dead (the ghost-row class: listed at a top score but 404ing at every call) and (c) within `tol`
// of the best measured success rate for any offered model in that role's table. That is the whole
// point of the loop: real serving outcomes should be visible in the published scores before the
// consumer stops adding its own tie-break.
export type ModelRate = { model: string; successRate: number | null; tasks: number }
export type RoleVerdict = {
  role: string
  /** Published top pick among offered models (the score the gateway itself prefers). */
  published: { model: string; score: number } | undefined
  /** Highest measured success rate among the offered models that appear in this role's table. */
  measured: ModelRate | undefined
  /** Published top pick is offered, alive, and its measured rate is within tol of the measured best. */
  baked: boolean
  reason: string
}
export type QualityReport = { roles: RoleVerdict[]; allBaked: boolean; deadInTable: string[] }

const LOW_N = 5

const bare = (id: string) => (id.startsWith("synapse/") ? id.slice("synapse/".length) : id)

export function qualityReport(
  suitability: Record<string, Record<string, number>> | undefined,
  rates: readonly ModelRate[],
  dead: readonly string[],
  offered: readonly string[] = [],
  tol = 0.1,
): QualityReport {
  if (!suitability) return { roles: [], allBaked: false, deadInTable: [] }
  const rateBy = new Map(rates.map((r) => [bare(r.model), r]))
  const offeredBare = new Set(offered.map(bare))
  const isOffered = (id: string) => offeredBare.size === 0 || offeredBare.has(id)
  const deadInTable = [...new Set(Object.keys(suitability).filter((id) => dead.includes(id)))].sort()
  const roles = [...new Set(Object.values(suitability).flatMap((s) => Object.keys(s)))].sort()
  const verdicts: RoleVerdict[] = []
  for (const role of roles) {
    const entries = Object.entries(suitability)
      .filter(([id, s]) => typeof s[role] === "number" && isOffered(id))
      .map(([id, s]) => ({ model: id, score: s[role] as number }))
    const published = entries.sort((a, b) => b.score - a.score || a.model.localeCompare(b.model))[0]
    const candidates = entries.map((e) => rateBy.get(e.model)).filter((r): r is ModelRate => r !== undefined && r.successRate !== null && r.tasks >= LOW_N)
    const measured = [...candidates].sort((a, b) => (b.successRate as number) - (a.successRate as number) || a.model.localeCompare(b.model))[0]
    if (!published) {
      verdicts.push({ role, published: undefined, measured: undefined, baked: false, reason: "no offered model carries this role" })
      continue
    }
    if (dead.includes(published.model)) {
      verdicts.push({ role, published, measured, baked: false, reason: `published pick ${published.model} is a dead route (404 class) - the table still lists it` })
      continue
    }
    if (!measured) {
      verdicts.push({ role, published, measured: undefined, baked: false, reason: `no measured rate for any offered ${role} model (need ${LOW_N}+ finished tasks)` })
      continue
    }
    const pub = rateBy.get(published.model)
    if (!pub || pub.successRate === null || pub.tasks < LOW_N) {
      verdicts.push({ role, published, measured, baked: false, reason: `published pick ${published.model} has too little measured history (needs ${LOW_N}+ finished tasks)` })
      continue
    }
    const gap = (measured.successRate as number) - pub.successRate
    const baked = gap <= tol
    verdicts.push({
      role,
      published,
      measured,
      baked,
      reason: baked
        ? `${published.model} published ${published.score.toFixed(2)} measures ${(pub.successRate as number) * 100}%, best measured ${measured.model} at ${(measured.successRate as number) * 100}% (gap ${gap.toFixed(2)} <= ${tol})`
        : `published ${published.model} (${published.score.toFixed(2)}) measures ${pub.successRate * 100}% but ${measured.model} does ${(measured.successRate as number) * 100}% - gap ${gap.toFixed(2)} > ${tol}`,
    })
  }
  // allBaked also refuses while any dead route is still published (the ghost class): the table is
  // not trustworthy as the sole signal until those rows are gone, even if some other role looks baked.
  return { roles: verdicts, allBaked: verdicts.length > 0 && deadInTable.length === 0 && verdicts.every((v) => v.baked), deadInTable }
}

