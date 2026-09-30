// T2.3 — static checks on the read-only registry caches (review N3). The live proof (install
// works, publish refused) is in the Wave 1 report; these keep the config from drifting open.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const CACHES = path.join(import.meta.dir, "..", "docker", "caches")
const read = (...parts: string[]) => readFileSync(path.join(CACHES, ...parts), "utf8")

type PackageRule = { access?: string; publish?: string; unpublish?: string; proxy?: string }
type Verdaccio = {
  web?: { enable?: boolean }
  auth?: { htpasswd?: { file?: string; max_users?: number } }
  uplinks?: Record<string, { url?: string }>
  packages?: Record<string, PackageRule>
  middlewares?: { audit?: { enabled?: boolean } }
}

// Groups a request can hold without an account (or that every account holds).
const OPEN_GROUPS = ["$all", "$anonymous", "@all", "@anonymous", "$authenticated", "@authenticated"]

describe("npm-cache (verdaccio)", () => {
  const config = Bun.YAML.parse(read("npm", "config.yaml")) as Verdaccio

  test("registration disabled and credentials file baked read-only", () => {
    expect(config.auth?.htpasswd?.max_users).toBe(-1)
    expect(config.auth?.htpasswd?.file).toBe("/verdaccio/conf/htpasswd")
    const dockerfile = read("npm", "Dockerfile")
    expect(dockerfile).toContain(": > /verdaccio/conf/htpasswd")
    expect(dockerfile).toMatch(/chmod 0444 \/verdaccio\/conf\/htpasswd/)
  })

  test("every package rule: read for all, write for no reachable group, proxied to npmjs only", () => {
    const rules = Object.values(config.packages ?? {})
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      expect(rule.access).toBe("$all")
      expect(OPEN_GROUPS).not.toContain(rule.publish)
      expect(OPEN_GROUPS).not.toContain(rule.unpublish)
      expect(rule.publish).toBeDefined()
      expect(rule.unpublish).toBeDefined()
      expect(rule.proxy).toBe("npmjs")
    }
    expect(config.uplinks).toEqual({ npmjs: expect.objectContaining({ url: "https://registry.npmjs.org/" }) })
  })

  test("web UI and audit passthrough are off", () => {
    expect(config.web?.enable).toBe(false)
    expect(config.middlewares?.audit?.enabled).toBe(false)
  })

  test("base image pinned by version and digest", () => {
    expect(read("npm", "Dockerfile")).toMatch(/^FROM verdaccio\/verdaccio:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/m)
  })
})

describe("pypi-cache (nginx)", () => {
  // Directives only: comments may mention hosts and words the checks look for.
  const conf = read("pypi", "nginx.conf")
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
  const locations = [...conf.matchAll(/^\s*location\s+([^{]+)\{([\s\S]*?)\n    \}/gm)]

  test("every proxied location is GET/HEAD only and strips credentials", () => {
    const proxied = locations.filter(([, , body]) => body?.includes("proxy_pass"))
    expect(proxied.map(([, where]) => where?.trim())).toEqual(["/index/", "/packages/"])
    for (const [, , body] of proxied) {
      expect(body).toContain("limit_except GET { deny all; }")
      expect(body).toContain('proxy_set_header Authorization "";')
      expect(body).toContain('proxy_set_header Accept-Encoding "";')
    }
  })

  test("only the read hosts are proxied, TLS verified; the upload host never is", () => {
    const upstreams = [...conf.matchAll(/proxy_pass\s+(\S+);/g)].map((m) => m[1])
    expect(upstreams).toEqual(["https://pypi.org/simple/", "https://files.pythonhosted.org/packages/"])
    expect(conf).not.toContain("upload.pypi.org")
    expect(conf).toContain("proxy_ssl_verify on;")
  })

  test("base image pinned by version and digest", () => {
    expect(read("pypi", "Dockerfile")).toMatch(/^FROM nginxinc\/nginx-unprivileged:[\d.]+-alpine@sha256:[0-9a-f]{64}$/m)
  })
})
