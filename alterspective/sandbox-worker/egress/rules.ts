// #118 (svc-coding-agent#46): the sandbox's own egress firewall.
// E2B's network rules do not stop 169.254.169.254 (Firecracker MMDS answers 401) and refuse an
// IPv6 `::/0` deny rule, so root inside the sandbox installs this nftables ruleset before the
// agent starts. Pure: renders text only, so it is unit tested; `lockdown.ts` applies it.

export const TABLE = "sbxw_egress"

/** Never reachable, whatever the allow list says. Dropped before any allow rule. */
export const FORBIDDEN_V4: readonly { cidr: string; label: string }[] = [
  { cidr: "169.254.169.254/32", label: "metadata" },
  { cidr: "169.254.0.0/16", label: "link-local" },
  { cidr: "10.0.0.0/8", label: "private" },
  { cidr: "172.16.0.0/12", label: "private" },
  { cidr: "192.168.0.0/16", label: "private" },
  { cidr: "100.64.0.0/10", label: "cgnat" },
  { cidr: "0.0.0.0/8", label: "this-network" },
  { cidr: "224.0.0.0/4", label: "multicast" },
  { cidr: "240.0.0.0/4", label: "reserved" },
]

export type AllowEntry = { cidr: string; port: number }
export type EgressConfig = { allow: AllowEntry[]; dns?: string }

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)"
const IPV4 = new RegExp(`^${OCTET}(\\.${OCTET}){3}$`)

/** Dotted IPv4 to an unsigned integer (input already validated). */
function ipToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0)
}

/** `a.b.c.d` or `a.b.c.d/n` → [first, last] as unsigned ints. Throws on bad input. */
export function cidrRange(cidr: string): [number, number] {
  const [ip, bitsText] = cidr.split("/")
  if (!IPV4.test(ip)) throw new Error(`not an IPv4 address: ${cidr}`)
  const bits = bitsText === undefined ? 32 : Number(bitsText)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) throw new Error(`bad prefix length: ${cidr}`)
  const size = 2 ** (32 - bits)
  const first = Math.floor(ipToInt(ip) / size) * size
  return [first, first + size - 1]
}

/** True when two IPv4 CIDR blocks share any address. */
const overlaps = (a: string, b: string): boolean => {
  const [a1, a2] = cidrRange(a)
  const [b1, b2] = cidrRange(b)
  return a1 <= b2 && b1 <= a2
}

/** `1.2.3.4:443,10.1.0.0/16:8080` → entries. IPv4 only; throws on anything else. */
export function parseAllow(text: string | undefined): AllowEntry[] {
  if (!text?.trim()) return []
  return text.split(",").map((raw) => {
    const item = raw.trim()
    const at = item.lastIndexOf(":")
    if (at < 0) throw new Error(`allow entry needs ip:port: ${item}`)
    const cidr = item.slice(0, at)
    const port = Number(item.slice(at + 1))
    cidrRange(cidr)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad port in allow entry: ${item}`)
    return { cidr, port }
  })
}

/**
 * The ruleset: one `ip` table and one `ip6` table. The E2B kernel has no `inet` (dual-stack)
 * family (CONFIG_NF_TABLES_INET unset; `nft` reports "Operation not supported"). Order matters:
 * 1. loopback and replies to connections already open (the E2B SDK talks to its in-sandbox
 *    daemon over inbound connections from a private address; their replies must pass, so this
 *    comes BEFORE the private-range drops - observed: dropping 10.0.0.0/8 first froze the SDK);
 * 2. forbidden IPv4 ranges, each with a counter, so a probe can prove the drop; every new IPv6
 *    packet is dropped and counted in the `ip6` table;
 * 3. the allow list (and DNS, only if a resolver is given);
 * 4. everything else dropped, counted.
 * Throws if an allow entry or the resolver falls inside a forbidden range: fail closed and loud.
 */
export function renderRuleset(config: EgressConfig): string {
  for (const entry of config.allow) {
    const hit = FORBIDDEN_V4.find((f) => overlaps(entry.cidr, f.cidr))
    if (hit) throw new Error(`allow entry ${entry.cidr}:${entry.port} is inside a forbidden range (${hit.label} ${hit.cidr})`)
  }
  if (config.dns !== undefined) {
    if (!IPV4.test(config.dns)) throw new Error(`dns must be an IPv4 address: ${config.dns}`)
    const hit = FORBIDDEN_V4.find((f) => overlaps(config.dns!, f.cidr))
    if (hit) throw new Error(`dns ${config.dns} is inside a forbidden range (${hit.label} ${hit.cidr})`)
  }
  const lines = [
    // Re-runnable: create, then delete, then define, all in one atomic `nft -f` transaction.
    `add table ip ${TABLE}`,
    `delete table ip ${TABLE}`,
    `add table ip6 ${TABLE}`,
    `delete table ip6 ${TABLE}`,
    `table ip ${TABLE} {`,
    `  chain output {`,
    `    type filter hook output priority 0; policy drop;`,
    `    oif "lo" accept`,
    `    ct state established,related accept`,
    ...FORBIDDEN_V4.map((f) => `    ip daddr ${f.cidr} counter drop comment "${f.label}"`),
    ...config.allow.map((a) => `    ip daddr ${a.cidr} tcp dport ${a.port} accept comment "allow"`),
    ...(config.dns ? [`    ip daddr ${config.dns} meta l4proto { tcp, udp } th dport 53 accept comment "dns"`] : []),
    `    counter drop comment "default"`,
    `  }`,
    `}`,
    `table ip6 ${TABLE} {`,
    `  chain output {`,
    `    type filter hook output priority 0; policy drop;`,
    `    oif "lo" accept`,
    `    ct state established,related accept`,
    `    counter drop comment "ipv6"`,
    `  }`,
    `}`,
  ]
  return lines.join("\n") + "\n"
}

/** Counter values by comment, from `nft list table ip|ip6 sbxw_egress` output. */
export function parseCounters(listing: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of listing.split("\n")) {
    const m = line.match(/counter packets (\d+) bytes \d+ .*comment "([^"]+)"/)
    if (m) out[m[2]] = (out[m[2]] ?? 0) + Number(m[1])
  }
  return out
}
