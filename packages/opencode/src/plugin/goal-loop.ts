import { spawn } from "child_process"
import fs from "fs/promises"
import { buffer } from "node:stream/consumers"
import path from "path"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Message, Part } from "@opencode-ai/sdk"
import { Global } from "@opencode-ai/core/global"
import { Shell } from "@opencode-ai/core/shell"
import { Filesystem } from "@/util/filesystem"

// Fork-only (#84): `/goal` keeps a session working until a check command passes.
// The plugin runs the check itself on every `session.idle`, so the model cannot
// declare the goal met. It does nothing until a person starts a goal.

export const GOAL_COMMAND = "goal"
export const GOAL_DEFAULTS = { turns: 20, minutes: 120, timeoutSeconds: 600, stall: 3 }
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

/** How the last turn ended: a user abort or error pauses the loop, and so does GOAL_BLOCKED. */
export function readLastTurn(messages: { info: Message; parts: Part[] }[]) {
  const last = messages.findLast((m) => m.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return {}
  if (last.info.error?.name === "MessageAbortedError") return { pause: "aborted by the user" }
  if (last.info.error) return { pause: `the turn failed (${last.info.error.name})` }
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

  const file = (sessionID: string) => path.join(dir, `${sessionID.replace(/[^\w.-]/g, "_")}.json`)
  const load = (sessionID: string) =>
    Filesystem.readJson<GoalState>(file(sessionID)).catch((): GoalState | undefined => undefined)
  const save = (state: GoalState) => Filesystem.writeJson(file(state.sessionID), state)
  // Every read-decide-write of a session's loop runs one at a time, so `/goal stop` and a
  // finishing check cannot interleave. The check itself runs outside the lock.
  const locks = new Map<string, Promise<unknown>>()
  const exclusive = <T>(sessionID: string, fn: () => Promise<T>) => {
    const run = (locks.get(sessionID) ?? Promise.resolve()).then(fn, fn)
    locks.set(
      sessionID,
      run.catch(() => undefined),
    )
    return run
  }

  const runCheck =
    options?.runCheck ??
    (async ({ command, cwd, timeoutSeconds }) => {
      // Same launch rules as the shell tool: PowerShell takes -Command, and other shells get
      // their own process group so a timeout can stop the whole tree, not just the shell.
      const sh = Shell.preferred(shell)
      const proc =
        process.platform === "win32" && Shell.ps(sh)
          ? spawn(sh, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
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
    })

  const check = (state: GoalState) =>
    state.check
      ? runCheck({ command: state.check, cwd: input.directory, timeoutSeconds: state.timeoutSeconds }).catch(
          (error): CheckResult => ({
            code: 1,
            output: `The check could not run: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
      : Promise.resolve(undefined)

  const record = async (state: GoalState): Promise<{ state?: string; error?: string } | undefined> => {
    if (!state.record) return undefined
    const target = path.resolve(input.directory, state.record)
    if (!(await Filesystem.exists(target))) return {}
    return Filesystem.readJson<{ state?: unknown }>(target)
      .then((data) => ({ state: typeof data.state === "string" ? data.state : undefined }))
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
  }

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
    const turn = readLastTurn(messages.data ?? [])
    if (turn.pause) {
      const reason = turn.pause
      await exclusive(sessionID, async () => {
        const state = await load(sessionID)
        if (!state || state.status !== "active" || state.startedAt !== started.startedAt) return
        await save({ ...state, status: "paused", reason })
        await notify(state, `Paused: ${reason}. Type /goal resume to carry on, or /goal stop.`, "warning")
      })
      return
    }

    const [checked, recorded] = await Promise.all([check(started), record(started)])
    // Decide and save from the state as it is now: the person may have stopped, paused,
    // resumed or restarted the loop while the check ran.
    await exclusive(sessionID, async () => {
      const state = await load(sessionID)
      if (!state || state.status !== "active" || state.startedAt !== started.startedAt) return

      const step = decideGoalStep(state, { now: now(), check: checked, record: recorded })
      if (step.kind === "stop") {
        await save({ ...state, status: "stopped", reason: `${step.outcome}: ${step.detail}` })
        await notify(
          state,
          `${step.outcome}: ${step.detail} after ${state.turns} extra prompt(s).`,
          step.outcome === "GOAL_MET" ? "success" : "warning",
        )
        return
      }
      if (step.kind === "pause") {
        await save({ ...state, status: "paused", reason: step.reason })
        await notify(state, `Paused: ${step.reason}. Type /goal resume to carry on, or /goal stop.`, "warning")
        return
      }

      const next: GoalState = {
        ...state,
        turns: state.turns + 1,
        repeats: step.failure !== undefined && step.failure === state.lastFailure ? state.repeats + 1 : 0,
        lastFailure: step.failure,
      }
      await save(next)
      const user = messages.data?.findLast((m) => m.info.role === "user")?.info
      await input.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          ...(user?.role === "user" ? { agent: user.agent, model: user.model } : {}),
          parts: [{ type: "text", text: continuePrompt(next, { check: checked, record: recorded?.state }) }],
        },
      })
    })
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
      const reply = await exclusive(hook.sessionID, async () => {
        const args = parseGoalArgs(hook.arguments)
        const current = await load(hook.sessionID)
        if (args.action === "error")
          return `[goal-loop] The goal loop did not start: ${args.message}\nUsage: ${GOAL_USAGE}\nTell the user this in one or two lines. Do no other work.`
        if (args.action === "status")
          return `[goal-loop] ${describeGoal(current)}\nTell the user this status in plain words. Do no other work.`
        if (args.action === "stop") {
          if (current && current.status !== "stopped")
            await save({ ...current, status: "stopped", reason: "CANCELLED: stopped by the user" })
          return `[goal-loop] ${current ? "The goal loop is stopped." : describeGoal(current)}\nTell the user this in one line. Do no other work.`
        }
        if (args.action !== "start") {
          if (!current || current.status !== "paused")
            return `[goal-loop] Nothing to resume. ${describeGoal(current)}\nTell the user this in one line. Do no other work.`
          const resumed: GoalState = { ...current, status: "active", reason: undefined, repeats: 0 }
          await save(resumed)
          return continuePrompt(resumed, {})
        }

        const state: GoalState = {
          version: 1,
          sessionID: hook.sessionID,
          goal: args.goal,
          check: args.check,
          record: args.record,
          turns: 0,
          maxTurns: args.turns,
          maxMinutes: args.minutes,
          timeoutSeconds: args.timeoutSeconds,
          startedAt: now(),
          status: "active",
          repeats: 0,
        }
        // Baseline: a check that already passes cannot measure progress (AIMETH-018).
        const baseline = await check(state)
        if (baseline?.code === 0) {
          await save({ ...state, status: "stopped", reason: "GOAL_MET: the check already passed before any work" })
          return `[goal-loop] The check \`${state.check}\` already passes, so no loop was started.\nTell the user this in one line. Do no other work.`
        }
        await save({ ...state, lastFailure: baseline ? stallKey(baseline.output) : undefined })
        return [
          startPrompt(state),
          ...(baseline
            ? [
                "",
                `The check fails now (exit ${baseline.code}). Last output:`,
                "```",
                baseline.output.slice(-OUTPUT_TAIL).trim() || "(no output)",
                "```",
              ]
            : []),
        ].join("\n")
      })
      // The caller keeps its own reference to `parts`, so change the part in place.
      const text = output.parts.find((part) => part.type === "text")
      if (text?.type === "text") text.text = reply
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        await fs.rm(file(event.properties.info.id), { force: true }).catch(() => undefined)
        return
      }
      if (event.type !== "session.idle") return
      const sessionID = event.properties.sessionID
      if (busy.has(sessionID)) return
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
