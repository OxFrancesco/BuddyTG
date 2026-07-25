export interface PermissionHookInput {
  readonly session_id: string
  readonly cwd: string
  readonly hook_event_name: "PermissionRequest"
  readonly tool_name: string
  readonly tool_input: unknown
  readonly model?: string
}

export interface PermissionHookDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PermissionRequest"
    readonly decision:
      | { readonly behavior: "allow" }
      | { readonly behavior: "deny"; readonly message: string }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requiredString = (record: Record<string, unknown>, field: string) => {
  const value = record[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Permission hook input is missing ${field}`)
  }
  return value
}

export const parsePermissionHookInput = (value: unknown): PermissionHookInput => {
  if (!isRecord(value)) throw new Error("Permission hook input must be a JSON object")
  const hookEventName = requiredString(value, "hook_event_name")
  if (hookEventName !== "PermissionRequest") {
    throw new Error(`Unsupported hook event: ${hookEventName}`)
  }
  return {
    session_id: requiredString(value, "session_id"),
    cwd: requiredString(value, "cwd"),
    hook_event_name: hookEventName,
    tool_name: requiredString(value, "tool_name"),
    tool_input: value.tool_input,
    ...(typeof value.model === "string" && value.model ? { model: value.model } : {}),
  }
}

const cleanText = (value: string) =>
  value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim()

const inputSummary = (toolInput: unknown) => {
  if (isRecord(toolInput)) {
    const description = toolInput.description
    if (typeof description === "string" && description.trim()) return cleanText(description)
    const command = toolInput.command
    if (typeof command === "string" && command.trim()) return cleanText(command)
  }
  try {
    const serialized = JSON.stringify(toolInput)
    return serialized ? cleanText(serialized) : "No additional details"
  } catch {
    return "No additional details"
  }
}

const basename = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
}

export const formatPermissionQuestion = (input: PermissionHookInput) => {
  const agent = input.model ? "Codex" : "Claude Code"
  const details = inputSummary(input.tool_input)
  const question = [
    `🔐 ${agent} approval request`,
    "",
    `Project: ${basename(input.cwd)}`,
    `Tool: ${cleanText(input.tool_name)}`,
    "",
    details.slice(0, 2_800),
    "",
    "Allow this action?",
  ].join("\n")
  return question.slice(0, 4_000)
}

export const permissionDecisionFor = (
  answer: string,
): PermissionHookDecision | undefined => {
  if (answer === "allow") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    }
  }
  if (answer === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Denied from Telegram.",
        },
      },
    }
  }
  return undefined
}
