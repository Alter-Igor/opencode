// MOD-04 interaction tools (oc_pending, oc_answer, oc_post, oc_inbox). Owned by the Wave 3
// interaction build; the server registers whatever this list exports.
import type { z } from "zod"
import type { ToolSpec } from "./define.ts"

export const interactionTools: Array<ToolSpec<z.ZodRawShape>> = []
