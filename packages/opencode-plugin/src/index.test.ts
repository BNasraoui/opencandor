import { Effect } from "effect"
import { describe, expect, test } from "vitest"

import { createOpenCodeModelServices, createOpenCodeSessionHostModelClient } from "./index.js"

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
