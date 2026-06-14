import { describe, expect, test } from "vitest"

import { createHookCliProcessor, getHookHostModelStrategy, parseHookCliArgs } from "./index.js"

describe("hook host model strategy", () => {
  test.each(["claude-code", "codex"] as const)(
    "%s reports honest hook-time model and replacement limitations",
    (host) => {
      expect(getHookHostModelStrategy(host)).toEqual({
        host,
        supportsTransparentReplacement: false,
        supportsHostModelInvocation: false,
        supportedModes: ["context", "block", "suggest", "dry-run"],
        reason:
          "This host's user-prompt hook cannot invoke the host runtime model or replace the prompt transparently.",
      })
    },
  )
})

describe("hook CLI processor", () => {
  test("emits Claude Code additionalContext for suggest mode without replacing the prompt", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({
      host: "claude-code",
      mode: "suggest",
      input: JSON.stringify({ prompt: "Fix this stupid auth test." }),
    })

    expect(result).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext:
            "OpenCandor detected prompt friction but cannot transparently replace prompts from this host hook. Consider revising the prompt before continuing.",
        },
      }),
      stderr: "",
    })
  })

  test("blocks high-friction prompts in block mode", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({
      host: "codex",
      mode: "block",
      input: JSON.stringify({ prompt: "Fix this trash right now." }),
    })

    expect(result).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        decision: "block",
        reason:
          "OpenCandor blocked this prompt because it matched high-friction rewrite signals. Rephrase it before submitting.",
      }),
      stderr: "",
    })
  })

  test("rejects transparent replacement for hook-only hosts", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({
      host: "claude-code",
      mode: "replace",
      input: JSON.stringify({ prompt: "Fix this stupid test." }),
    })

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "Mode replace is not supported for host claude-code. Supported modes: context, block, suggest, dry-run.",
    })
  })

  test("rejects unsupported hook hosts instead of emitting Codex-shaped output", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({
      host: "opencode",
      mode: "suggest",
      input: JSON.stringify({ prompt: "Fix this stupid test." }),
    })

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Unsupported hook host opencode. Supported hosts: claude-code, codex.",
    })
  })

  test("does not affect host context in dry-run mode", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({
      host: "codex",
      mode: "dry-run",
      input: JSON.stringify({ prompt: "Fix this stupid test." }),
    })

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  test("uses an injected core pipeline when model invocation is available", async () => {
    const processHook = createHookCliProcessor({
      rewrite: (request) =>
        Promise.resolve({
          action: request.mode,
          outcome: "rewritten",
          originalPrompt: request.prompt,
          rewrittenPrompt: "Please fix the auth test.",
          preservedIntent: "fix auth test",
          confidence: 0.91,
          risk: "low",
          safetyFlags: [],
          validationIssues: [],
        }),
    })

    const result = await processHook({
      host: "codex",
      mode: "context",
      input: JSON.stringify({ prompt: "Fix this stupid auth test." }),
    })

    expect(result).toEqual({
      exitCode: 0,
      stdout: JSON.stringify({
        additionalContext: "OpenCandor suggested prompt: Please fix the auth test.",
      }),
      stderr: "",
    })
  })

  test("reports malformed hook input clearly", async () => {
    const processHook = createHookCliProcessor()

    const result = await processHook({ host: "codex", mode: "suggest", input: "{}" })

    expect(result).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Hook input must be JSON with a string prompt field",
    })
  })
})

describe("hook CLI argument parsing", () => {
  test("supports equals and separated flag values", () => {
    expect(
      parseHookCliArgs(["node", "opencandor-hook", "--host=codex", "--mode", "block"]),
    ).toEqual({
      host: "codex",
      mode: "block",
    })
  })

  test("defaults to Claude Code suggest mode", () => {
    expect(parseHookCliArgs(["node", "opencandor-hook"])).toEqual({
      host: "claude-code",
      mode: "suggest",
    })
  })
})
