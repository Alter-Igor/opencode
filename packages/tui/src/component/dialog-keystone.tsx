import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "../context/sync"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import { useSDK } from "../context/sdk"

import { isKeystoneServiceEnabled } from "./keystone-services-panel"

export interface KeystoneToolInfo {
  name: string
  serviceId: string
  title: string
  description: string
  category: string
  status: "connected" | "needs_auth" | "disabled"
  serviceUrl?: string
}

export function DialogKeystone() {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [loading, setLoading] = createSignal<string | null>(null)
  const [keystoneConnected, setKeystoneConnected] = createSignal(true)

  onMount(async () => {
    try {
      const status = await sdk.client.mcp.status()
      if (status.data) {
        sync.set("mcp", status.data)
        const kd = (status.data as Record<string, { status?: string } | undefined>)["keystone-dynamic"]
        setKeystoneConnected(kd?.status === "connected")
      }
    } catch {}
  })

  const keystoneTools: KeystoneToolInfo[] = [
    // Microsoft 365
    {
      name: "mail_search",
      serviceId: "m365",
      title: "Search Outlook Emails",
      description: "Search messages across inbox, sent, and folders by keyword or sender",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "mail_get_message",
      serviceId: "m365",
      title: "Read Email Message",
      description: "Fetch full email body, recipient headers, and attachments",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "mail_send",
      serviceId: "m365",
      title: "Send Outlook Email",
      description: "Draft or send an email through user's delegated M365 account",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "calendar_list_events",
      serviceId: "m365",
      title: "View Calendar Events",
      description: "Check schedule, meetings, and availability in Outlook Calendar",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "calendar_create_event",
      serviceId: "m365",
      title: "Schedule Meeting",
      description: "Create a new meeting or calendar event with attendees",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "teams_list_messages",
      serviceId: "m365",
      title: "Teams Chats & Channels",
      description: "Read Teams channel discussions and direct messages",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },
    {
      name: "files_search",
      serviceId: "m365",
      title: "OneDrive & SharePoint Files",
      description: "Search and read files across corporate OneDrive and SharePoint sites",
      category: "Microsoft 365 (via Keystone)",
      status: "connected",
    },

    // Alterspective Corporate Services
    {
      name: "rag_search",
      serviceId: "rag",
      title: "Alterspective Canonical RAG",
      description: "Search internal company standards, operating rules, and verified skills",
      category: "Alterspective Services (via Keystone)",
      status: "connected",
    },
    {
      name: "rag_ask",
      serviceId: "rag",
      title: "Semantic Knowledge Q&A",
      description: "Ask natural language questions against Alterspective knowledge corpus",
      category: "Alterspective Services (via Keystone)",
      status: "connected",
    },
    {
      name: "imprint_voice",
      serviceId: "imprint",
      title: "Imprint Voice & Style Profile",
      description: "Load user communication preferences and natural writing style",
      category: "Alterspective Services (via Keystone)",
      status: "connected",
    },
    {
      name: "cas_agent_hub",
      serviceId: "cas",
      title: "Central Agent Service (CAS)",
      description: "Autonomous task queue, subagent coordination, and multi-agent hub",
      category: "Alterspective Services (via Keystone)",
      status: "connected",
    },

    // External Credential Providers
    {
      name: "cred_jira",
      serviceId: "integrations",
      title: "Jira / Confluence Gateway",
      description: "Atlassian issue tracking and project documentation",
      category: "Connected Integrations (via Keystone)",
      status: "connected",
      serviceUrl: "https://identity.alterspective.com.au/credentials/connect?provider=jira",
    },
    {
      name: "cred_monday",
      serviceId: "integrations",
      title: "Monday.com Work OS",
      description: "Boards, items, and company operational project tracking",
      category: "Connected Integrations (via Keystone)",
      status: "connected",
      serviceUrl: "https://identity.alterspective.com.au/credentials/connect?provider=monday",
    },
    {
      name: "cred_github",
      serviceId: "integrations",
      title: "GitHub Organization Access",
      description: "Repository access, issues, and PR management governance",
      category: "Connected Integrations (via Keystone)",
      status: "connected",
      serviceUrl: "https://identity.alterspective.com.au/credentials/connect?provider=github",
    },
  ]

  const options = createMemo(() => {
    const isKDConnected = keystoneConnected()
    return keystoneTools.map((t) => {
      const isEnabled = isKeystoneServiceEnabled(t.serviceId)
      return {
        value: t.name,
        title: t.title,
        description: t.description,
        category: t.category,
        footer: !isEnabled ? (
          <span style={{ fg: theme.textMuted }}>○ Disabled by User</span>
        ) : isKDConnected ? (
          <span style={{ fg: theme.success, attributes: TextAttributes.BOLD }}>✓ Connected [ON]</span>
        ) : (
          <span style={{ fg: theme.warning, attributes: TextAttributes.BOLD }}>⚡ Needs Sign-In</span>
        ),
      }
    })
  })

  const actions = createMemo(() => [
    {
      command: "dialog.keystone.reconnect",
      title: "connect / re-authenticate",
      onTrigger: async (option: DialogSelectOption<string>) => {
        setLoading(option.value)
        try {
          await sdk.client.mcp.auth.authenticate({ name: "keystone-dynamic" })
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
            const kd = (status.data as Record<string, { status?: string } | undefined>)["keystone-dynamic"]
            setKeystoneConnected(kd?.status === "connected")
          }
        } catch (err) {
          console.error("Failed to authenticate Keystone:", err)
        } finally {
          setLoading(null)
        }
      },
    },
  ])

  return (
    <DialogSelect
      title="Keystone Dynamic Gateway — Connected Tools & Services"
      options={options()}
      actions={actions()}
      onSelect={async (option) => {
        if (!option) return
        setLoading(option.value)
        try {
          await sdk.client.mcp.auth.authenticate({ name: "keystone-dynamic" })
          const status = await sdk.client.mcp.status()
          if (status.data) {
            sync.set("mcp", status.data)
            const kd = (status.data as Record<string, { status?: string } | undefined>)["keystone-dynamic"]
            setKeystoneConnected(kd?.status === "connected")
          }
        } catch (err) {
          console.error("Failed to connect via Keystone:", err)
        } finally {
          setLoading(null)
        }
      }}
    />
  )
}
