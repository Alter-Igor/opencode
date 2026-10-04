// R3-01 / R3-02 — static checks on docker/compose.yaml: the box's way out is `front` only, and no
// network the box is on holds a listener that forwards to the inbox admin API.
import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { defaultConfig } from "../src/shared/config.ts"
import { SIBLING_SERVICES } from "../src/supervisor/compose-env.ts"

type Service = {
  networks?: string[] | Record<string, { aliases?: string[] } | null>
  environment?: Record<string, string | null>
  command?: string[] | string
  entrypoint?: string[] | string
  ports?: string[]
  volumes?: string[]
  cap_drop?: string[]
  read_only?: boolean
  sysctls?: Record<string, string>
  depends_on?: Record<string, { condition: string }> | string[]
}
type Compose = { services: Record<string, Service>; networks: Record<string, { internal?: boolean } | null> }

const compose = Bun.YAML.parse(await readFile(path.join(import.meta.dir, "..", "docker", "compose.yaml"), "utf8")) as Compose
const services = compose.services
const networksOf = (service: Service) => (Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {}))
const text = (service: Service) => JSON.stringify([service.command, service.entrypoint])

describe("R3-02: the box has no path to the inbox admin API", () => {
  const boxNetworks = networksOf(services.box!)

  test("the box is on `sealed` only, and `sealed` and `admin` are internal", () => {
    expect(boxNetworks).toEqual(["sealed"])
    expect(compose.networks.sealed?.internal).toBe(true)
    expect(compose.networks.admin?.internal).toBe(true)
  })

  test("no service on a network the box is on forwards to inbox-admin or listens on the admin port", () => {
    const shared = Object.entries(services).filter(([name, s]) => name !== "box" && networksOf(s).some((n) => boxNetworks.includes(n)))
    expect(shared.map(([name]) => name).sort()).toEqual(["front", "gate-box", "inbox", "npm-cache", "pypi-cache"])
    for (const [name, service] of shared) {
      expect({ name, forwards: text(service).includes("inbox-admin") }).toEqual({ name, forwards: false })
      expect({ name, adminPort: (service.ports ?? []).some((p) => p.endsWith(":8081")) }).toEqual({ name, adminPort: false })
    }
  })

  test("the gate is split: gate-box forwards only to the box, gate-admin only to inbox-admin and is not on `sealed`", () => {
    expect(services.gate).toBeUndefined()
    expect(services["gate-box"]!.command).toEqual(["TCP-LISTEN:4096,fork,reuseaddr", "TCP:box:4096"])
    expect(networksOf(services["gate-box"]!)).toEqual(["sealed", "outside"])
    expect(services["gate-box"]!.ports).toEqual(["127.0.0.1:${OCD_PORT}:4096"])
    expect(services["gate-admin"]!.command).toEqual(["TCP-LISTEN:8081,fork,reuseaddr", "TCP:inbox-admin:8081"])
    expect(networksOf(services["gate-admin"]!)).toEqual(["admin", "outside"])
    expect(services["gate-admin"]!.ports).toEqual(["127.0.0.1:${OCD_INBOX_PORT}:8081"])
  })

  test("only the inbox, the delegation gate and their admin gates are on `admin`", () => {
    const onAdmin = Object.entries(services).filter(([, s]) => networksOf(s).includes("admin")).map(([name]) => name)
    expect(onAdmin.sort()).toEqual(["gate-admin", "gate-mcp-admin", "inbox", "mcp-gate"])
  })

  test("#104: the box is not on `gatenet` or `admin`, so it cannot reach the delegation gate or skip it", () => {
    expect(networksOf(services.box!)).toEqual(["sealed"])
    const onGatenet = Object.entries(services).filter(([, s]) => networksOf(s).includes("gatenet")).map(([name]) => name)
    expect(onGatenet.sort()).toEqual(["front", "mcp-gate"])
    // The gate's admin token and profile are named on the gate only, never on the box.
    expect(Object.keys(services["mcp-gate"]!.environment ?? {})).toContain("GATE_ADMIN_TOKEN")
    expect(Object.keys(services.box!.environment ?? {}).filter((name) => name.startsWith("GATE_"))).toEqual([])
  })
})

describe("R3-01: the box's only way out is `front`", () => {
  const hosts = defaultConfig({}).egressHosts

  test("no CONNECT proxy: no egress service, no proxy variable in the box env", () => {
    expect(services.egress).toBeUndefined()
    expect(Object.keys(services.box!.environment ?? {}).filter((name) => /proxy/i.test(name))).toEqual([])
    expect(SIBLING_SERVICES).toContain("front")
    expect(SIBLING_SERVICES as readonly string[]).not.toContain("egress")
  })

  test("front's `sealed` aliases are exactly config.egressHosts, and it is on `sealed` + `gatenet` + `outside`", () => {
    const networks = services.front!.networks as Record<string, { aliases?: string[] } | null>
    expect(Object.keys(networks)).toEqual(["sealed", "gatenet", "outside"])
    expect(networks.sealed?.aliases).toEqual(hosts)
  })

  test("front is hardened like the others and binds 443 through the namespaced sysctl, not a capability", () => {
    const front = services.front!
    expect(front.cap_drop).toEqual(["ALL"])
    expect(front.read_only).toBe(true)
    expect(front.sysctls).toEqual({ "net.ipv4.ip_unprivileged_port_start": "0" })
    expect(front.ports).toBeUndefined()
  })

  test("the CA key volume is mounted in front only; the box mounts the public volume read-only and trusts it", () => {
    const mounts = Object.entries(services).flatMap(([name, s]) => (s.volumes ?? []).map((v) => ({ name, v })))
    expect(mounts.filter((m) => m.v.startsWith("front-ca-private:")).map((m) => m.name)).toEqual(["front"])
    expect(services.box!.volumes).toContain("front-ca-public:/etc/ocd-front-ca:ro")
    expect(services.front!.volumes).toContain("front-ca-public:/ca/public")
    expect(services.box!.environment?.NODE_EXTRA_CA_CERTS).toBe("/etc/ocd-front-ca/ca.pem")
  })

  test("the box waits for a healthy front (Bun reads NODE_EXTRA_CA_CERTS once, at start)", () => {
    expect(services.box!.depends_on).toMatchObject({ front: { condition: "service_healthy" } })
  })
})
