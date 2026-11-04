import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  OPENCODEALT_LATEST_RELEASE_URL,
  OPENCODEALT_RELEASES_URL,
  isNewerOpencodealt,
  isOpencodealt,
  latestOpencodealt,
  newestOpencodealtVersion,
  opencodealtVersion,
  readOpencodealtChannel,
} from "../../src/installation/opencodealt"
import { sourceVersion } from "../../src/installation/version"

describe("installation (opencodealt #90, #97)", () => {
  test("isOpencodealt identifies opencodealt channel", () => {
    expect(isOpencodealt("opencodealt")).toBe(true)
    expect(isOpencodealt("latest")).toBe(false)
  })

  test("a stable install checks the Latest release endpoint", async () => {
    const before = process.env["OPENCODEALT_RELEASE_CHANNEL"]
    process.env["OPENCODEALT_RELEASE_CHANNEL"] = "stable"
    const previousFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        calls.push(url)
        return new Response(JSON.stringify({ tag_name: "opencodealt-v1.18.31-alt.7" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      },
      { preconnect: previousFetch.preconnect },
    )
    try {
      const result = await latestOpencodealt("1.18.31-alt.6")
      expect(result).toBe("1.18.31-alt.7")
      expect(calls).toEqual([OPENCODEALT_LATEST_RELEASE_URL])
    } finally {
      globalThis.fetch = previousFetch
      if (before === undefined) delete process.env["OPENCODEALT_RELEASE_CHANNEL"]
      else process.env["OPENCODEALT_RELEASE_CHANNEL"] = before
    }
  })

  test("an edge install looks at every release and picks the highest version", async () => {
    const before = process.env["OPENCODEALT_RELEASE_CHANNEL"]
    process.env["OPENCODEALT_RELEASE_CHANNEL"] = "edge"
    const previousFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        calls.push(url)
        return new Response(
          JSON.stringify([
            { tag_name: "opencodealt-v1.18.31-alt.9", draft: false },
            { tag_name: "opencodealt-v1.18.31-alt.11", draft: true },
            { tag_name: "opencodealt-v1.18.31-alt.10", draft: false },
            { tag_name: "v2.0.0", draft: false },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      },
      { preconnect: previousFetch.preconnect },
    )
    try {
      const result = await latestOpencodealt("1.18.31-alt.8")
      expect(result).toBe("1.18.31-alt.10")
      expect(calls).toEqual([OPENCODEALT_RELEASES_URL])
    } finally {
      globalThis.fetch = previousFetch
      if (before === undefined) delete process.env["OPENCODEALT_RELEASE_CHANNEL"]
      else process.env["OPENCODEALT_RELEASE_CHANNEL"] = before
    }
  })

  test("reads the channel AI Office wrote next to bin, defaulting to stable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "oca-channel-"))
    const exe = path.join(root, "bin", "opencodealt.exe")
    expect(readOpencodealtChannel(exe, {})).toBe("stable")
    fs.writeFileSync(path.join(root, "channel"), "edge\n")
    expect(readOpencodealtChannel(exe, {})).toBe("edge")
    fs.writeFileSync(path.join(root, "channel"), "nightly")
    expect(readOpencodealtChannel(exe, {})).toBe("stable")
    expect(readOpencodealtChannel(exe, { OPENCODEALT_RELEASE_CHANNEL: "edge" })).toBe("edge")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("never treats an older stable as an update for a newer edge build", () => {
    expect(isNewerOpencodealt("1.18.31-alt.7", "1.18.31-alt.8")).toBe(false)
    expect(isNewerOpencodealt("1.18.31-alt.10", "1.18.31-alt.9")).toBe(true)
    expect(isNewerOpencodealt("1.18.32-alt.11", "1.18.31-alt.10")).toBe(true)
    expect(isNewerOpencodealt("1.18.31-alt.8", "1.18.31-alt.8")).toBe(false)
    expect(isNewerOpencodealt("1.18.31-alt.8", "1.18.31-alt [abc1234567]")).toBe(false)
    expect(newestOpencodealtVersion([])).toBeUndefined()
  })

  test("turns a release tag into a version and formats sourceVersion", () => {
    expect(opencodealtVersion("opencodealt-v1.18.31-alt.7")).toBe("1.18.31-alt.7")
    expect(opencodealtVersion("v2.0.0")).toBe("2.0.0")
    expect(sourceVersion()).toContain("-alt")
  })
})
