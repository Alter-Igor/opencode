// MOD-03 T3.1: turn one /global/event SSE `data` into a typed, size-bounded Raw event.
// Wire shape (handlers/global.ts:25-46): {directory?, project?, workspace?, payload:{id,type,properties}}.
// Only fields the hub needs survive; everything else (and every unknown type) is dropped here, so
// no other module touches the untyped payload. Session text is kept only for the final text part.

export type Wrapper = { directory?: string; type: string; props: Obj }

type Obj = Record<string, unknown>

export type Raw =
  | { kind: "connected" }
  | { kind: "heartbeat" }
  | { kind: "status"; sessionID: string; status: "idle" | "busy" | "retry"; attempt?: number }
  | { kind: "error"; sessionID?: string; name: string; aborted: boolean }
  | { kind: "permission.asked"; sessionID: string; requestID: string; permission: string; patterns: number }
  | { kind: "permission.replied"; sessionID: string; requestID: string; reply: string }
  | { kind: "question.asked"; sessionID: string; requestID: string; count: number }
  | { kind: "question.done"; sessionID: string; requestID: string; rejected: boolean }
  | { kind: "message.role"; sessionID: string; messageID: string; role: "user" | "assistant" }
  | { kind: "text.final"; sessionID: string; messageID: string; partID: string; text: string }
  | { kind: "todo"; sessionID: string; total: number; done: number }
  | { kind: "mcp"; server: string }
  | { kind: "deleted"; sessionID: string }
  | { kind: "info"; sessionID: string; parentID?: string; directory?: string }
  | { kind: "disposed"; directory: string | "all" }
  | { kind: "ignored"; type: string }

export const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value)
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined)
const obj = (value: unknown): Obj => (isObj(value) ? value : {})

/** OpenCode permission/question ids (id/id.ts): anything else is dropped, never echoed (W2C-03). */
export const REQUEST_ID_RE = /^(per|que)_[A-Za-z0-9]{1,36}$/
const requestId = (value: unknown): string | undefined => {
  const id = str(value)
  return id && REQUEST_ID_RE.test(id) ? id : undefined
}

/** Parse one SSE data string. Tolerates the per-instance /event shape (a bare payload) too. */
export function unwrap(data: string): Wrapper | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  if (!isObj(parsed)) return undefined
  const payload = isObj(parsed.payload) ? parsed.payload : parsed
  const type = str(payload.type)
  if (!type) return undefined
  return { directory: str(parsed.directory), type, props: obj(payload.properties) }
}

export function sessionOf(raw: Raw): string | undefined {
  return "sessionID" in raw ? raw.sessionID : undefined
}

function status(p: Obj): Raw | undefined {
  const sessionID = str(p.sessionID)
  const s = obj(p.status)
  const type = s.type
  if (!sessionID || (type !== "idle" && type !== "busy" && type !== "retry")) return undefined
  return { kind: "status", sessionID, status: type, attempt: typeof s.attempt === "number" ? s.attempt : undefined }
}

function error(p: Obj): Raw {
  const name = str(obj(p.error).name) ?? "UnknownError"
  return { kind: "error", sessionID: str(p.sessionID), name, aborted: name === "MessageAbortedError" }
}

function permission(type: string, p: Obj): Raw | undefined {
  const sessionID = str(p.sessionID)
  if (!sessionID) return undefined
  if (type === "permission.asked") {
    const requestID = requestId(p.id)
    const patterns = Array.isArray(p.patterns) ? p.patterns.length : 0
    return requestID ? { kind: "permission.asked", sessionID, requestID, permission: str(p.permission) ?? "unknown", patterns } : undefined
  }
  if (type !== "permission.replied") return undefined
  const requestID = requestId(p.requestID)
  return requestID ? { kind: "permission.replied", sessionID, requestID, reply: str(p.reply) ?? "unknown" } : undefined
}

function question(type: string, p: Obj): Raw | undefined {
  const sessionID = str(p.sessionID)
  if (!sessionID) return undefined
  if (type === "question.asked") {
    const requestID = requestId(p.id)
    const count = Array.isArray(p.questions) ? p.questions.length : 0
    return requestID ? { kind: "question.asked", sessionID, requestID, count } : undefined
  }
  if (type !== "question.replied" && type !== "question.rejected") return undefined
  const requestID = requestId(p.requestID)
  return requestID ? { kind: "question.done", sessionID, requestID, rejected: type === "question.rejected" } : undefined
}

function messageRole(p: Obj): Raw | undefined {
  const info = obj(p.info)
  const sessionID = str(p.sessionID) ?? str(info.sessionID)
  const messageID = str(info.id)
  const role = info.role
  if (!sessionID || !messageID || (role !== "user" && role !== "assistant")) return undefined
  return { kind: "message.role", sessionID, messageID, role }
}

/** Only a finished, real (not synthetic/ignored) text part counts; streaming updates are dropped. */
function textPart(p: Obj): Raw | undefined {
  const part = obj(p.part)
  const sessionID = str(p.sessionID) ?? str(part.sessionID)
  const messageID = str(part.messageID)
  const partID = str(part.id)
  if (part.type !== "text" || typeof part.text !== "string" || part.synthetic === true || part.ignored === true) return undefined
  if (typeof obj(part.time).end !== "number" || !sessionID || !messageID || !partID) return undefined
  return { kind: "text.final", sessionID, messageID, partID, text: part.text }
}

function todo(p: Obj): Raw | undefined {
  const sessionID = str(p.sessionID)
  if (!sessionID || !Array.isArray(p.todos)) return undefined
  const done = p.todos.filter((t) => isObj(t) && t.status === "completed").length
  return { kind: "todo", sessionID, total: p.todos.length, done }
}

/** session.created / session.updated: only the parent link and directory are kept (subagents, W2A-03). */
function sessionInfo(p: Obj): Raw | undefined {
  const info = obj(p.info)
  const sessionID = str(p.sessionID) ?? str(info.id)
  if (!sessionID) return undefined
  return { kind: "info", sessionID, parentID: str(info.parentID), directory: str(info.directory) }
}

/** An instance (one directory) or the whole server was disposed: runs may have ended unseen (W2A-10). */
function disposed(type: string, p: Obj, w: Wrapper): Raw | undefined {
  if (type === "global.disposed") return { kind: "disposed", directory: "all" }
  const directory = str(p.directory) ?? w.directory
  return directory ? { kind: "disposed", directory } : undefined
}

function other(type: string, p: Obj): Raw | undefined {
  if (type === "server.connected") return { kind: "connected" }
  if (type === "server.heartbeat") return { kind: "heartbeat" }
  if (type === "todo.updated") return todo(p)
  if (type === "mcp.tools.changed") return { kind: "mcp", server: str(p.server) ?? "unknown" }
  if (type === "session.deleted") {
    const sessionID = str(p.sessionID) ?? str(obj(p.info).id)
    return sessionID ? { kind: "deleted", sessionID } : undefined
  }
  return undefined
}

export function normalise(w: Wrapper): Raw {
  const p = w.props
  let raw: Raw | undefined
  if (w.type === "session.status") raw = status(p)
  else if (w.type === "session.error") raw = error(p)
  else if (w.type.startsWith("permission.")) raw = permission(w.type, p)
  else if (w.type.startsWith("question.")) raw = question(w.type, p)
  else if (w.type === "message.updated") raw = messageRole(p)
  else if (w.type === "message.part.updated") raw = textPart(p)
  else if (w.type === "session.created" || w.type === "session.updated") raw = sessionInfo(p)
  else if (w.type === "server.instance.disposed" || w.type === "global.disposed") raw = disposed(w.type, p, w)
  else raw = other(w.type, p)
  // `session.idle` is deprecated and always follows `session.status idle`: ignored, never doubled.
  return raw ?? { kind: "ignored", type: w.type }
}
