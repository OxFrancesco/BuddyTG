import { Predicate, Schema } from "effect"

/** Telegram allows 4096 characters per message; keep a margin. */
export const MAX_PERMISSION_QUESTION_LENGTH = 4_000

const required = (field: string) => <S extends Schema.Top>(self: S) =>
  Schema.annotateKey<S>({ messageMissingKey: `Permission hook input is missing ${field}` })(self)
const NonBlank = Schema.String.check(Schema.isPattern(/\S/, { message: "must not be blank" }))

// Struct order is the order errors are reported in: the event name comes first.
export const PermissionHookInput = Schema.Struct({
  hook_event_name: Schema.Literal("PermissionRequest").pipe(required("hook_event_name")),
  session_id: NonBlank.pipe(required("session_id")),
  cwd: NonBlank.pipe(required("cwd")),
  tool_name: NonBlank.pipe(required("tool_name")),
  tool_input: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.Unknown),
})
export type PermissionHookInput = typeof PermissionHookInput.Type

export const parsePermissionHookInput = Schema.decodeUnknownSync(PermissionHookInput)
export const decodePermissionHookInput = Schema.decodeUnknownEffect(Schema.fromJsonString(PermissionHookInput))

export interface PermissionHookDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PermissionRequest"
    readonly decision:
      | { readonly behavior: "allow" }
      | { readonly behavior: "deny"; readonly message: string }
  }
}

/**
 * Make every invisible, blank-looking or direction-changing code point visible, so
 * the text the owner reads is the text that runs. Line feeds and plain spaces stay;
 * everything else becomes \u{…}. Long blank runs, which can push a payload out of
 * view, become a visible count.
 */
export const revealText = (value: string) =>
  value
    .replace(
      /(?![\n ])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u115f\u1160\u2800\u3164\uffa0]/gu,
      (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`,
    )
    .replace(/\n{3,}/g, (run) => `\n⟨${run.length - 1} blank lines⟩\n`)
    .replace(/ {16,}/g, (run) => `⟨${run.length} spaces⟩`)

/** One-line variant for names and paths: line feeds are shown as \n too. */
export const revealLine = (value: string) => revealText(value).replace(/\n/g, "\\n")

const json = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined"
  } catch {
    return "(input could not be serialized)"
  }
}

/**
 * The full action, never a summary: for shell tools the exact command plus every
 * other argument; for anything else the whole input. A model-written description
 * is shown only as a labeled extra, because the model also writes the command.
 */
const describeToolInput = (toolInput: unknown) => {
  if (Predicate.isObject(toolInput) && Predicate.isString(toolInput.command)) {
    const { command, description, ...others } = toolInput
    // Only a string description is shown as one; anything else stays with the other input.
    const rest = Predicate.isString(description) || description === undefined ? others : { ...others, description }
    const lines = ["Command:", revealText(command) || "(empty)"]
    if (Object.keys(rest).length > 0) lines.push("", `Other input: ${revealText(json(rest))}`)
    if (Predicate.isString(description) && description.trim()) {
      lines.push("", `Agent's description (unverified): ${revealLine(description)}`)
    }
    return lines.join("\n")
  }
  return `Input:\n${revealText(json(toolInput))}`
}

const basename = (path: string) => {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "")
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized
}

const agentName = (input: PermissionHookInput) => (input.model ? "Codex" : "Claude Code")

const header = (input: PermissionHookInput) => [
  `🔐 ${agentName(input)} approval request`,
  "",
  `Project: ${revealLine(basename(input.cwd))}`,
  `Tool: ${revealLine(input.tool_name)}`,
]

/** The complete approval text. It is never truncated; check its length before sending. */
export const formatPermissionQuestion = (input: PermissionHookInput) =>
  [...header(input), "", describeToolInput(input.tool_input), "", "Allow this action?"].join("\n")

/** Sent without buttons when the full request does not fit in one Telegram message. */
export const formatTooLongNotice = (input: PermissionHookInput, length: number) =>
  [
    ...header(input),
    "",
    `This request is ${length} characters, too long to show in full here.`,
    "Answer it on your computer.",
  ].join("\n")

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
