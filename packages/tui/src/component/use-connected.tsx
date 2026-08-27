import { createMemo } from "solid-js"
import { useSync } from "../context/sync"

export function useConnected() {
  const sync = useSync()
  return createMemo(() => {
    const hasConfigured = Object.keys(sync.data.config?.provider ?? {}).length > 0
    return (
      hasConfigured ||
      sync.data.provider.some(
        (provider) =>
          provider.id !== "opencode" || Object.values(provider.models).some((model) => model.cost?.input !== 0),
      )
    )
  })
}
