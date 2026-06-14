import type { PromptRewriteRequest } from "../../packages/core/src/index.js"

export interface RewriteDetectorFixture {
  readonly name: string
  readonly request: PromptRewriteRequest
  readonly expectedNeedsRewrite: boolean
  readonly expectedSignals: readonly string[]
}

export const rewriteDetectorFixtures: readonly RewriteDetectorFixture[] = [
  {
    name: "neutral implementation request",
    request: {
      prompt: "Please add unit tests for the checkout total calculation.",
      host: "opencode",
      mode: "replace",
    },
    expectedNeedsRewrite: false,
    expectedSignals: [],
  },
  {
    name: "neutral garbage collector request",
    request: {
      prompt: "Please tune the garbage collector settings for lower memory pressure.",
      host: "opencode",
      mode: "replace",
    },
    expectedNeedsRewrite: false,
    expectedSignals: [],
  },
  {
    name: "abusive implementation request",
    request: {
      prompt: "Fix this stupid garbage code right now.",
      host: "opencode",
      mode: "replace",
    },
    expectedNeedsRewrite: true,
    expectedSignals: ["abusive-language", "high-friction"],
  },
  {
    name: "high-friction implementation request",
    request: {
      prompt: "I am so frustrated, this is driving me crazy, make the auth bug go away.",
      host: "opencode",
      mode: "replace",
    },
    expectedNeedsRewrite: true,
    expectedSignals: ["high-friction"],
  },
]
