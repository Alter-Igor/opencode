import { spawn } from "child_process"
import fs from "fs/promises"
import { buffer } from "node:stream/consumers"
import path from "path"
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import { Global } from "@opencode-ai/core/global"
import { Shell } from "@opencode-ai/core/shell"
import { Filesystem } from "@/util/filesystem"

// Fork-only (#84, #243): `/goal` and the `goal_loop` tool keep a session or
// subagent working until a check command passes or a portable record reaches a
// terminal state. The plugin runs the check itself after each turn, so the
// model cannot declare the goal met on its own.

export const GOAL_COMMAND = "goal"
// `turnRetries`: a turn whose model reply failed (not a user abort) is retried this many times in a
// row before the loop pauses (svc-coding-agent#327: one transient UnknownError ended a whole stage).
export const GOAL_DEFAULTS = { turns: 20, minutes: 120, timeoutSeconds: 600, stall: 3, turnRetries: 2 }
const OUTPUT_TAIL = 2_000

// AIMETH-018 terminal run states, as the portable harness defines them.
export const PORTABLE_TERMINAL = new Set([
  "READY_FOR_REVIEW",
  "READY_FOR_APPROVAL",
  "GOAL_MET",
  "REBASELINE_REQUIRED",
  "INVALID_CONTRACT",
  "ADAPTER_UNSUPPORTED",
  "ESCALATED",
  "BUDGET_EXHAUSTED",
  "CANCELLED",
])

export type GoalState = {
  version: 1
  sessionID: string
  goal: string
  check?: string
  record?: string
  turns: number
  maxTurns: number
  maxMinutes: number
  timeoutSeconds: number
  startedAt: number
  status: "active" | "paused" | "stopped"
  reason?: string
  lastFailure?: string
  repeats: number
  /** Failed model replies retried in a row (#327); absent in loops saved before it means 0. */
  turnErrors?: number
}

export type GoalArgs =
  | { action: "stop" | "status" | "resume" }
  | {
      action: "start"
      goal: string
      check?: string
      record?: string
      turns: number
      minutes: number
      timeoutSeconds: number
    }
  | { action: "error"; message: string }

export type CheckResult = { code: number; output: string }

export type GoalStep =
  | { kind: "stop"; outcome: string; detail: string }
  | { kind: "pause"; reason: string }
  | { kind: "continue"; failure?: string }

export type CheckRunner = (input: { command: string; cwd: string; timeoutSeconds: number }) => Promise<CheckResult>

export const GOAL_USAGE =
  '/goal <what done looks like> --check "<command that exits 0 when done>" [--turns N] [--minutes N] [--timeout SECONDS] [--record <portable state.json>]  |  /goal status  |  /goal stop  |  /goal resume'

type GoalRuntimeConfig = {
  stateDir: string
  directory: string
  runCheck: CheckRunner
  now: () => number
}

const claimedSessions = new Set<string>()
const sessionLocks = new Map<string, Promise<unknown>>()
const runtimeByDirectory = new Map<string, GoalRuntimeConfig>()
let latestRuntime: GoalRuntimeConfig | undefined

function withSessionLock<T>(sessionID: string, fn: () => Promise<T>) {
  const run = (sessionLocks.get(sessionID) ?? Promise.resolve()).then(fn, fn)
  sessionLocks.set(
    sessionID,
    run.catch(() => undefined),
  )
  return run
}

function goalFilePath(dir: string, sessionID: string) {
  return path.join(dir, `${sessionID.replace(/[^\w.-]/g, "_")}.json`)
}

function resolveRuntime(directory?: string, overrides?: { stateDir?: string; runCheck?: CheckRunner; now?: () => number }) {
  const registered = (directory ? runtimeByDirectory.get(directory) : undefined) ?? latestRuntime
  return {
    stateDir: overrides?.stateDir ?? registered?.stateDir ?? path.join(Global.Path.state, "goal-loop"),
    directory: directory ?? registered?.directory ?? process.cwd(),
    runCheck: overrides?.runCheck ?? registered?.runCheck ?? createDefaultCheckRunner(),
    now: overrides?.now ?? registered?.now ?? Date.now,
  }
}

export function createDefaultCheckRunner(getShell?: () => string | undefined): CheckRunner {
  return async ({ command, cwd, timeoutSeconds }) => {
    // Same launch rules as the shell tool: PowerShell takes -Command, and other shells get
    // their own process group so a timeout can stop the whole tree, not just the shell.
    const sh = Shell.preferred(getShell?.())
    const psCommand = `& { ${command} }; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }`
    const proc =
      process.platform === "win32" && Shell.ps(sh)
        ? spawn(sh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", psCommand], {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(command, [], {
            cwd,
            shell: sh,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            windowsHide: true,
          })
    const exited = new Promise<number>((resolve, reject) => {
      proc.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)))
      proc.once("error", reject)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void Shell.killTree(proc, { exited: () => proc.exitCode !== null || proc.signalCode !== null })
    }, timeoutSeconds * 1000)
    const [code, stdout, stderr] = await Promise.all([exited, buffer(proc.stdout), buffer(proc.stderr)]).finally(() =>
      clearTimeout(timer),
    )
    const output = `${stdout.toString()}${stderr.toString()}`
    if (!timedOut) return { code, output }
    return { code: code || 124, output: `${output}\n(the check was stopped after ${timeoutSeconds} seconds)` }
  }
}

/**
 * Mark a session's goal loop as driven by a direct caller (such as `TaskTool.runTask`)
 * so `GoalLoopPlugin`'s `session.idle` listener does not race with the caller.
 */
export function claimGoalLoopSession(sessionID: string) {
  claimedSessions.add(sessionID)
  return () => {
    claimedSessions.delete(sessionID)
  }
}

export async function loadGoalState(sessionID: string, options?: { directory?: string; stateDir?: string }) {
  const runtime = resolveRuntime(options?.directory, { stateDir: options?.stateDir })
  return Filesystem.readJson<GoalState>(goalFilePath(runtime.stateDir, sessionID)).catch(
    (): GoalState | undefined => undefined,
  )
}

export async function stopGoalLoop(
  sessionID: string,
  reason = "CANCELLED: stopped by the user",
  options?: { directory?: string; stateDir?: string },
) {
  const runtime = resolveRuntime(options?.directory, { stateDir: options?.stateDir })
  const file = goalFilePath(runtime.stateDir, sessionID)
  return withSessionLock(sessionID, async () => {
    const current = await Filesystem.readJson<GoalState>(file).catch((): GoalState | undefined => undefined)
    if (!current) return undefined
    if (current.status === "stopped") return current
    const stopped: GoalState = { ...current, status: "stopped", reason }
    await Filesystem.writeJson(file, stopped)
    return stopped
  })
}

async function readPortableRecord(
  directory: string,
  recordPath: string | undefined,
): Promise<{ state?: string; error?: string } | undefined> {
  if (!recordPath) return undefined
  const target = path.resolve(directory, recordPath)
  if (!(await Filesystem.exists(target))) return {}
  return Filesystem.readJson<{ state?: unknown }>(target)
    .then((data) => ({ state: typeof data.state === "string" ? data.state : undefined }))
    .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
}

async function runStateCheck(state: GoalState, directory: string, runCheck: CheckRunner) {
  if (!state.check) return undefined
  return runCheck({ command: state.check, cwd: directory, timeoutSeconds: state.timeoutSeconds }).catch(
    (error): CheckResult => ({
      code: 1,
      output: `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
    }),
  )
}

export async function startGoalLoop(input: {
  sessionID: string
  directory?: string
  goal: string
  check?: string
  record?: string
  turns?: number
  minutes?: number
  timeoutSeconds?: number
  stateDir?: string
  runCheck?: CheckRunner
  now?: () => number
}): Promise<{ started: boolean; state: GoalState; message: string }> {
  const runtime = resolveRuntime(input.directory, {
    stateDir: input.stateDir,
    runCheck: input.runCheck,
    now: input.now,
  })
  const file = goalFilePath(runtime.stateDir, input.sessionID)
  const goal = input.goal.trim()
  const checkCmd = input.check?.trim() || undefined
  const recordPath = input.record?.trim() || undefined
  if (!goal) throw new Error("Goal description cannot be empty.")
  if (!checkCmd && !recordPath) {
    throw new Error("Give `check` (a command that exits 0 when done) or `record` (a portable state.json).")
  }
  const maxTurns = input.turns ?? GOAL_DEFAULTS.turns
  const maxMinutes = input.minutes ?? GOAL_DEFAULTS.minutes
  const timeoutSeconds = input.timeoutSeconds ?? GOAL_DEFAULTS.timeoutSeconds
  if (
    !Number.isInteger(maxTurns) ||
    maxTurns <= 0 ||
    !Number.isInteger(maxMinutes) ||
    maxMinutes <= 0 ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    throw new Error("`turns`, `minutes`, and `timeoutSeconds` must be whole numbers above 0.")
  }

  return withSessionLock(input.sessionID, async () => {
    const state: GoalState = {
      version: 1,
      sessionID: input.sessionID,
      goal,
      check: checkCmd,
      record: recordPath,
      turns: 0,
      maxTurns,
      maxMinutes,
      timeoutSeconds,
      startedAt: runtime.now(),
      status: "active",
      repeats: 0,
    }
    const baseline = await runStateCheck(state, runtime.directory, runtime.runCheck)
    if (baseline?.code === 0) {
      const stopped: GoalState = {
        ...state,
        status: "stopped",
        reason: "GOAL_MET: the check already passed before any work",
      }
      await Filesystem.writeJson(file, stopped)
      return {
        started: false,
        state: stopped,
        message: `[goal-loop] The check \`${state.check}\` already passes, so no loop was started.\nTell the user this in one line. Do no other work.`,
      }
    }
    const active: GoalState = {
      ...state,
      lastFailure: baseline ? stallKey(baseline.output) : undefined,
    }
    await Filesystem.writeJson(file, active)
    return {
      started: true,
      state: active,
      message: [
        startPrompt(active),
        ...(baseline
          ? [
              "",
              `The check fails now (exit ${baseline.code}). Last output:`,
              "```",
              baseline.output.slice(-OUTPUT_TAIL).trim() || "(no output)",
              "```",
            ]
          : []),
      ].join("\n"),
    }
  })
}

export async function advanceGoalLoopTurn(input: {
  sessionID: string
  directory?: string
  messages: { info: Message; parts: Part[] }[]
  stateDir?: string
  runCheck?: CheckRunner
  now?: () => number
  onNotify?: (state: GoalState, text: string, variant: "info" | "success" | "warning" | "error") => Promise<void>
}): Promise<
  | { kind: "inactive" }
  | { kind: "stopped" | "paused"; state: GoalState; message: string }
  | { kind: "continue"; state: GoalState; prompt: string }
> {
  const runtime = resolveRuntime(input.directory, {
    stateDir: input.stateDir,
    runCheck: input.runCheck,
    now: input.now,
  })
  const file = goalFilePath(runtime.stateDir, input.sessionID)
  const load = () => Filesystem.readJson<GoalState>(file).catch((): GoalState | undefined => undefined)
  const save = (state: GoalState) => Filesystem.writeJson(file, state)

  const started = await load()
  if (!started || started.status !== "active") return { kind: "inactive" }

  const turn = readLastTurn(input.messages)
  if (turn.pause) {
    const reason = turn.pause
    return withSessionLock(input.sessionID, async () => {
      const state = await load()
      if (!state || state.status !== "active" || state.startedAt !== started.startedAt) return { kind: "inactive" }
      const paused: GoalState = { ...state, status: "paused", reason }
      await save(paused)
      const message = `Paused: ${reason}. Type /goal resume to carry on, or /goal stop.`
      await input.onNotify?.(state, message, "warning")
      return { kind: "paused", state: paused, message }
    })
  }

  if (turn.failed) {
    const failed = turn.failed
    const outcome = await withSessionLock(input.sessionID, async () => {
      const state = await load()
      if (!state || state.status !== "active" || state.startedAt !== started.startedAt) {
        return { retry: false as const, result: { kind: "inactive" as const } }
      }
      const errors = (state.turnErrors ?? 0) + 1
      if (errors > GOAL_DEFAULTS.turnRetries) {
        const reason = `the turn failed (${failed}) ${errors} times in a row`
        const paused: GoalState = { ...state, status: "paused", reason, turnErrors: errors }
        await save(paused)
        const message = `Paused: ${reason}. Type /goal resume to carry on, or /goal stop.`
        await input.onNotify?.(state, message, "warning")
        return { retry: false as const, result: { kind: "paused" as const, state: paused, message } }
      }
      const updated: GoalState = { ...state, turnErrors: errors }
      await save(updated)
      await input.onNotify?.(
        state,
        `The turn failed (${failed}); retrying (${errors} of ${GOAL_DEFAULTS.turnRetries}).`,
        "warning",
      )
      return { retry: true as const }
    })
    if (!outcome.retry) return outcome.result
  }

  const [checked, recorded] = await Promise.all([
    runStateCheck(started, runtime.directory, runtime.runCheck),
    readPortableRecord(runtime.directory, started.record),
  ])

  return withSessionLock(input.sessionID, async () => {
    const state = await load()
    if (!state || state.status !== "active" || state.startedAt !== started.startedAt) return { kind: "inactive" }

    const step = decideGoalStep(state, { now: runtime.now(), check: checked, record: recorded })
    if (step.kind === "stop") {
      const stopped: GoalState = { ...state, status: "stopped", reason: `${step.outcome}: ${step.detail}` }
      await save(stopped)
      const message = `${step.outcome}: ${step.detail} after ${state.turns} extra prompt(s).`
      await input.onNotify?.(state, message, step.outcome === "GOAL_MET" ? "success" : "warning")
      return { kind: "stopped", state: stopped, message }
    }
    if (step.kind === "pause") {
      const paused: GoalState = { ...state, status: "paused", reason: step.reason }
      await save(paused)
      const message = `Paused: ${step.reason}. Type /goal resume to carry on, or /goal stop.`
      await input.onNotify?.(state, message, "warning")
      return { kind: "paused", state: paused, message }
    }

    const next: GoalState = {
      ...state,
      turns: state.turns + 1,
      repeats: step.failure !== undefined && step.failure === state.lastFailure ? state.repeats + 1 : 0,
      lastFailure: step.failure,
      // #327: a reply that worked resets the run of failed ones.
      turnErrors: turn.failed ? state.turnErrors : 0,
    }
    await save(next)
    return {
      kind: "continue",
      state: next,
      prompt: continuePrompt(next, { check: checked, record: recorded?.state }),
    }
  })
}

// `raw` is the token as typed, quotes included; `value` drops one pair of surrounding quotes.
function tokens(text: string) {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => ({ raw: m[0], value: m[1] ?? m[2] ?? m[3] }))
}

export function parseGoalArgs(text: string): GoalArgs {
  const words = tokens(text.trim())
  const word = words.length === 1 ? words[0].raw.toLowerCase() : ""
  if (word === "stop" || word === "status" || word === "resume") return { action: word }

  const flags: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < words.length; i++) {
    // Goal words keep their quotes; only option values are unquoted. A quoted "--x" is goal text.
    if (!words[i].raw.startsWith("--")) {
      rest.push(words[i].raw)
      continue
    }
    const name = words[i].raw.slice(2)
    if (!["check", "record", "turns", "minutes", "timeout"].includes(name))
      return { action: "error", message: `Unknown option --${name}.` }
    if (i + 1 >= words.length || words[i + 1].raw.startsWith("--"))
      return { action: "error", message: `--${name} needs a value.` }
    flags[name] = words[++i].value
  }

  const number = (name: string, fallback: number) => {
    if (flags[name] === undefined) return fallback
    const value = Number(flags[name])
    return Number.isInteger(value) && value > 0 ? value : undefined
  }
  const turns = number("turns", GOAL_DEFAULTS.turns)
  const minutes = number("minutes", GOAL_DEFAULTS.minutes)
  const timeoutSeconds = number("timeout", GOAL_DEFAULTS.timeoutSeconds)
  if (turns === undefined || minutes === undefined || timeoutSeconds === undefined)
    return { action: "error", message: "--turns, --minutes and --timeout must be whole numbers above 0." }

  const goal = rest.join(" ").trim()
  if (!goal) return { action: "error", message: "Say what done looks like." }
  if (!flags.check?.trim() && !flags.record?.trim())
    return {
      action: "error",
      message: "Give --check (a command that exits 0 when done) or --record (a portable state.json).",
    }
  return {
    action: "start",
    goal,
    check: flags.check?.trim() || undefined,
    record: flags.record?.trim() || undefined,
    turns,
    minutes,
    timeoutSeconds,
  }
}

/**
 * How the last turn ended: a user abort or GOAL_BLOCKED pauses the loop; a failed model reply is
 * reported as `failed` (the error name and its message, cut) so the loop can retry it (#327).
 */
export function readLastTurn(messages: { info: Message; parts: Part[] }[]): { pause?: string; failed?: string } {
  const last = messages.findLast((m) => m.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return {}
  if (last.info.error?.name === "MessageAbortedError") return { pause: "aborted by the user" }
  if (last.info.error) {
    const message = (last.info.error as { data?: { message?: unknown } }).data?.message
    const detail = typeof message === "string" && message.trim() ? `: ${message.trim().replace(/\s+/g, " ").slice(0, 200)}` : ""
    return { failed: `${last.info.error.name}${detail}` }
  }
  const blocked = last.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
    .match(/^\s*GOAL_BLOCKED:\s*(.+)$/m)
  if (blocked) return { pause: `blocked: ${blocked[1].trim().replace(/[.\s]+$/, "")}` }
  return {}
}

// Durations and timestamps change between identical failures; they must not hide a stall.
function stallKey(output: string) {
  return output
    .slice(-OUTPUT_TAIL)
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<time>")
    .replace(/\d+(\.\d+)?\s?(ms|s|m)\b/g, "<duration>")
    .trim()
}

/** Decide what to do after a turn, from the check and the portable record. Pure. */
export function decideGoalStep(
  state: GoalState,
  input: { now: number; check?: CheckResult; record?: { state?: string; error?: string } },
): GoalStep {
  if (input.record?.error)
    return { kind: "pause", reason: `the portable record could not be read (${input.record.error})` }
  if (input.record?.state && PORTABLE_TERMINAL.has(input.record.state))
    return { kind: "stop", outcome: input.record.state, detail: `the portable record reached ${input.record.state}` }
  if (input.record?.state === "PAUSED") return { kind: "pause", reason: "the portable record is PAUSED" }
  if (input.check?.code === 0) return { kind: "stop", outcome: "GOAL_MET", detail: `\`${state.check}\` exited 0` }
  if (state.turns >= state.maxTurns)
    return { kind: "stop", outcome: "BUDGET_EXHAUSTED", detail: `used all ${state.maxTurns} turns` }
  if (input.now - state.startedAt >= state.maxMinutes * 60_000)
    return { kind: "stop", outcome: "BUDGET_EXHAUSTED", detail: `used all ${state.maxMinutes} minutes` }
  if (!input.check) return { kind: "continue" }
  const failure = stallKey(input.check.output)
  if (failure === state.lastFailure && state.repeats + 1 >= GOAL_DEFAULTS.stall)
    return {
      kind: "stop",
      outcome: "STALLED",
      detail: `the check failed the same way ${GOAL_DEFAULTS.stall} times in a row`,
    }
  return { kind: "continue", failure }
}

export function continuePrompt(state: GoalState, input: { check?: CheckResult; record?: string }) {
  return [
    `[goal-loop] Turn ${state.turns}/${state.maxTurns}. The goal is not met yet.`,
    `Goal: ${state.goal}`,
    ...(input.check
      ? [
          `The check \`${state.check}\` exited ${input.check.code}. Last output:`,
          "```",
          input.check.output.slice(-OUTPUT_TAIL).trim() || "(no output)",
          "```",
        ]
      : []),
    ...(state.record
      ? [
          `Portable record ${state.record} is in state ${input.record ?? "(not written yet)"}. Execute one recoverable tick, then stop.`,
        ]
      : []),
    "Take the next focused step toward the goal. When you stop, the loop runs the check again; you cannot mark the goal met yourself.",
    "Do not change the check, its tests, or the record's contract to make it pass.",
    "If you cannot go on without the user, end your reply with one line: GOAL_BLOCKED: <reason>",
  ].join("\n")
}

export function startPrompt(state: GoalState) {
  return [
    "[goal-loop] A goal loop has started for this session.",
    `Goal: ${state.goal}`,
    ...(state.check
      ? [`Done when: \`${state.check}\` exits 0. The loop runs this check itself after each of your turns.`]
      : []),
    ...(state.record
      ? [
          `Portable record: ${state.record}. The loop stops when its state is terminal. Execute one recoverable tick per turn.`,
        ]
      : []),
    `Budget: ${state.maxTurns} turns, ${state.maxMinutes} minutes.`,
    "Work toward the goal one focused step at a time. Do not change the check, its tests, or the record's contract to make it pass.",
    "If you cannot go on without the user, end your reply with one line: GOAL_BLOCKED: <reason>",
  ].join("\n")
}

export function describeGoal(state: GoalState | undefined) {
  if (!state) return "No goal loop has been started in this session."
  return [
    `Goal loop: ${state.status}${state.reason ? ` (${state.reason})` : ""}.`,
    `Goal: ${state.goal}`,
    ...(state.check ? [`Check: \`${state.check}\``] : []),
    ...(state.record ? [`Record: ${state.record}`] : []),
    `Turns used: ${state.turns}/${state.maxTurns}. Started ${new Date(state.startedAt).toISOString()}, budget ${state.maxMinutes} minutes.`,
  ].join("\n")
}

export async function GoalLoopPlugin(
  input: PluginInput,
  options?: { stateDir?: string; runCheck?: CheckRunner; now?: () => number },
): Promise<Hooks> {
  const dir = options?.stateDir ?? path.join(Global.Path.state, "goal-loop")
  const now = options?.now ?? Date.now
  const busy = new Set<string>()
  let shell: string | undefined
  let owned = false

  const runCheck = options?.runCheck ?? createDefaultCheckRunner(() => shell)
  const runtimeConfig: GoalRuntimeConfig = {
    stateDir: dir,
    directory: input.directory,
    runCheck,
    now,
  }
  runtimeByDirectory.set(input.directory, runtimeConfig)
  latestRuntime = runtimeConfig

  const file = (sessionID: string) => goalFilePath(dir, sessionID)
  const load = (sessionID: string) =>
    Filesystem.readJson<GoalState>(file(sessionID)).catch((): GoalState | undefined => undefined)
  const save = (state: GoalState) => Filesystem.writeJson(file(state.sessionID), state)
  const exclusive = <T>(sessionID: string, fn: () => Promise<T>) => withSessionLock(sessionID, fn)

  const notify = async (state: GoalState, text: string, variant: "info" | "success" | "warning" | "error") => {
    await input.client.tui.showToast({ body: { title: "Goal loop", message: text, variant } }).catch(() => undefined)
    await input.client.session
      .promptAsync({
        path: { id: state.sessionID },
        body: { noReply: true, parts: [{ type: "text", text: `[goal-loop] ${text}` }] },
      })
      .catch(() => undefined)
  }

  const onIdle = async (sessionID: string) => {
    const started = await load(sessionID)
    if (!started || started.status !== "active") return

    const messages = await input.client.session.messages({ path: { id: sessionID } })
    const outcome = await advanceGoalLoopTurn({
      sessionID,
      directory: input.directory,
      messages: messages.data ?? [],
      stateDir: dir,
      runCheck,
      now,
      onNotify: notify,
    })
    if (outcome.kind !== "continue") return

    const user = messages.data?.findLast((m) => m.info.role === "user")?.info
    await input.client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(user?.role === "user" ? { agent: user.agent, model: user.model } : {}),
        parts: [{ type: "text", text: outcome.prompt }],
      },
    })
  }

  const runGoalCommand = async (sessionID: string, args: GoalArgs) => {
    if (args.action === "error") {
      return `[goal-loop] The goal loop did not start: ${args.message}\nUsage: ${GOAL_USAGE}\nTell the user this in one or two lines. Do no other work.`
    }
    if (args.action === "status") {
      const current = await exclusive(sessionID, () => load(sessionID))
      return `[goal-loop] ${describeGoal(current)}\nTell the user this status in plain words. Do no other work.`
    }
    if (args.action === "stop") {
      return exclusive(sessionID, async () => {
        const current = await load(sessionID)
        if (current && current.status !== "stopped") {
          await save({ ...current, status: "stopped", reason: "CANCELLED: stopped by the user" })
        }
        return `[goal-loop] ${current ? "The goal loop is stopped." : describeGoal(current)}\nTell the user this in one line. Do no other work.`
      })
    }
    if (args.action !== "start") {
      return exclusive(sessionID, async () => {
        const current = await load(sessionID)
        if (!current || current.status !== "paused") {
          return `[goal-loop] Nothing to resume. ${describeGoal(current)}\nTell the user this in one line. Do no other work.`
        }
        const resumed: GoalState = { ...current, status: "active", reason: undefined, repeats: 0, turnErrors: 0 }
        await save(resumed)
        return continuePrompt(resumed, {})
      })
    }

    const started = await startGoalLoop({
      sessionID,
      directory: input.directory,
      goal: args.goal,
      check: args.check,
      record: args.record,
      turns: args.turns,
      minutes: args.minutes,
      timeoutSeconds: args.timeoutSeconds,
      stateDir: dir,
      runCheck,
      now,
    })
    return started.message
  }

  return {
    config: async (cfg) => {
      // `shell` is a core config key that the plugin Config type does not declare.
      shell = "shell" in cfg && typeof cfg.shell === "string" ? cfg.shell : undefined
      // A person's own /goal command wins; the plugin then stays out of the way.
      if (cfg.command?.[GOAL_COMMAND]) return
      cfg.command = {
        ...cfg.command,
        [GOAL_COMMAND]: {
          description: "keep working until a check passes (goal loop)",
          // Never empty, so the hook below always finds a text part to rewrite.
          template: "[goal-loop] $ARGUMENTS",
        },
      }
      owned = true
    },
    "command.execute.before": async (hook, output) => {
      if (!owned || hook.command !== GOAL_COMMAND) return
      const args = parseGoalArgs(hook.arguments)
      const reply = await runGoalCommand(hook.sessionID, args)
      // The caller keeps its own reference to `parts`, so change the part in place.
      const text = output.parts.find((part) => part.type === "text")
      if (text?.type === "text") text.text = reply
    },
    tool: {
      goal_loop: tool({
        description:
          "Start, inspect, resume, or stop a goal loop in the current session (or a target session). When active, the loop runs the `check` command (or inspects the `record` file) after every turn and keeps prompting the session until the check exits 0, the record reaches a terminal state, or the turn/time budget is exhausted.",
        args: {
          action: tool.schema
            .enum(["start", "status", "stop", "resume"])
            .describe("Goal loop action: start, status, stop, or resume"),
          goal: tool.schema
            .string()
            .optional()
            .describe("What done looks like (required when action is 'start')"),
          check: tool.schema
            .string()
            .optional()
            .describe("Shell command that exits 0 when the goal is met"),
          record: tool.schema
            .string()
            .optional()
            .describe("Path to a portable state.json record"),
          turns: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum extra turns (default: 20)"),
          minutes: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Maximum duration in minutes (default: 120)"),
          timeout: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Check command timeout in seconds (default: 600)"),
          session_id: tool.schema
            .string()
            .optional()
            .describe("Optional session ID to manage (defaults to the current session)"),
        },
        async execute(args, context) {
          const targetSession = args.session_id?.trim() || context.sessionID
          if (args.action === "status") {
            const current = await exclusive(targetSession, () => load(targetSession))
            context.metadata({
              title: "Goal loop status",
              metadata: { sessionID: targetSession, status: current?.status ?? "none" },
            })
            return describeGoal(current)
          }
          if (args.action === "stop") {
            const stopped = await stopGoalLoop(targetSession, "CANCELLED: stopped by the agent", {
              directory: input.directory,
              stateDir: dir,
            })
            context.metadata({
              title: "Stopped goal loop",
              metadata: { sessionID: targetSession, status: stopped?.status ?? "none" },
            })
            return stopped ? "The goal loop is stopped." : describeGoal(undefined)
          }
          if (args.action === "resume") {
            return exclusive(targetSession, async () => {
              const current = await load(targetSession)
              if (!current || current.status !== "paused") {
                return `Nothing to resume. ${describeGoal(current)}`
              }
              const resumed: GoalState = {
                ...current,
                status: "active",
                reason: undefined,
                repeats: 0,
                turnErrors: 0,
              }
              await save(resumed)
              context.metadata({
                title: "Resumed goal loop",
                metadata: { sessionID: targetSession, status: resumed.status },
              })
              return continuePrompt(resumed, {})
            })
          }

          const started = await startGoalLoop({
            sessionID: targetSession,
            directory: input.directory,
            goal: args.goal ?? "",
            check: args.check,
            record: args.record,
            turns: args.turns,
            minutes: args.minutes,
            timeoutSeconds: args.timeout,
            stateDir: dir,
            runCheck,
            now,
          })
          context.metadata({
            title: started.started ? "Started goal loop" : "Goal loop check already passed",
            metadata: {
              sessionID: targetSession,
              status: started.state.status,
              started: started.started,
            },
          })
          return started.message
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await fs.rm(file(event.properties.info.id), { force: true }).catch(() => undefined)
        return
      }
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (claimedSessions.has(sessionID) || busy.has(sessionID)) return
      busy.add(sessionID)
      await onIdle(sessionID)
        .catch((error) =>
          exclusive(sessionID, async () => {
            const state = await load(sessionID)
            if (!state || state.status !== "active") return
            const reason = `the loop hit an error (${error instanceof Error ? error.message : String(error)})`
            await save({ ...state, status: "paused", reason })
            await notify(state, `Paused: ${reason}.`, "error")
          }),
        )
        .finally(() => busy.delete(sessionID))
    },
  }
}
