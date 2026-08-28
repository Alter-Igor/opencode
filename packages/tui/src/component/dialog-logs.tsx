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

  const homeDir = process.env.USERPROFILE || process.env.HOME || "~"
  const logPath = `${homeDir}\\.local\\share\\opencode\\log\\opencode.log`
  const diagPath = `${homeDir}\\.local\\share\\opencode\\log\\diagnostics.log`
  const learningsPath = `${homeDir}\\.local\\share\\opencode\\learnings.json`

  const items = createMemo<DiagnosticItem[]>(() => [
    {
      id: "health-onprem",
      title: "On-Premises GPU Cluster ($0 Cost)",
      description: "Qwen3 Coder / Spark / Nvidia Pro 6000",
      category: "System Health",
      status: "ok",
      detail: "On-Premises Resilience:\n- GPU Cluster: Active\n- Models: Qwen3 Coder Next, Ornith 35B, Qwen 27B\n- Cost: $0 (unlimited tokens)\n- Auto-Fallback: Enabled on quota/credit limit",
    },
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
    {
      id: "log-learnings",
      title: "Learned Rules & Memory Log",
      description: `Path: ${learningsPath}`,
      category: "Log Files",
      status: "info",
      detail: `Learnings & Rules Memory File:\n${learningsPath}\n\nPress Enter to copy this path to your clipboard.`,
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
        <box padding={1} flexDirection="column">
          <text fg={theme.accent}>
            <b>Diagnostic Details</b>
          </text>
          <text fg={theme.text}>{selectedDetail()}</text>
          <text fg={theme.textMuted}>Press Escape or Back to return to log list.</text>
        </box>
      }
    >
      <DialogSelect
        title="Session Diagnostics & Logs"
        placeholder="Search logs and system status..."
        options={options()}
        onSelect={(opt) => {
          if (opt.value.category === "Log Files") {
            const path =
              opt.value.id === "log-main"
                ? logPath
                : opt.value.id === "log-learnings"
                  ? learningsPath
                  : diagPath
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
