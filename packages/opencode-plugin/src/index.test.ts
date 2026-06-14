import { Effect } from "effect"
import { describe, expect, test } from "vitest"

import {
  OpenCandorPlugin,
  createOpenCodeModelServices,
  createOpenCodePromptTransformer,
  createOpenCodeSessionHostModelClient,
} from "./index.js"

describe("OpenCode host model services", () => {
  test("invokes classifier and rewriter models through a host-supplied model client", async () => {
    const calls: { model: string; prompt: string; system: string }[] = []
    const services = createOpenCodeModelServices(
      {
        classifierModel: "github-copilot/gpt-5.1-mini",
        rewriterModel: "github-copilot/gpt-5.1",
      },
      {
        generate: (input) =>
          Effect.sync(() => {
            calls.push({ model: input.model, prompt: input.prompt, system: input.system })

            return JSON.stringify({
              shouldRewrite: true,
              risk: "medium",
              safetyFlags: ["high-friction"],
              confidence: 0.87,
              rewrittenPrompt: "Please fix the failing auth test and preserve its assertions.",
              preservedIntent: "fix failing auth test and preserve assertions",
              lossSignals: [],
              uncertainty: [],
            })
          }),
      },
    )

    const request = {
      prompt: "Fix this stupid auth test but do not change its assertions.",
      host: "opencode",
      mode: "replace",
    } as const
    const classification = await Effect.runPromise(services.classifier.classify(request))
    const draft = await Effect.runPromise(services.rewriter.rewrite(request, classification))

    expect(classification).toEqual({
      shouldRewrite: true,
      risk: "medium",
      safetyFlags: ["high-friction"],
      confidence: 0.87,
      preservedIntent: "fix failing auth test and preserve assertions",
    })
    expect(draft).toEqual({
      rewrittenPrompt: "Please fix the failing auth test and preserve its assertions.",
      preservedIntent: "fix failing auth test and preserve assertions",
      uncertainty: [],
    })
    expect(calls.map((call) => call.model)).toEqual([
      "github-copilot/gpt-5.1-mini",
      "github-copilot/gpt-5.1",
    ])
    expect(calls[0]?.prompt).toContain(request.prompt)
    expect(calls[0]?.system).toContain("promptRewriteModelOutputSchema")
    expect(calls[0]?.system).toContain("rewrittenPrompt")
  })

  test("adapts OpenCode session.prompt into a host model client", async () => {
    const calls: unknown[] = []
    const client = createOpenCodeSessionHostModelClient({
      modelSessionID: "session-123",
      client: {
        session: {
          prompt: (input) => {
            calls.push(input)

            return Promise.resolve({
              parts: [
                { type: "tool", id: "ignored" },
                { type: "text", text: '{"shouldRewrite":false}' },
              ],
            })
          },
        },
      },
    })

    const output = await Effect.runPromise(
      client.generate({
        model: "github-copilot/gpt-5.1",
        system: "Return JSON only.",
        prompt: "Classify this prompt.",
      }),
    )

    expect(output).toBe('{"shouldRewrite":false}')
    expect(calls).toEqual([
      {
        path: { id: "session-123" },
        body: {
          model: { providerID: "github-copilot", modelID: "gpt-5.1" },
          system: "Return JSON only.",
          tools: {},
          parts: [{ type: "text", text: "Classify this prompt." }],
        },
      },
    ])
  })
})

describe("OpenCode prompt transformer", () => {
  const rewrittenModelOutput = JSON.stringify({
    shouldRewrite: true,
    risk: "medium",
    safetyFlags: ["high-friction"],
    confidence: 0.87,
    rewrittenPrompt: "Please fix the auth test while preserving its assertions.",
    preservedIntent: "fix auth test while preserving assertions",
    lossSignals: [],
    uncertainty: [],
  })

  test("replaces prompt text through the core pipeline when replace mode is enabled", async () => {
    const decisions: unknown[] = []
    const transformer = createOpenCodePromptTransformer({
      config: {
        mode: "replace",
        classifierModel: "github-copilot/gpt-5.1-mini",
        rewriterModel: "github-copilot/gpt-5.1",
      },
      modelClient: {
        generate: () => Effect.succeed(rewrittenModelOutput),
      },
      logDecision: (decision) => {
        decisions.push(decision)
      },
    })

    const result = await Effect.runPromise(
      transformer({ prompt: "Fix this stupid auth test but do not change its assertions." }),
    )

    expect(result.prompt).toBe("Please fix the auth test while preserving its assertions.")
    expect(result.decision).toMatchObject({
      action: "replace",
      outcome: "rewritten",
      confidence: 0.87,
      risk: "medium",
    })
    expect(decisions).toEqual([
      {
        action: "replace",
        outcome: "rewritten",
        confidence: 0.87,
        risk: "medium",
        safetyFlags: ["high-friction"],
        validationIssues: [],
      },
    ])
    expect(JSON.stringify(decisions)).not.toContain("stupid auth test")
  })

  test("leaves prompt text unchanged when configured for dry-run mode", async () => {
    const transformer = createOpenCodePromptTransformer({
      config: {
        mode: "dry-run",
        classifierModel: "github-copilot/gpt-5.1-mini",
        rewriterModel: "github-copilot/gpt-5.1",
      },
      modelClient: {
        generate: () => Effect.succeed(rewrittenModelOutput),
      },
    })

    const result = await Effect.runPromise(transformer({ prompt: "Fix this stupid auth test." }))

    expect(result.prompt).toBe("Fix this stupid auth test.")
    expect(result.decision).toMatchObject({ action: "dry-run", outcome: "rewritten" })
  })

  test("still returns transformed text when decision logging fails", async () => {
    const transformer = createOpenCodePromptTransformer({
      config: {
        mode: "replace",
        classifierModel: "github-copilot/gpt-5.1-mini",
        rewriterModel: "github-copilot/gpt-5.1",
      },
      modelClient: {
        generate: () => Effect.succeed(rewrittenModelOutput),
      },
      logDecision: () => Promise.reject(new Error("log unavailable")),
    })

    const result = await Effect.runPromise(transformer({ prompt: "Fix this stupid auth test." }))

    expect(result.prompt).toBe("Please fix the auth test while preserving its assertions.")
  })
})

describe("OpenCandor OpenCode plugin", () => {
  const createPluginClient = () => ({
    app: { log: () => Promise.resolve() },
    session: {
      prompt: () =>
        Promise.resolve({
          parts: [
            {
              type: "text",
              text: JSON.stringify({
                shouldRewrite: true,
                risk: "low",
                safetyFlags: [],
                confidence: 0.93,
                rewrittenPrompt: "Please fix the test.",
                preservedIntent: "fix the test",
                lossSignals: [],
                uncertainty: [],
              }),
            },
          ],
        }),
    },
  })

  test("exports a loadable plugin that transforms top-level chat message text parts", async () => {
    const plugin = OpenCandorPlugin({
      client: createPluginClient(),
      config: {
        opencandor: {
          mode: "replace",
          classifierModel: "github-copilot/gpt-5.1-mini",
          rewriterModel: "github-copilot/gpt-5.1",
          modelSessionID: "opencandor-model-session",
        },
      },
    })
    const output = { parts: [{ type: "text" as const, text: "Fix this stupid test." }] }

    await plugin["chat.message"]({ sessionID: "active-session" }, output)

    expect(output.parts).toEqual([{ type: "text", text: "Please fix the test." }])
  })

  test("does not transform the private model session used for host model calls", async () => {
    const plugin = OpenCandorPlugin({
      client: createPluginClient(),
      config: {
        opencandor: {
          mode: "replace",
          classifierModel: "github-copilot/gpt-5.1-mini",
          rewriterModel: "github-copilot/gpt-5.1",
          modelSessionID: "opencandor-model-session",
        },
      },
    })
    const output = { parts: [{ type: "text" as const, text: "Fix this stupid test." }] }

    await plugin["chat.message"]({ sessionID: "opencandor-model-session" }, output)

    expect(output.parts).toEqual([{ type: "text", text: "Fix this stupid test." }])
  })

  test("accepts OpenCode package options as plugin configuration", async () => {
    const plugin = OpenCandorPlugin(
      { client: createPluginClient() },
      {
        mode: "replace",
        classifierModel: "github-copilot/gpt-5.1-mini",
        rewriterModel: "github-copilot/gpt-5.1",
        modelSessionID: "opencandor-model-session",
      },
    )
    const output = { parts: [{ type: "text" as const, text: "Fix this stupid test." }] }

    await plugin["chat.message"]({ sessionID: "active-session" }, output)

    expect(output.parts).toEqual([{ type: "text", text: "Please fix the test." }])
  })

  test("falls back to content when top-level parts have no text", async () => {
    const plugin = OpenCandorPlugin({
      client: createPluginClient(),
      config: {
        opencandor: {
          mode: "replace",
          classifierModel: "github-copilot/gpt-5.1-mini",
          rewriterModel: "github-copilot/gpt-5.1",
        },
      },
    })
    const output = { parts: [{ type: "tool" }], content: "Fix this stupid test." }

    await plugin["chat.message"]({ sessionID: "active-session" }, output)

    expect(output.content).toBe("Please fix the test.")
  })
})
