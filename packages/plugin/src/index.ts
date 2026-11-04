import type { BunShell } from "./shell.js"
import { tool, type ToolContext, type ToolDefinition } from "./tool.js"

export type { BunShell } from "./shell.js"
export { tool, type ToolContext, type ToolDefinition }

export type Provider = {
  id: string
  name?: string
  models: Record<string, Model>
  options?: Record<string, any>
  [key: string]: any
}

export type Model = {
  id: string
  providerID: string
  name: string
  family?: string
  api: {
    id: string
    url: string
    npm: string
  }
  status?: "alpha" | "beta" | "deprecated" | "active"
  headers: Record<string, string>
  options: Record<string, any>
  cost: {
    input: number
    output: number
    cache: {
      read: number
      write: number
    }
    experimentalOver200K?: {
      input: number
      output: number
      cache: {
        read: number
        write: number
      }
    }
  }
  limit: {
    context: number
    input?: number
    output: number
  }
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    output: {
      text: boolean
      audio: boolean
      image: boolean
      video: boolean
      pdf: boolean
    }
    interleaved?: boolean | { field: "reasoning_content" | "reasoning_details" }
  }
  release_date?: string
  variants?: Record<string, Record<string, any>>
  [key: string]: any
}

export type Config = {
  provider?: Record<string, any>
  disabled_providers?: string[]
  enabled_providers?: string[]
  experimental?: Record<string, any>
  command?: Record<string, { template: string; description: string; agent?: string; model?: string; subtask?: boolean }>
  mcp?: Record<string, any>
  [key: string]: any
}

export type PermissionAction = "ask" | "allow" | "deny"
export type UserMessage = {
  id: string
  sessionID: string
  role: "user"
  agent: string
  model: {
    providerID: string
    modelID: string
    variant?: string
  }
  system?: string
  tools?: Record<string, boolean>
  format?: any
  [key: string]: any
}

export type Part = { id: string; sessionID: string; messageID: string; type: string; [key: string]: any }
export type TextPart = Part & { type: "text"; text: string; synthetic?: boolean; ignored?: boolean; metadata?: Record<string, any> }
export type ReasoningPart = Part & { type: "reasoning"; text: string; metadata?: Record<string, any> }
export type FilePart = Part & { type: "file"; mime: string; filename?: string; url: string; source?: any }
export type ToolPart = Part & { type: "tool"; callID: string; tool: string; state: any; metadata?: Record<string, any> }
export type StepStartPart = Part & { type: "step-start"; snapshot?: string }
export type StepFinishPart = Part & { type: "step-finish"; reason: string; snapshot?: string; cost: number; tokens: any }
export type SnapshotPart = Part & { type: "snapshot"; snapshot: string }
export type PatchPart = Part & { type: "patch"; hash: string; files: string[] }
export type AgentPart = Part & { type: "agent"; name: string; source?: { value: string; start: number; end: number } }
export type RetryPart = Part & { type: "retry"; attempt: number; error: any; time: { created: number } }
export type CompactionPart = Part & { type: "compaction"; auto: boolean; overflow?: boolean }
export type SubtaskPart = Part & { type: "subtask"; prompt: string; description: string; agent: string; model?: { providerID: string; modelID: string }; command?: string }
export type Event = { type: string; properties: Record<string, any> }

export type PluginInput = {
  client: any
  project: any
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
  experimental_workspace?: any
}

export type Plugin = (input: PluginInput) => Promise<Hooks>

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<any>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{ label: string; value: string; hint?: string }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOuathResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              condition?: (inputs: Record<string, string>) => boolean
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{ label: string; value: string; hint?: string }>
              condition?: (inputs: Record<string, string>) => boolean
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOuathResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: Provider; message: UserMessage },
    output: { temperature: number; topP: number; topK: number; options: Record<string, any> },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: Provider; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: any, output: { status: PermissionAction }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: { title: string; output: string; metadata: any },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: any
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model; [key: string]: any },
    output: { system: string[] },
  ) => Promise<void>
  dispose?: () => Promise<void>
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  "tool.definition"?: (
    input: { toolID: string },
    output: { description: string; parameters: any },
  ) => Promise<void>
}
