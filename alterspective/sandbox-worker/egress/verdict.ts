// #118: pure go/no-go for the in-sandbox egress probe. The probe (probe-e2b.ts) collects the
// observations from a real E2B sandbox; this decides. Unit tested.

export type PlanItem = { id: string; kind: "tcp" | "udp-dns" | "udp6-send"; host: string; port: number }
export type CheckResult = { id: string; reachable: boolean; detail: string }

/** The probe plan. `allow` is the one target the ruleset allows (the control). */
export function probePlan(allow: { host: string; port: number }): PlanItem[] {
  return [
    { id: "control", kind: "tcp", host: allow.host, port: allow.port },
    { id: "metadata", kind: "tcp", host: "169.254.169.254", port: 80 },
    { id: "link-local", kind: "tcp", host: "169.254.0.1", port: 80 },
    { id: "private-10", kind: "tcp", host: "10.0.0.1", port: 80 },
    { id: "private-172", kind: "tcp", host: "172.16.0.1", port: 80 },
    { id: "private-192", kind: "tcp", host: "192.168.0.1", port: 80 },
    { id: "cgnat", kind: "tcp", host: "100.64.0.1", port: 80 },
    { id: "other-host", kind: "tcp", host: "9.9.9.9", port: 443 },
    { id: "other-port", kind: "tcp", host: allow.host, port: allow.port === 80 ? 443 : 80 },
    { id: "udp-dns", kind: "udp-dns", host: "8.8.8.8", port: 53 },
    { id: "ipv6-public", kind: "tcp", host: "2606:4700:4700::1111", port: 443 },
    { id: "ipv6-on-link", kind: "udp6-send", host: "fe80::1", port: 9 },
  ]
}

export const MUST_BE_BLOCKED = [
  "metadata",
  "link-local",
  "private-10",
  "private-172",
  "private-192",
  "cgnat",
  "other-host",
  "other-port",
  "udp-dns",
  "ipv6-public",
  "ipv6-on-link",
]

export type Observations = {
  before: CheckResult[]
  after: CheckResult[]
  counters: Record<string, number>
  /** Exit code of `/usr/sbin/nft flush ruleset` as the agent user. Non-zero = the agent cannot change it; 127 (not found) proves nothing. */
  agentFlushExit: number
  /** Exit code of `sudo -n true` as the agent user. Non-zero = no sudo. */
  agentSudoExit: number
  /** A command run through the SDK after lockdown came back. */
  sdkWorksAfter: boolean
  /** Connections opened BEFORE lockdown and used after it (checks.py --hold). */
  preOpened: PreOpened[]
}

export type PreOpened = { id: string; answeredBefore: boolean; answeredAfter: boolean | null; detail: string }

/** Blocked targets held open across the lockdown: a flow the box opened earlier must not survive it. */
export const PRE_OPEN_TARGETS = [
  { id: "pre-open-metadata", host: "169.254.169.254", port: 80 },
  // Plain HTTP so the reply is data: a close or reset alone could come from the peer on its own.
  { id: "pre-open-other-host", host: "1.0.0.1", port: 80 },
]

export type Verdict = { go: boolean; line: string; failures: string[]; notes: string[] }

/**
 * GO only when the control is reachable, every must-be-blocked check is blocked, the metadata and
 * ipv6-link-local counters prove real drops, the agent can neither flush the rules nor sudo, and the SDK still
 * works. Every failure is listed; notes say whether the metadata check discriminates.
 */
export function decide(o: Observations): Verdict {
  const failures: string[] = []
  const notes: string[] = []
  const after = new Map(o.after.map((r) => [r.id, r]))
  const before = new Map(o.before.map((r) => [r.id, r]))

  if (!after.get("control")?.reachable) failures.push("control: the allowed target is not reachable after lockdown")
  for (const id of MUST_BE_BLOCKED) {
    const r = after.get(id)
    if (!r) failures.push(`${id}: not checked`)
    else if (r.reachable) failures.push(`${id}: reachable after lockdown (${r.detail})`)
  }
  if (!(o.counters.metadata > 0)) failures.push("counter: no packet hit the metadata drop rule")
  if (!(o.counters["ipv6-link-local"] > 0)) failures.push("counter: no packet hit the ipv6-link-local drop rule")
  if (o.agentFlushExit === 0) failures.push("the agent user could flush the ruleset")
  else if (o.agentFlushExit === 127) failures.push("the flush attempt did not run (nft not found), so it proves nothing")
  if (o.agentSudoExit === 0) failures.push("the agent user has sudo")
  if (!o.sdkWorksAfter) failures.push("the E2B SDK could not run a command after lockdown")
  // Recorded, not judged: conntrack picks pre-lockdown flows up mid-stream, so one can survive.
  // That is why lockdown.ts refuses to run once an agent process exists.
  for (const r of o.preOpened) {
    const outcome = r.answeredAfter === null ? "inconclusive" : r.answeredAfter ? "still gets through" : "cut"
    notes.push(`${r.id}: a connection opened before lockdown ${outcome} (${r.detail}); lockdown runs before the agent starts`)
  }

  if (before.get("metadata")?.reachable) notes.push("metadata was reachable before lockdown, so the check discriminates")
  else notes.push("metadata was NOT reachable before lockdown; the after-check alone does not prove the firewall blocked it (the counter does)")

  const go = failures.length === 0
  const line = go
    ? "T1 in-sandbox egress: GO — metadata, link-local, private, other hosts/ports, UDP DNS and IPv6 blocked; control reachable; agent cannot change rules"
    : `T1 in-sandbox egress: NO-GO — ${failures.length} failure(s)`
  return { go, line, failures, notes }
}
