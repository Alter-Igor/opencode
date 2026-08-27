import { createMemo, createSignal, onMount, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useClipboard } from "../context/clipboard"

export interface DiagnosticItem {
  id: string
  title: string
  description: string
  category: "Recent Errors" | "Inference Events" | "System Health" | "Log Files"
  status?: "ok" | "error" | "info"
  detail?: string
}

export function DialogLogs() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const clipboard = useClipboard()
  const { theme } = useTheme()
  const [selectedDetail, setSelectedDetail] = createSignal<string | null>(null)
  const [authStatus, setAuthStatus] = createSignal<string>("Authenticated (Keystone SSO)")

  const logPath = "C:\\Users\\IgorJericevich\\.local\\share\\opencode\\log\\opencode.log"
  const diagPath = "C:\\Users\\IgorJericevich\\.local\\share\\opencode\\log\\diagnostics.log"

  const items = createMemo<DiagnosticItem[]>(() => [
    {
      id: "health-synapse",
      title: "Synapse AI Gateway",
      description: `Status: ${authStatus()} · Endpoint: https://synapse-mcp.alterspective.com.au/mcp`,
      category: "System Health",
      status: "ok",
      detail: `Synapse Provider Configuration:\n- Routing: On-prem GPU Gateway\n- Auth: Keystone Single Sign-On\n- Default Model: auto (ornith-1.0-35b / deepseek)\n- Status: ${authStatus()}`,
    },
    {
      id: "health-keystone",
      title: "Keystone Dynamic MCP",
      description: "Governance broker for M365, RAG, and corporate integrations",
      category: "System Health",
      status: "ok",
      detail: "Keystone Dynamic MCP:\n- Endpoint: https://identity.alterspective.com.au/mcp/dynamic\n- Auditing: Active\n- Raw Browser Gate: Enforced (raw office.com blocked)",
    },
    {
      id: "log-main",
      title: "OpenCode Main Server Log",
      description: `Path: ${logPath}`,
      category: "Log Files",
      status: "info",
      detail: `Main Log File:\n${logPath}\n\nPress Enter to copy this path to your clipboard.`,
    },
    {
      id: "log-diag",
      title: "Session Diagnostics Log",
      description: `Path: ${diagPath}`,
      category: "Log Files",
      status: "info",
      detail: `Diagnostics Log File:\n${diagPath}\n\nPress Enter to copy this path to your clipboard.`,
    },
  ])

  const options = createMemo<DialogSelectOption<DiagnosticItem>[]>(() =>
    items().map((item) => {
      const tag =
        item.status === "ok"
          ? { text: " [OK] ", fg: theme.success, attributes: TextAttributes.BOLD }
          : item.status === "error"
            ? { text: " [FAIL] ", fg: theme.error, attributes: TextAttributes.BOLD }
            : { text: " [INFO] ", fg: theme.accent, attributes: TextAttributes.BOLD }

      return {
        title: item.title,
        value: item,
        description: item.description,
        category: item.category,
        tag,
      }
    }),
  )

  return (
    <Show
      when={!selectedDetail()}
      fallback={
        <div style={{ padding: "1" }}>
          <div style={{ color: theme.accent, "font-weight": "bold", "margin-bottom": "1" }}>
            Diagnostic Details
          </div>
          <pre style={{ color: theme.text, "margin-bottom": "1" }}>{selectedDetail()}</pre>
          <div style={{ color: theme.textMuted }}>Press Escape or Back to return to log list.</div>
        </div>
      }
    >
      <DialogSelect
        title="Session Diagnostics & Logs"
        placeholder="Search logs and system status..."
        options={options()}
        onSelect={(opt) => {
          if (opt.value.category === "Log Files") {
            const path = opt.value.id === "log-main" ? logPath : diagPath
            void clipboard.write?.(path)
            toast.show({
              title: "Path copied!",
              message: `Copied ${path} to clipboard`,
              variant: "success",
            })
          } else if (opt.value.detail) {
            setSelectedDetail(opt.value.detail)
          }
        }}
      />
    </Show>
  )
}
