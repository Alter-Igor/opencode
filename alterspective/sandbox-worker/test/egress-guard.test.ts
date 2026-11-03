import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "fs/promises"
import net from "net"
import { tmpdir } from "os"
import path from "path"
import { writeLockdownMarker } from "../egress/lockdown"
import { checkEgress, checkLockdownMarker } from "../supervisor/egress-guard"
import { buildDockerRunArgs, CONTAINER_BOOT_CMD } from "../driver/run-task"

describe("egress lockdown marker & fail-closed guard (#123)", () => {
  let server: net.Server | undefined
  afterAll(() => server?.close())

  test("writeLockdownMarker writes a valid marker that checkLockdownMarker accepts", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbxw-marker-"))
    try {
      const markerPath = path.join(dir, "sbxw-egress.locked")
      await writeLockdownMarker(["203.0.113.10:443", "198.51.100.0/24:8443"], markerPath)
      const result = await checkLockdownMarker(markerPath)
      expect(result.ok).toBe(true)
      expect(result.detail).toContain("locked at")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("checkLockdownMarker fails closed with EGRESS_CHECK_FAILED when marker is missing or invalid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbxw-marker-bad-"))
    try {
      const missingPath = path.join(dir, "missing.locked")
      const missing = await checkLockdownMarker(missingPath)
      expect(missing.ok).toBe(false)
      expect(missing.detail).toContain("EGRESS_CHECK_FAILED")

      const badJsonPath = path.join(dir, "bad-json.locked")
      await writeFile(badJsonPath, "{not-json")
      const badJson = await checkLockdownMarker(badJsonPath)
      expect(badJson.ok).toBe(false)
      expect(badJson.detail).toContain("EGRESS_CHECK_FAILED")

      const badShapePath = path.join(dir, "bad-shape.locked")
      await writeFile(badShapePath, JSON.stringify({ lockedAt: "not-a-date", allowHosts: "bad" }))
      const badShape = await checkLockdownMarker(badShapePath)
      expect(badShape.ok).toBe(false)
      expect(badShape.detail).toContain("EGRESS_CHECK_FAILED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("checkEgress fails closed when lockdown marker is required and missing, even if metadata is unreachable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbxw-egress-"))
    try {
      const probe = net.createServer()
      await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
      const closedPort = (probe.address() as net.AddressInfo).port
      await new Promise<void>((resolve) => probe.close(() => resolve()))

      const missingMarker = path.join(dir, "missing.locked")
      const failed = await checkEgress({
        target: { host: "127.0.0.1", port: closedPort },
        markerPath: missingMarker,
        requireLockdown: true,
      })
      expect(failed.ok).toBe(false)
      expect(failed.detail).toContain("EGRESS_CHECK_FAILED")

      const validMarker = path.join(dir, "valid.locked")
      await writeLockdownMarker(["203.0.113.10:443"], validMarker)
      const passed = await checkEgress({
        target: { host: "127.0.0.1", port: closedPort },
        markerPath: validMarker,
        requireLockdown: true,
      })
      expect(passed.ok).toBe(true)

      const skipped = await checkEgress({
        target: { host: "127.0.0.1", port: closedPort },
        markerPath: missingMarker,
        requireLockdown: false,
      })
      expect(skipped.ok).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("checkEgress fails closed with EGRESS_CHECK_FAILED when metadata accepts a connection despite valid marker", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sbxw-egress-open-"))
    try {
      server = net.createServer((s) => s.end())
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve))
      const openPort = (server.address() as net.AddressInfo).port

      const validMarker = path.join(dir, "valid.locked")
      await writeLockdownMarker(["203.0.113.10:443"], validMarker)

      const result = await checkEgress({
        target: { host: "127.0.0.1", port: openPort },
        markerPath: validMarker,
        requireLockdown: true,
      })
      expect(result.ok).toBe(false)
      expect(result.detail).toContain("EGRESS_CHECK_FAILED")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("buildDockerRunArgs adds --cap-add NET_ADMIN and runs lockdown.ts as root before dropping to agent", () => {
    const args = buildDockerRunArgs({
      taskId: "sbxw-123",
      port: 47201,
      runDir: "/tmp/sbxw-123",
      image: "opencodealt-sandbox-worker:spike",
    })
    expect(args).toContain("--cap-add")
    expect(args).toContain("NET_ADMIN")
    expect(args).toContain("--user")
    expect(args).toContain("0:0")
    expect(args).toContain(CONTAINER_BOOT_CMD)
    expect(CONTAINER_BOOT_CMD).toContain("bun /opt/sbxw/egress/lockdown.ts")
    expect(CONTAINER_BOOT_CMD).toContain("exec runuser -u agent -- bun /opt/sbxw/supervisor/main.ts")
  })
})
