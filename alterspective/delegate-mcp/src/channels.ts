// T3.5 optional Claude channel push (research preview). Owned by the Wave 3 interaction build.
// Until implemented this is a no-op; the server calls it only when started with --channels.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { DelegateHub } from "./events/index.ts"

export type ChannelOptions = { enabled: boolean }

export function attachChannels(_server: McpServer, _hub: DelegateHub, _options: ChannelOptions): () => void {
  return () => {}
}
