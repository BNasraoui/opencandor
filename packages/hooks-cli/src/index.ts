import type { HostRuntime, RewriteMode } from "@opencandor/core"

export interface HookHostModelStrategy {
  readonly host: Extract<HostRuntime, "claude-code" | "codex">
  readonly supportsTransparentReplacement: false
  readonly supportsHostModelInvocation: false
  readonly supportedModes: readonly Exclude<RewriteMode, "replace">[]
  readonly reason: string
}

export const getHookHostModelStrategy = (
  host: Extract<HostRuntime, "claude-code" | "codex">,
): HookHostModelStrategy => ({
  host,
  supportsTransparentReplacement: false,
  supportsHostModelInvocation: false,
  supportedModes: ["context", "block", "suggest", "dry-run"],
  reason:
    "This host's user-prompt hook cannot invoke the host runtime model or replace the prompt transparently.",
})
