import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { FALLBACK_MODEL, parseResolveBody } from "../supervisor/policy"

const good = {
  cell: { modelIds: ["qwen3.8-flash", "qwen3.8-27b-dflash2"], residency: "local-only", privacyTier: "local-only" },
  effectivePolicyVersion: "v7",
}

describe("parseResolveBody: the resolve answer passed in the manifest (#102)", () => {
  test("a good answer gives the models and version from the policy", () => {
    expect(parseResolveBody(good)).toEqual({
      source: "cas",
      modelIds: ["qwen3.8-flash", "qwen3.8-27b-dflash2"],
      effectivePolicyVersion: "v7",
      residency: "local-only",
      privacyTier: "local-only",
    })
  })

  test("no model policy in the manifest fails closed to auto", () => {
    for (const missing of [undefined, null]) {
      expect(parseResolveBody(missing)).toEqual({
        source: "fallback",
        modelIds: [FALLBACK_MODEL],
        reason: "no model policy in the manifest",
      })
    }
  })

  test("no role pin (empty or missing modelIds) means Synapse routing, still from CAS", () => {
    expect(parseResolveBody({ cell: { modelIds: [] }, effectivePolicyVersion: 3 })).toEqual({
      source: "cas",
      modelIds: ["auto"],
      effectivePolicyVersion: "3",
    })
    expect(parseResolveBody({ cell: {}, effectivePolicyVersion: "v1" })).toMatchObject({ source: "cas", modelIds: ["auto"] })
  })

  test("the cell fields at the top level are accepted", () => {
    expect(parseResolveBody({ modelIds: ["m1"], effectivePolicyVersion: "v2" })).toMatchObject({ source: "cas", modelIds: ["m1"] })
  })

  test("model ids are trimmed", () => {
    expect(parseResolveBody({ cell: { modelIds: [" m1 "] }, effectivePolicyVersion: "v" })).toMatchObject({ modelIds: ["m1"] })
  })

  const bad: [string, unknown][] = [
    ["a string", "v1"],
    ["a number", 7],
    ["no version", { cell: { modelIds: ["m1"] } }],
    ["a blank version", { cell: { modelIds: ["m1"] }, effectivePolicyVersion: " " }],
    ["a cell that is not an object", { cell: "x", effectivePolicyVersion: "v" }],
    ["modelIds not an array", { cell: { modelIds: "m1" }, effectivePolicyVersion: "v" }],
    ["a blank model id", { cell: { modelIds: ["m1", " "] }, effectivePolicyVersion: "v" }],
    ["a model id with a space", { cell: { modelIds: ["m 1"] }, effectivePolicyVersion: "v" }],
    ["a non-string model id", { cell: { modelIds: [1] }, effectivePolicyVersion: "v" }],
    ["too many model ids", { cell: { modelIds: Array.from({ length: 21 }, (_, i) => `m${i}`) }, effectivePolicyVersion: "v" }],
  ]
  for (const [name, body] of bad) {
    test(`${name} fails closed to auto`, () => {
      expect(parseResolveBody(body)).toMatchObject({ source: "fallback", modelIds: ["auto"] })
    })
  }
})

describe("the sandbox holds no CAS credential (#102, ADR-037 decision 1)", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", rel), "utf8")

  test("the supervisor makes no network call for the policy", () => {
    for (const file of ["supervisor/policy.ts", "supervisor/main.ts"]) expect(read(file)).not.toMatch(/\bfetch\(/)
  })

  test("no policy token is read or passed into the box", () => {
    for (const file of ["supervisor/main.ts", "driver/run-task.ts"]) expect(read(file)).not.toContain("POLICY_TOKEN")
  })
})
