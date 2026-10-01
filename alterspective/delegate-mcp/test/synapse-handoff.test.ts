// WS2 (#48, review L2): the host callback listener for the Synapse sign-in. Real loopback HTTP on a
// free port; the "browser" is a fetch the opener makes.
import { describe, expect, test } from "bun:test"
import { DelegateError } from "../src/shared/errors.ts"
import { freePort } from "../src/supervisor/docker.ts"
import { catchHandoff } from "../src/synapse/handoff-login.ts"
import { jwt } from "./synapse-fixture.ts"

const ORIGIN = "https://identity.alterspective.com.au"

/** Runs catchHandoff; `browse(nonce, base)` plays the browser and returns the HTTP statuses it saw. */
async function attempt(browse: (nonce: string, base: string) => Promise<number[]>, timeoutMs = 3_000) {
  const port = await freePort()
  let statuses: Promise<number[]> = Promise.resolve([])
  const result = catchHandoff({
    origin: ORIGIN,
    port,
    timeoutMs,
    opener: (url) => {
      const nonce = new URL(url).searchParams.get("nonce") ?? ""
      statuses = browse(nonce, `http://127.0.0.1:${port}/auth/callback`)
    },
  }).then((value) => ({ value }), (error: unknown) => ({ error }))
  return { outcome: await result, statuses: await statuses }
}

const hit = async (url: string) => (await fetch(url)).status

describe("Synapse sign-in callback", () => {
  test("the matching handoff is accepted", async () => {
    const r = await attempt(async (nonce, base) => {
      const token = jwt({ nonce, sub: "x" })
      return [await hit(`${base}?handoff=${token}`)]
    })
    expect(r.statuses).toEqual([200])
    expect("value" in r.outcome && typeof r.outcome.value === "string").toBe(true)
  })

  test("a handoff with another nonce is refused and the attempt goes on (then the right one wins)", async () => {
    const r = await attempt(async (nonce, base) => [await hit(`${base}?handoff=${jwt({ nonce: "other" })}`), await hit(`${base}?handoff=${jwt({ nonce })}`)])
    expect(r.statuses).toEqual([400, 200])
    expect("value" in r.outcome).toBe(true)
  })

  test("an ?error= without this attempt's nonce cannot cancel the sign-in", async () => {
    const r = await attempt(async (nonce, base) => [await hit(`${base}?error=access_denied`), await hit(`${base}?error=access_denied&nonce=wrong`), await hit(`${base}?handoff=${jwt({ nonce })}`)])
    expect(r.statuses).toEqual([400, 400, 200])
    expect("value" in r.outcome).toBe(true)
  })

  test("an ?error= carrying this attempt's nonce (or state) ends it with needs_auth", async () => {
    for (const key of ["nonce", "state"]) {
      const r = await attempt(async (nonce, base) => [await hit(`${base}?error=access_denied&${key}=${nonce}`)])
      expect(r.statuses).toEqual([200])
      expect("error" in r.outcome && (r.outcome.error as DelegateError).code).toBe("needs_auth")
    }
  })

  test("no answer in time: needs_auth", async () => {
    const r = await attempt(async () => [], 300)
    expect("error" in r.outcome && (r.outcome.error as DelegateError).code).toBe("needs_auth")
  })
})
