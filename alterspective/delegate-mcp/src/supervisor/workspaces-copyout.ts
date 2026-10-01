// MOD-01 workspaces: take the session bundle out of the box (review R3-08, issue G-7).
//
// The box has no writable host folder. It writes its bundle to /handoff/out, a box-only named volume
// (docker/compose.yaml), and the bridge streams it out with `docker cp <box>:<path> -`: a tar archive
// on stdout. The bridge, not Docker, writes the host file, so the box cannot choose what lands on the
// host or how much:
// 1. In the box: `stat` must say "regular file" within the size cap, or nothing is copied.
// 2. The stream: at most one small PAX header, then exactly one non-empty regular-file entry (a
//    link, folder, device or second entry is refused) declaring no more than the cap, then the two
//    zero end blocks and nothing but zeros. So a file the box swaps in after step 1 (bigger, a
//    folder, a link) can never put more than the cap on the host. True bounds: at most the cap is
//    written to the host; at most the cap + 71 KiB of tar framing (512 B header, one 4 KiB PAX
//    header with its own 512 B header, up to 511 B padding, 1 KiB end blocks, 64 KiB trailing
//    zeros) is consumed, plus at most one pipe chunk read ahead (64 KiB on the platforms tested).
//    A deadline covers the whole copy, whatever the source does.
// 3. On the host: the quarantine file (exclusive create in a host-only folder) must be a regular file
//    of exactly the streamed size, within the cap. Only then is it fetched (workspaces.ts).
// `docker cp` without -L copies a final-component link as a link (refused in step 2), and resolves
// the rest of the path inside the container's own root; /handoff/out is a mount point the box user
// cannot rename.
import { spawn } from "node:child_process"
import { closeSync, openSync, writeSync } from "node:fs"
import path from "node:path"
import { DelegateError, isDelegateError } from "../shared/errors.ts"
import { killTree } from "./spawn.ts"
import { boxFailure, cleanEnv, type Exec } from "./workspaces-exec.ts"
import { assertRegularFile, ensureRealDir, handoffFailure, refused, removeEntry, removeQuietly } from "./workspaces-handoff.ts"

/** Zero bytes allowed after the two end blocks (tar writers may pad to a record size). */
export const TAR_SLACK_BYTES = 64 * 1024
/** Docker writes at most one small PAX header (e.g. sub-second mtime, xattrs). */
export const PAX_MAX_BYTES = 4 * 1024
const BLOCK = 512
const MAX_PAX_HEADERS = 1
const CUT_OFF = "tar stream ended early"

export type TarExit = { code: number; stderr: string; timedOut: boolean }
export type TarStream = { chunks: AsyncIterable<Uint8Array>; exited: Promise<TarExit>; stop(): void }
/** Streams the box file at `boxPath` as a tar archive (default: `docker cp <box>:<path> -`). */
export type TarSource = (boxPath: string, timeoutMs: number) => TarStream
export type CopyOut = { boxPath: string; quarantinePath: string }

const tooLarge = (size: number | string, maxBytes: number) =>
  new DelegateError("bundle_too_large", `The session bundle is ${typeof size === "number" ? `${size} bytes` : size}, over the ${maxBytes}-byte limit; nothing was fetched.`, "Ask the delegate to drop large or generated files from its commits, then collect again.")
const notRegular = (detail: string) => refused("The session bundle is not a regular file; it was not used.", detail)
const badArchive = (detail: string) => refused("The session bundle did not come out of the box as one plain file; it was not used.", detail)
const empty = (detail: string) => refused("The box wrote an empty session bundle; it was not used.", detail)
const timedOutCopy = () => boxFailure("copy the session bundle out", "timed out", true)
const cutOff = () => new DelegateError("upstream_error", "The session bundle was cut off while it was copied out of the box.", "Collect again; if it repeats, run oc_doctor.", CUT_OFF)
const pad = (n: number) => (BLOCK - (n % BLOCK)) % BLOCK

/** Run one command and expose its stdout as a stream; the deadline kills the whole tree (spawn.ts). */
export function spawnStream(argv: readonly string[], timeoutMs: number): TarStream {
  const [file = "", ...args] = argv
  const child = spawn(file, args, { env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" })
  let stderr = ""
  let timedOut = false
  child.stderr.on("data", (data: Buffer) => {
    if (stderr.length < 4096) stderr += data.toString()
  })
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, timeoutMs)
  const exited = new Promise<TarExit>((resolve) => {
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve({ code: 127, stderr: String(error), timedOut })
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : (code ?? 128), stderr, timedOut })
    })
  })
  const stop = () => {
    child.stdout.destroy()
    if (child.exitCode === null && child.signalCode === null) killTree(child)
  }
  return { chunks: child.stdout, exited, stop }
}

export const dockerTarSource =
  (container: string): TarSource =>
  (boxPath, timeoutMs) =>
    spawnStream(["docker", "cp", `${container}:${boxPath}`, "-"], timeoutMs)

/** Pull exact byte counts from a chunk stream; nothing is read ahead of what is asked for. */
function pullReader(chunks: AsyncIterable<Uint8Array>) {
  const it = chunks[Symbol.asyncIterator]()
  let buf: Buffer = Buffer.alloc(0)
  const fill = async (n: number) => {
    while (buf.length < n) {
      const next = await it.next().catch((error: unknown) => {
        throw new DelegateError("upstream_error", "Reading the session bundle from the box failed.", "Collect again; if it repeats, run oc_doctor.", String(error).slice(0, 300))
      })
      if (next.done) return false
      const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    }
    return true
  }
  return {
    async read(n: number): Promise<Buffer | undefined> {
      if (!(await fill(n))) return undefined
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      return out
    },
    /** Hand `n` bytes to `write` as they arrive; false when the stream ends first. */
    async pipe(n: number, write: (part: Buffer) => void): Promise<boolean> {
      for (let left = n; left > 0; ) {
        if (buf.length === 0 && !(await fill(1))) return false
        const part = buf.subarray(0, Math.min(left, buf.length))
        write(part)
        buf = buf.subarray(part.length)
        left -= part.length
      }
      return true
    },
    /** Read to the end: "ok" when at most `limit` bytes are left and all are zero. */
    async drain(limit: number): Promise<"ok" | "too many" | "not zero"> {
      for (let seen = buf.length; seen <= limit; ) {
        if (!buf.every((b) => b === 0)) return "not zero"
        buf = Buffer.alloc(0)
        if (!(await fill(1))) return "ok"
        seen += buf.length
      }
      return "too many"
    },
  }
}
type Reader = ReturnType<typeof pullReader>

/** A ustar header: its type and size; undefined for an end-of-archive (all-zero) block. */
function parseHeader(block: Buffer): { type: string; size: number | "8 GiB or more" } | undefined {
  if (block.every((b) => b === 0)) return undefined
  const octal = (from: number, to: number) => {
    const t = block.subarray(from, to).toString("latin1").replace(/[\0 ]+$/, "").trim()
    return /^[0-7]+$/.test(t) ? parseInt(t, 8) : NaN
  }
  const sum = block.reduce((acc, b, i) => acc + (i >= 148 && i < 156 ? 0x20 : b), 0)
  if (octal(148, 156) !== sum) throw badArchive("tar header checksum")
  const type = String.fromCharCode(block[156] || 0x30)
  // Base-256 size (high bit set): only for 8 GiB or more; 0xff first means a negative size.
  if (block[124] === 0xff) throw badArchive("negative tar size")
  if (((block[124] ?? 0) & 0x80) !== 0) return { type, size: "8 GiB or more" }
  const size = octal(124, 136)
  if (!Number.isFinite(size)) throw badArchive("tar header size")
  return { type, size }
}

/** Skip PAX headers, then copy the one regular-file entry to `write`. Returns its size. */
async function streamEntry(reader: Reader, maxBytes: number, write: (part: Buffer) => void): Promise<number> {
  for (let pax = 0; ; pax++) {
    const block = await reader.read(BLOCK)
    if (!block) throw cutOff()
    const header = parseHeader(block)
    if (!header) throw badArchive("empty archive")
    if (header.type === "x" || header.type === "g") {
      if (pax >= MAX_PAX_HEADERS || typeof header.size !== "number" || header.size > PAX_MAX_BYTES) throw badArchive("PAX headers")
      const records = await reader.read(header.size + pad(header.size))
      if (!records) throw cutOff()
      // A size record would let the entry claim a size its header does not show (we never need one).
      if (/^\d+ size=/m.test(records.subarray(0, header.size).toString("latin1"))) throw badArchive("PAX size record")
      continue
    }
    if (header.type !== "0") throw notRegular(`tar entry type ${header.type}`)
    if (typeof header.size !== "number" || header.size > maxBytes) throw tooLarge(header.size, maxBytes)
    if (header.size === 0) throw empty("tar entry of 0 bytes")
    if (!(await reader.pipe(header.size, write))) throw cutOff()
    if (!(await reader.read(pad(header.size)))) throw cutOff()
    return header.size
  }
}

/** After the file: exactly two zero end blocks, then only zeros, no more than the slack. */
async function expectEnd(reader: Reader): Promise<void> {
  for (const which of ["first", "second"]) {
    const block = await reader.read(BLOCK)
    if (!block) throw badArchive(`no ${which} end block`)
    if (!block.every((b) => b === 0)) throw badArchive(which === "first" ? "a second tar entry" : "an entry after one end block")
  }
  const rest = await reader.drain(TAR_SLACK_BYTES)
  if (rest !== "ok") throw badArchive(rest === "too many" ? "too many bytes after the archive end" : "non-zero bytes after the archive end")
}

function writeAll(fd: number, part: Buffer, hostPath: string): void {
  try {
    for (let done = 0; done < part.length; ) done += writeSync(fd, part, done, part.length - done)
  } catch (error) {
    throw handoffFailure("write the quarantined bundle", error, hostPath)
  }
}

/** The copy under one deadline: a source that never ends is stopped and reported as a timeout. */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, stop: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop()
      reject(timedOutCopy())
    }, timeoutMs)
  })
  work.catch(() => undefined) // a rejection after the deadline won is not unhandled
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the stream into the open host file; a cut-off stream reports the docker cp failure if there was one. */
async function parseInto(stream: TarStream, write: (part: Buffer) => void, maxBytes: number): Promise<number> {
  try {
    const reader = pullReader(stream.chunks)
    const size = await streamEntry(reader, maxBytes, write)
    await expectEnd(reader)
    const exit = await stream.exited
    if (exit.code !== 0) throw boxFailure("copy the session bundle out", exit.stderr, exit.timedOut)
    return size
  } catch (error) {
    if (!isDelegateError(error) || error.detail !== CUT_OFF) throw error
    const exit = await stream.exited
    throw exit.code === 0 ? error : boxFailure("copy the session bundle out", exit.stderr, exit.timedOut)
  }
}

/** Stream the box file into a fresh host file (exclusive create), within `timeoutMs`. */
async function streamToHost(source: TarSource, bundle: CopyOut, maxBytes: number, timeoutMs: number): Promise<number> {
  let fd: number
  try {
    fd = openSync(bundle.quarantinePath, "wx")
  } catch (error) {
    throw handoffFailure("create the quarantined bundle", error, bundle.quarantinePath)
  }
  let closed = false
  const write = (part: Buffer) => {
    if (closed) throw timedOutCopy() // the deadline closed the file; never write to a reused fd
    writeAll(fd, part, bundle.quarantinePath)
  }
  const stream = source(bundle.boxPath, timeoutMs)
  try {
    return await withDeadline(parseInto(stream, write, maxBytes), timeoutMs, () => stream.stop())
  } finally {
    stream.stop()
    closed = true
    closeSync(fd)
  }
}

/** Step 1: the box's own view of the file. `stat` without -L reports a link as a link. */
async function checkInBox(box: Exec, boxPath: string, maxBytes: number, timeoutMs: number): Promise<void> {
  const result = await box(["stat", "-c", "%F|%s", "--", boxPath], { timeoutMs })
  if (result.code !== 0) {
    if (/no such file/i.test(result.stderr)) throw new DelegateError("upstream_error", "The box did not write the session bundle.", "Collect again; if it repeats, run oc_doctor.", boxPath)
    throw boxFailure("check the session bundle", result.stderr, result.timedOut)
  }
  const match = /^([a-z ]+)\|(\d+)$/.exec(result.stdout.trim())
  if (match?.[1] === "regular empty file") throw empty(boxPath)
  if (!match?.[1]?.startsWith("regular")) throw notRegular(`${match?.[1] ?? "unknown"} ${boxPath}`)
  if (Number(match[2]) > maxBytes) throw tooLarge(Number(match[2]), maxBytes)
}

/** Step 3: the host file must be a regular file of exactly the streamed size, within the cap. */
export function recheckQuarantined(hostPath: string, expected: number, maxBytes: number): void {
  const stat = assertRegularFile(hostPath, "session bundle")
  if (stat.size > maxBytes) throw tooLarge(stat.size, maxBytes)
  if (stat.size !== expected) throw refused("The session bundle changed size on the host after the copy; it was not used.", `${stat.size} != ${expected}`)
}

/** Copy the box's bundle into the host-only quarantine path, checked three times. Returns that path. */
export async function copyOutBundle(box: Exec, source: TarSource, bundle: CopyOut, maxBytes: number, timeoutMs: number): Promise<string> {
  await checkInBox(box, bundle.boxPath, maxBytes, timeoutMs)
  ensureRealDir(path.dirname(bundle.quarantinePath))
  removeEntry(bundle.quarantinePath)
  try {
    recheckQuarantined(bundle.quarantinePath, await streamToHost(source, bundle, maxBytes, timeoutMs), maxBytes)
  } catch (error) {
    removeQuietly(bundle.quarantinePath)
    throw error
  }
  return bundle.quarantinePath
}
