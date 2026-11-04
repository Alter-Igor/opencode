import { createMemo, Show } from "solid-js"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"

export function useRagConnected() {
  const data = useData()
  const location = useLocation()
  return createMemo(() => {
    const current = location.ref ?? data.location.default()
    const servers = data.location.mcp.server.list(current)
    if (!servers || servers.length === 0) return true
    const rag = servers.find((s) => s.name === "alterspective-rag")
    const keystone = servers.find((s) => s.name === "keystone-dynamic")
    return rag?.status.status === "connected" || keystone?.status.status === "connected"
  })
}

export function RagWarningBanner() {
  const theme = useTheme()
  const isConnected = useRagConnected()

  return (
    <Show when={!isConnected()}>
      <box
        width="100%"
        borderStyle="single"
        borderColor={theme.text.feedback.warning.base}
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
        flexDirection="row"
        gap={1}
      >
        <text fg={theme.text.feedback.warning.base} attributes={TextAttributes.BOLD}>
          ⚠ WARNING:
        </text>
        <text fg={theme.text.base}>
          Alterspective RAG is not connected. Canonical operating rules & standards from RAG are unavailable.
        </text>
        <text fg={theme.text.muted}>(Open /mcp to connect)</text>
      </box>
    </Show>
  )
}
