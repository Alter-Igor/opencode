import { createMemo, Show } from "solid-js"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"

export function useRagConnected() {
  const sync = useSync()
  return createMemo(() => {
    const mcp = (sync.data.mcp ?? {}) as Record<string, { status?: string } | undefined>
    const rag = mcp["alterspective-rag"]
    const keystone = mcp["keystone-dynamic"]
    return rag?.status === "connected" || keystone?.status === "connected"
  })
}

export function RagWarningBanner() {
  const { theme } = useTheme()
  const isConnected = useRagConnected()

  return (
    <Show when={!isConnected()}>
      <box
        width="100%"
        borderStyle="single"
        borderColor={theme.warning}
        paddingLeft={1}
        paddingRight={1}
        marginBottom={1}
        flexDirection="row"
        gap={1}
      >
        <text fg={theme.warning} attributes={TextAttributes.BOLD}>
          ⚠ WARNING:
        </text>
        <text fg={theme.text}>
          Alterspective RAG is not connected. Canonical operating rules & standards from RAG are unavailable.
        </text>
        <text fg={theme.textMuted}>
          (Open /mcp to connect)
        </text>
      </box>
    </Show>
  )
}
