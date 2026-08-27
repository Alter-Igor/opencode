import { createMemo, createSignal, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect, type DialogSelectRef, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"
import { DialogKeystone } from "./dialog-keystone"

function Status(props: { enabled: boolean; loading: boolean; status?: string; name?: string }) {
  const { theme } = useTheme()
  if (props.loading) {
    return <span style={{ fg: theme.textMuted }}>⋯ Loading</span>
  }
  if (props.status === "needs_auth" || props.status === "needs_client_registration") {
    return <span style={{ fg: theme.warning, attributes: TextAttributes.BOLD }}>⚡ Needs Auth (Enter to sign in)</span>
  }
  if (props.status === "failed") {
    return <span style={{ fg: theme.error }}>✕ Failed</span>
  }
  if (props.name === "keystone-dynamic") {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled (Enter to view tools)</span>
  }
  if (props.enabled) {
    return <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Enabled</span>
  }
  return <span style={{ fg: theme.textMuted }}>○ Disabled</span>
}

export function DialogMcp() {
  const local = useLocal()
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const [, setRef] = createSignal<DialogSelectRef<unknown>>()
  const [loading, setLoading] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const status = await sdk.client.mcp.status()
      if (status.data) {
        sync.set("mcp", status.data)
      }
    } catch (err) {
      console.error("Failed to refresh MCP status in dialog:", err)
    }
  })

  const options = createMemo(() => {
    const mcpData = (sync.data.mcp ?? {}) as Record<string, { status: string }>
    const configMcp = (sync.data.config?.mcp ?? {}) as Record<string, unknown>
    const allKeys = Array.from(new Set([...Object.keys(configMcp), ...Object.keys(mcpData)]))
    const loadingMcp = loading()

    return pipe(
      allKeys,
      sortBy((name) => name),
      map((name) => {
        const serverStatus = mcpData[name] ?? { status: "connecting" }
        return {
          value: name,
          title: name,
          description: serverStatus.status === "failed" ? "failed" : serverStatus.status,
          footer: (
            <Status
              enabled={local.mcp.isEnabled(name)}
              loading={loadingMcp === name}
              status={serverStatus.status}
              name={name}
            />
          ),
          category: undefined,
        }
      }),
    )
  })

  const actions = createMemo(() => [
    {
      command: "dialog.mcp.toggle",
      title: "toggle",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== null) return

        setLoading(option.value)
        try {
          await local.mcp.toggle(option.value)
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          }
        } catch (error) {
          console.error("Failed to toggle MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
    {
      command: "dialog.mcp.auth",
      title: "sign in",
      onTrigger: async (option: DialogSelectOption<string>) => {
        if (loading() !== null) return
        setLoading(option.value)
        try {
          await sdk.client.mcp.auth.authenticate({ name: option.value })
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
          }
        } catch (error) {
          console.error("Failed to authenticate MCP:", error)
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      ref={setRef}
      title="MCPs"
      options={options()}
      actions={actions()}
      onSelect={async (option) => {
        if (!option) return
        if (option.value === "keystone-dynamic") {
          const serverStatus = sync.data.mcp[option.value]
          if (serverStatus?.status === "needs_auth" || serverStatus?.status === "needs_client_registration") {
            setLoading(option.value)
            try {
              await sdk.client.mcp.auth.authenticate({ name: option.value })
              const status = await sdk.client.mcp.status()
              if (status.data) {
                sync.set("mcp", status.data)
              }
            } catch (error) {
              console.error("Failed to authenticate MCP:", error)
            } finally {
              setLoading(null)
            }
            return
          }
          dialog.replace(() => <DialogKeystone />)
          return
        }

        const serverStatus = sync.data.mcp[option.value]
        if (serverStatus?.status === "needs_auth" || serverStatus?.status === "needs_client_registration") {
          setLoading(option.value)
          try {
            await sdk.client.mcp.auth.authenticate({ name: option.value })
            const status = await sdk.client.mcp.status()
            if (status.data) {
              sync.set("mcp", status.data)
            }
          } catch (error) {
            console.error("Failed to authenticate MCP:", error)
          } finally {
            setLoading(null)
          }
        }
      }}
    />
  )
}
