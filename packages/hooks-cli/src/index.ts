import { Effect } from "effect"

import {
  createCheapDetector,
  validateHostMode,
  type HostRuntime,
  type PipelineResult,
  type PromptRewriteRequest,
  type RewriteMode,
} from "@opencandor/core"

type HookHost = Extract<HostRuntime, "claude-code" | "codex">

export interface HookCliInput {
  readonly host: string
  readonly mode: RewriteMode
  readonly input: string
}

export interface HookCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface HookCliProcessorOptions {
  readonly rewrite?: (request: PromptRewriteRequest) => Promise<PipelineResult>
}

export interface HookCliArgs {
  readonly host: HookHost
  readonly mode: RewriteMode
}

export interface HookHostModelStrategy {
  readonly host: HookHost
  readonly supportsTransparentReplacement: false
  readonly supportsHostModelInvocation: false
  readonly supportedModes: readonly Exclude<RewriteMode, "replace">[]
  readonly reason: string
}

export const getHookHostModelStrategy = (host: HookHost): HookHostModelStrategy => ({
  host,
  supportsTransparentReplacement: false,
  supportsHostModelInvocation: false,
  supportedModes: ["context", "block", "suggest", "dry-run"],
  reason:
    "This host's user-prompt hook cannot invoke the host runtime model or replace the prompt transparently.",
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isHookHost = (host: string): host is HookHost => host === "claude-code" || host === "codex"

const parseFlag = (argv: readonly string[], name: string): string | undefined => {
  const prefix = `--${name}=`
  const inline = argv.find((argument) => argument.startsWith(prefix))
  if (inline !== undefined) {
    return inline.slice(prefix.length)
  }

  const separatedIndex = argv.indexOf(`--${name}`)
  return separatedIndex === -1 ? undefined : argv[separatedIndex + 1]
}

export const parseHookCliArgs = (argv: readonly string[]): HookCliArgs => ({
  host: (parseFlag(argv, "host") ?? "claude-code") as HookHost,
  mode: (parseFlag(argv, "mode") ?? "suggest") as RewriteMode,
})

const readPrompt = (input: string): string => {
  const parsed = JSON.parse(input) as unknown
  if (!isRecord(parsed) || typeof parsed["prompt"] !== "string") {
    throw new Error("Hook input must be JSON with a string prompt field")
  }

  return parsed["prompt"]
}

const formatAdditionalContext = (host: HookHost, additionalContext: string): string =>
  JSON.stringify(
    host === "claude-code"
      ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext,
          },
        }
      : { additionalContext },
  )

const blockOutput = (reason: string): string =>
  JSON.stringify({
    decision: "block",
    reason,
  })

const emptySuccess = (): HookCliResult => ({ exitCode: 0, stdout: "", stderr: "" })

const success = (stdout: string): HookCliResult => ({ exitCode: 0, stdout, stderr: "" })

const failure = (error: unknown): HookCliResult => ({
  exitCode: 1,
  stdout: "",
  stderr: error instanceof Error ? error.message : String(error),
})

const suggestedContext =
  "OpenCandor detected prompt friction but cannot transparently replace prompts from this host hook. Consider revising the prompt before continuing."

const blockReason =
  "OpenCandor blocked this prompt because it matched high-friction rewrite signals. Rephrase it before submitting."

export const createHookCliProcessor = (options: HookCliProcessorOptions = {}) => {
  const detector = createCheapDetector()

  return async ({ host, mode, input }: HookCliInput): Promise<HookCliResult> => {
    try {
      if (!isHookHost(host)) {
        throw new Error(`Unsupported hook host ${host}. Supported hosts: claude-code, codex.`)
      }

      validateHostMode({ host, mode })

      const prompt = readPrompt(input)
      const request: PromptRewriteRequest = { prompt, host, mode }

      if (options.rewrite !== undefined) {
        const result = await options.rewrite(request)
        if (result.outcome === "blocked" || result.action === "block") {
          return success(blockOutput(blockReason))
        }

        if (mode === "dry-run") {
          return emptySuccess()
        }

        if (result.outcome === "rewritten" && result.rewrittenPrompt !== undefined) {
          return success(
            formatAdditionalContext(host, `OpenCandor suggested prompt: ${result.rewrittenPrompt}`),
          )
        }

        return emptySuccess()
      }

      const detection = await Effect.runPromise(detector.detect(request))
      if (!detection.needsRewrite) {
        return emptySuccess()
      }

      if (mode === "dry-run") {
        return emptySuccess()
      }

      if (mode === "block") {
        return success(blockOutput(blockReason))
      }

      return success(formatAdditionalContext(host, suggestedContext))
    } catch (error) {
      return failure(error)
    }
  }
}
