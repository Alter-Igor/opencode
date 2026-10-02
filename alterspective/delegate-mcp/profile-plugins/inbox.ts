// Trusted, read-only profile plugin. The client holds process-local API authority; no token
// goes into a tool argument, environment variable, file or result.
import messageSupervisor from "../profile-tools/message_supervisor.ts"
import messageSession from "../profile-tools/message_session.ts"
import readInbox from "../profile-tools/read_inbox.ts"
import { InboxToolError, type SessionInfo, type ToolContext } from "../profile-tools/inbox-lib.ts"

type Input = { client: { session: { get(input: { path: { id: string }; query: { directory: string }; signal: AbortSignal }): Promise<{ data?: unknown; response: { status: number } }> } } }

export default async function inbox(input: Input) {
  async function readSession(id: string, directory: string): Promise<SessionInfo> {
    let result
    try {
      result = await input.client.session.get({ path: { id }, query: { directory }, signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new InboxToolError("This sandbox's OpenCode server could not be asked who supervises this session. Nothing was sent.")
    }
    if (result.response.status !== 200) throw new InboxToolError(`This session's record could not be read (HTTP ${result.response.status}). Nothing was sent.`)
    if (typeof result.data !== "object" || result.data === null || Array.isArray(result.data)) throw new InboxToolError("This session's record came back unreadable, so its supervisor is unknown. Nothing was sent; try again.")
    return result.data as SessionInfo
  }
  return {
    tool: {
      message_supervisor: {
        ...messageSupervisor,
        execute: (args: Record<string, unknown>, ctx: ToolContext) => messageSupervisor.execute(args, { ...ctx, readSession }),
      },
      message_session: messageSession,
      read_inbox: readInbox,
    },
  }
}
