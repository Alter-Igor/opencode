import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"

export interface ServiceToggle {
  id: string
  name: string
  icon: string
  description: string
  enabled: boolean
  status: "connected" | "needs_auth"
}

const [servicesState] = createSignal<Record<string, boolean>>({
  m365: true,
  rag: true,
  imprint: true,
  cas: true,
  integrations: true,
  browser: false,
})

export function isKeystoneServiceEnabled(serviceId: string): boolean {
  return servicesState()[serviceId] !== false
}

export function KeystoneServicesPanel() {
  const data = useData()
  const location = useLocation()
  const theme = useTheme()

  const services = createMemo((): ServiceToggle[] => {
    const current = location.ref ?? data.location.default()
    const servers = data.location.mcp.server.list(current) ?? []
    const kd = servers.find((s) => s.name === "keystone-dynamic")
    const isKdConnected = kd?.status.status === "connected"
    const state = servicesState()

    return [
      {
        id: "m365",
        name: "Microsoft 365",
        icon: "📧",
        description: "Outlook email, calendar, Teams, and SharePoint",
        enabled: state["m365"] !== false,
        status: isKdConnected ? "connected" : "needs_auth",
      },
      {
        id: "rag",
        name: "Alterspective RAG",
        icon: "🧠",
        description: "Canonical operating rules, policies, and verified skills",
        enabled: state["rag"] !== false,
        status: isKdConnected ? "connected" : "needs_auth",
      },
      {
        id: "imprint",
        name: "Imprint Voice",
        icon: "🗣️",
        description: "User natural communication and reply preferences",
        enabled: state["imprint"] !== false,
        status: isKdConnected ? "connected" : "needs_auth",
      },
      {
        id: "cas",
        name: "CAS Agent Hub",
        icon: "🤖",
        description: "Central Agent Service task queue & subagent delegation",
        enabled: state["cas"] !== false,
        status: isKdConnected ? "connected" : "needs_auth",
      },
      {
        id: "integrations",
        name: "Jira / Monday / CRM",
        icon: "📋",
        description: "External work tracking and project governance tools",
        enabled: state["integrations"] !== false,
        status: isKdConnected ? "connected" : "needs_auth",
      },
      {
        id: "browser",
        name: "Web Scraping",
        icon: "🌐",
        description: "Playwright raw browser automation (non-corporate)",
        enabled: state["browser"] === true,
        status: "connected",
      },
    ]
  })

  return (
    <box flexDirection="column" gap={1} marginTop={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Keystone Governance
        </text>
        <text fg={theme.text.muted}>
          {services().filter((s) => s.enabled).length}/{services().length} active
        </text>
      </box>

      <box
        flexDirection="column"
        borderStyle="single"
        borderColor={theme.border.base}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
        gap={0}
      >
        <For each={services()}>
          {(service) => (
            <box
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              paddingTop={0}
              paddingBottom={0}
            >
              <box flexDirection="row" gap={1} alignItems="center">
                <text fg={theme.text.base}>{service.icon}</text>
                <text fg={service.enabled ? theme.text.base : theme.text.muted}>{service.name}</text>
              </box>
              <box flexDirection="row" gap={1} alignItems="center">
                <Show when={service.status === "needs_auth"}>
                  <text fg={theme.text.feedback.warning.base}>⚡</text>
                </Show>
                <text
                  fg={service.enabled ? theme.text.feedback.success.base : theme.text.muted}
                  attributes={service.enabled ? TextAttributes.BOLD : undefined}
                >
                  {service.enabled ? "[ON]" : "[OFF]"}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
      <text fg={theme.text.muted}>Turn off any system to strictly block AI access in this session.</text>
    </box>
  )
}
