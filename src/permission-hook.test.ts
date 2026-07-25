import { describe, expect, test } from "bun:test"
import {
  formatPermissionQuestion,
  parsePermissionHookInput,
  permissionDecisionFor,
} from "./permission-hook"

describe("permission hook", () => {
  test("formats Codex approval input for Telegram", () => {
    const input = parsePermissionHookInput({
      session_id: "session-1",
      cwd: "/code/BuddyTG",
      hook_event_name: "PermissionRequest",
      model: "gpt-5",
      tool_name: "Bash",
      tool_input: {
        command: "git push origin main",
        description: "Push the validated branch",
      },
    })

    expect(formatPermissionQuestion(input)).toContain("Codex approval request")
    expect(formatPermissionQuestion(input)).toContain("Project: BuddyTG")
    expect(formatPermissionQuestion(input)).toContain("Push the validated branch")
  })

  test("formats Claude Code input when no Codex model field is present", () => {
    const input = parsePermissionHookInput({
      session_id: "session-2",
      cwd: "/code/app",
      hook_event_name: "PermissionRequest",
      tool_name: "Write",
      tool_input: { file_path: "/code/app/index.ts" },
    })

    expect(formatPermissionQuestion(input)).toContain("Claude Code approval request")
  })

  test("returns the shared PermissionRequest decision shape", () => {
    expect(permissionDecisionFor("allow")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    })
    expect(permissionDecisionFor("deny")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "Denied from Telegram.",
        },
      },
    })
    expect(permissionDecisionFor("later")).toBeUndefined()
  })
})
