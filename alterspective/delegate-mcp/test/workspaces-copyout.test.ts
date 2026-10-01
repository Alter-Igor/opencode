// G-7 / R3-08: the session bundle leaves the box by `docker cp <box>:<path> -` (a tar stream), never
// through a writable host folder. The bridge parses the stream itself, so it refuses anything but one
// regular file and never writes more than the cap to the host, even when the box swaps the file
// after the in-box check. Synthetic tar streams here; a real tar writer at the end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { DelegateError } from "../src/shared/errors.ts"
import { copyOutBundle, recheckQuarantined, spawnStream, TAR_SLACK_BYTES, type TarSource } from "../src/supervisor/workspaces-copyout.ts"
import type { Exec } from "../src/supervisor/workspaces-exec.ts"

let tmp = ""
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "ocd-copyout-"))
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const BLOCK = 512
const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK

/** One ustar header block with a valid checksum. */
function header(name: string, type: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  h.write(name, 0, "latin1")
  h.write("0000644\0", 100, "latin1")
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1")
  h.write(type, 156, "latin1")
  h.write("ustar\u000000", 257, "latin1")
  h.fill(0x20, 148, 156)
  const sum = h.reduce((a, b) => a + b, 0)
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1")
  return h
}
const entry = (name: string, type: string, data: Buffer) => Buffer.concat([header(name, type, data.length), data, Buffer.alloc(pad(data.length))])
const END = Buffer.alloc(BLOCK * 2)

type Fake = { source: TarSource; calls: number; pulled: number; stopped: boolean }
/** A tar source that yields `parts` (a generator may be endless) and counts what was pulled. */
function fakeSource(parts: () => Iterable<Buffer>, exit = { code: 0, stderr: "", timedOut: false }): Fake {
  const fake: Fake = { calls: 0, pulled: 0, stopped: false, source: undefined as unknown as TarSource }
  fake.source = () => {
    fake.calls++
    async function* chunks() {
      for (const part of parts()) {
        fake.pulled += part.length
        yield part
      }
    }
    return { chunks: chunks(), exited: Promise.resolve(exit), stop: () => void (fake.stopped = true) }
  }
  return fake
}

/** A box whose `stat -c '%F|%s'` answers `answer`. */
const statBox = (answer: { code: number; stdout: string; stderr?: string }): Exec => async (argv) =>
  argv[0] === "stat" ? { code: answer.code, stdout: answer.stdout, stderr: answer.stderr ?? "" } : { code: 0, stdout: "", stderr: "" }

const bundle = (name: string) => ({ boxPath: `/handoff/out/${name}`, quarantinePath: path.join(tmp, "incoming", name) })
const fail = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as DelegateError

describe("G-7: checked in the box before anything is copied", () => {
  test("a bundle over the cap is bundle_too_large and the copy never starts", async () => {
    const fake = fakeSource(() => [entry("a", "0", Buffer.alloc(10)), END])
    const b = bundle("over.bundle")
    const error = await fail(copyOutBundle(statBox({ code: 0, stdout: "regular file|2000\n" }), fake.source, b, 1_000, 5_000))
    expect(error.code).toBe("bundle_too_large")
    expect(fake.calls).toBe(0)
    expect(existsSync(b.quarantinePath)).toBe(false)
  })

  test("a link, folder or other non-regular entry is policy_violation and the copy never starts", async () => {
    for (const kind of ["symbolic link", "directory", "fifo"]) {
      const fake = fakeSource(() => [END])
      const error = await fail(copyOutBundle(statBox({ code: 0, stdout: `${kind}|10\n` }), fake.source, bundle("odd.bundle"), 1_000, 5_000))
      expect({ kind, code: error.code, calls: fake.calls }).toEqual({ kind, code: "policy_violation", calls: 0 })
    }
  })

  test("a missing bundle says the box wrote nothing; a stopped box is sandbox_unavailable", async () => {
    const fake = fakeSource(() => [END])
    const missing = await fail(copyOutBundle(statBox({ code: 1, stdout: "", stderr: "stat: cannot statx 'x': No such file or directory" }), fake.source, bundle("gone.bundle"), 1_000, 5_000))
    expect(missing.code).toBe("upstream_error")
    const down = await fail(copyOutBundle(statBox({ code: 1, stdout: "", stderr: "Error response from daemon: container x is not running" }), fake.source, bundle("down.bundle"), 1_000, 5_000))
    expect(down.code).toBe("sandbox_unavailable")
    expect(fake.calls).toBe(0)
  })
})

describe("G-7: the stream is checked again, so a swap after the in-box check gains nothing", () => {
  const okStat = statBox({ code: 0, stdout: "regular file|100\n" })

  test("an entry that became a link or a folder is refused and nothing reaches the host", async () => {
    for (const type of ["2", "5", "1", "6"]) {
      const fake = fakeSource(() => [header("x", type, 0), END])
      const b = bundle(`swap-${type}.bundle`)
      const error = await fail(copyOutBundle(okStat, fake.source, b, 1_000, 5_000))
      expect({ type, code: error.code, onHost: existsSync(b.quarantinePath), stopped: fake.stopped }).toEqual({ type, code: "policy_violation", onHost: false, stopped: true })
    }
  })

  test("an entry that grew past the cap is bundle_too_large before a byte is written", async () => {
    const fake = fakeSource(function* () {
      yield header("x", "0", 5_000)
      for (;;) yield Buffer.alloc(BLOCK, 1)
    })
    const b = bundle("grown.bundle")
    expect((await fail(copyOutBundle(okStat, fake.source, b, 1_000, 5_000))).code).toBe("bundle_too_large")
    expect(existsSync(b.quarantinePath)).toBe(false)
    expect(fake.pulled).toBeLessThanOrEqual(BLOCK * 2)
  })

  test("a second entry, or endless bytes after the file, is refused and reading stops near the cap", async () => {
    const second = fakeSource(() => [entry("x", "0", Buffer.alloc(100, 7)), entry("y", "0", Buffer.alloc(100, 8)), END])
    expect((await fail(copyOutBundle(okStat, second.source, bundle("two.bundle"), 1_000, 5_000))).code).toBe("policy_violation")
    const endless = fakeSource(function* () {
      yield entry("x", "0", Buffer.alloc(100, 7))
      for (;;) yield Buffer.alloc(BLOCK)
    })
    const b = bundle("endless.bundle")
    expect((await fail(copyOutBundle(okStat, endless.source, b, 1_000, 5_000))).code).toBe("policy_violation")
    expect(existsSync(b.quarantinePath)).toBe(false)
    expect(endless.pulled).toBeLessThanOrEqual(1_000 + TAR_SLACK_BYTES + BLOCK * 4)
  })

  test("a stream cut off mid-file is upstream_error and leaves no host file", async () => {
    const fake = fakeSource(() => [header("x", "0", 100), Buffer.alloc(40)])
    const b = bundle("cut.bundle")
    expect((await fail(copyOutBundle(okStat, fake.source, b, 1_000, 5_000))).code).toBe("upstream_error")
    expect(existsSync(b.quarantinePath)).toBe(false)
  })

  test("a failed or timed-out docker cp is reported, not taken as an empty bundle", async () => {
    const down = fakeSource(() => [], { code: 1, stderr: "Error response from daemon: No such container: x", timedOut: false })
    expect((await fail(copyOutBundle(okStat, down.source, bundle("nobox.bundle"), 1_000, 5_000))).code).toBe("sandbox_unavailable")
    const slow = fakeSource(() => [], { code: 124, stderr: "timed out", timedOut: true })
    const error = await fail(copyOutBundle(okStat, slow.source, bundle("slow.bundle"), 1_000, 5_000))
    expect([error.code, error.detail]).toEqual(["upstream_error", "timeout"])
  })

  test("PAX headers are skipped, but one that overrides the size is refused", async () => {
    // A PAX record is "<length> key=value\n", where the length counts its own digits too.
    const pax = (kv: string) => {
      let length = kv.length + 2
      while (`${length} ${kv}`.length !== length) length = `${length} ${kv}`.length
      return entry("PaxHeaders/x", "x", Buffer.from(`${length} ${kv}`))
    }
    const fine = fakeSource(() => [pax("mtime=1.5\n"), entry("x", "0", Buffer.alloc(100, 9)), END])
    const b = bundle("pax.bundle")
    expect(await copyOutBundle(okStat, fine.source, b, 1_000, 5_000)).toBe(b.quarantinePath)
    expect(readFileSync(b.quarantinePath)).toEqual(Buffer.alloc(100, 9))
    const sized = fakeSource(() => [pax("size=10\n"), entry("x", "0", Buffer.alloc(100, 9)), END])
    expect((await fail(copyOutBundle(okStat, sized.source, bundle("paxsize.bundle"), 1_000, 5_000))).code).toBe("policy_violation")
  })
})

describe("G-7: the host file is checked again after the copy", () => {
  test("recheckQuarantined refuses a file over the cap, of another size, or a link", () => {
    const dir = path.join(tmp, "recheck")
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "ok.bundle")
    writeFileSync(file, Buffer.alloc(100))
    expect(() => recheckQuarantined(file, 100, 1_000)).not.toThrow()
    const over = (() => {
      try {
        recheckQuarantined(file, 100, 50)
      } catch (e) {
        return (e as DelegateError).code
      }
    })()
    expect(over).toBe("bundle_too_large")
    const sizeMismatch = (() => {
      try {
        recheckQuarantined(file, 99, 1_000)
      } catch (e) {
        return (e as DelegateError).code
      }
    })()
    expect(sizeMismatch).toBe("policy_violation")
    const link = path.join(dir, "link.bundle")
    try {
      symlinkSync(file, link, "file")
    } catch {
      return // no symlink privilege on this Windows host; the stream check above covers links
    }
    expect(() => recheckQuarantined(link, 100, 1_000)).toThrow()
  })
})

describe("G-7: a real tar writer", () => {
  test("a regular file made by the system tar arrives byte for byte", async () => {
    const src = path.join(tmp, "real")
    mkdirSync(src, { recursive: true })
    const content = Buffer.from(Array.from({ length: 70_001 }, (_, i) => i % 251))
    writeFileSync(path.join(src, "real.bundle"), content)
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar"
    const source: TarSource = (_boxPath, timeoutMs) => spawnStream([tar, "-cf", "-", "-C", src, "real.bundle"], timeoutMs)
    const b = bundle("real.bundle")
    const okStat = statBox({ code: 0, stdout: `regular file|${content.length}\n` })
    expect(await copyOutBundle(okStat, source, b, 1_000_000, 30_000)).toBe(b.quarantinePath)
    expect(readFileSync(b.quarantinePath).equals(content)).toBe(true)
  })
})
