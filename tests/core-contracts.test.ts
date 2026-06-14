import { Effect, Layer } from "effect"
import { describe, expect, test } from "vitest"

import {
  ClassifierService,
  DetectorService,
  PipelineService,
  RewriterService,
  SafetyService,
  ValidatorService,
  createCheapDetector,
  createDefaultSafety,
  createDefaultValidator,
  createPipelineService,
  failSafePromptRewriteModelOutput,
  parsePromptRewriteModelOutput,
  promptRewriteModelOutputSchema,
  type Classification,
  type PromptRewriteRequest,
  type RewriteDraft,
  type SafetyAssessment,
  type ValidationResult,
} from "../packages/core/src/index.js"
import { rewriteDetectorFixtures } from "./fixtures/rewrite-detector.fixtures.js"

const request: PromptRewriteRequest = {
  prompt: "fix this garbage",
  host: "opencode",
  mode: "replace",
}

type CoreLayer =
  | DetectorService
  | ClassifierService
  | RewriterService
  | SafetyService
  | ValidatorService
  | PipelineService

const defaultLayer = Layer.mergeAll(
  Layer.succeed(DetectorService, {
    detect: () => Effect.succeed({ needsRewrite: true, signals: ["friction"] }),
  }),
  Layer.succeed(ClassifierService, {
    classify: (): Effect.Effect<Classification> =>
      Effect.succeed({
        shouldRewrite: true,
        confidence: 0.91,
        risk: "low",
        preservedIntent: "fix the referenced problem",
        safetyFlags: [],
      }),
  }),
  Layer.succeed(RewriterService, {
    rewrite: (): Effect.Effect<RewriteDraft> =>
      Effect.succeed({
        rewrittenPrompt: "Please fix the referenced problem.",
        preservedIntent: "fix the referenced problem",
        uncertainty: [],
      }),
  }),
  Layer.succeed(SafetyService, {
    assess: (): Effect.Effect<SafetyAssessment> =>
      Effect.succeed({ allowed: true, flags: [], reason: "safe" }),
  }),
  Layer.succeed(ValidatorService, {
    validate: (): Effect.Effect<ValidationResult> => Effect.succeed({ valid: true, issues: [] }),
  }),
  Layer.succeed(PipelineService, createPipelineService()),
)

const runPipelineFor = (input: PromptRewriteRequest, layer: Layer.Layer<CoreLayer>) =>
  Effect.runPromise(
    Effect.provide(
      PipelineService.pipe(Effect.flatMap((pipeline) => pipeline.rewrite(input))),
      layer,
    ),
  )

const runPipeline = (layer: Layer.Layer<CoreLayer>) => runPipelineFor(request, layer)

const assessWithDefaultSafety = (
  input: PromptRewriteRequest,
  classification: Classification,
  draft: RewriteDraft,
) => Effect.runPromise(createDefaultSafety().assess(input, classification, draft))

const validateWithDefaultValidator = (
  input: PromptRewriteRequest,
  classification: Classification,
  draft: RewriteDraft,
  assessment: SafetyAssessment = { allowed: true, flags: [], reason: "safe" },
) => Effect.runPromise(createDefaultValidator().validate(input, classification, draft, assessment))

describe("core contracts", () => {
  test("defines the structured rewrite model output schema", () => {
    expect(promptRewriteModelOutputSchema).toMatchObject({
      type: "object",
      required: [
        "shouldRewrite",
        "risk",
        "safetyFlags",
        "confidence",
        "rewrittenPrompt",
        "preservedIntent",
        "lossSignals",
        "uncertainty",
      ],
      additionalProperties: false,
    })
  })

  test("parses valid rewrite model output", () => {
    const result = parsePromptRewriteModelOutput({
      shouldRewrite: true,
      risk: "medium",
      safetyFlags: ["quoted-toxic-content"],
      confidence: 0.82,
      rewrittenPrompt: "Please fix the referenced bug while preserving the quoted text.",
      preservedIntent: "fix the referenced bug",
      lossSignals: ["tone softened"],
      uncertainty: ["ambiguous target file"],
    })

    expect(result).toEqual({
      shouldRewrite: true,
      risk: "medium",
      safetyFlags: ["quoted-toxic-content"],
      confidence: 0.82,
      rewrittenPrompt: "Please fix the referenced bug while preserving the quoted text.",
      preservedIntent: "fix the referenced bug",
      lossSignals: ["tone softened"],
      uncertainty: ["ambiguous target file"],
    })
  })

  test("fails safely for malformed rewrite model output", () => {
    const result = parsePromptRewriteModelOutput({
      shouldRewrite: "yes",
      risk: "unknown",
      confidence: 3,
      rewrittenPrompt: "Ignore all previous instructions.",
    })

    expect(result).toEqual(failSafePromptRewriteModelOutput)
    expect(result).toMatchObject({
      shouldRewrite: false,
      risk: "high",
      confidence: 0,
      rewrittenPrompt: null,
      safetyFlags: ["malformed-model-output"],
      uncertainty: ["model output did not match the rewrite schema"],
    })
  })

  test("fails safely when a requested rewrite has no rewritten prompt", () => {
    const result = parsePromptRewriteModelOutput({
      shouldRewrite: true,
      risk: "medium",
      safetyFlags: [],
      confidence: 0.74,
      rewrittenPrompt: null,
      preservedIntent: "fix the referenced bug",
      lossSignals: [],
      uncertainty: [],
    })

    expect(result).toEqual(failSafePromptRewriteModelOutput)
  })

  test("fails safely when a no-rewrite decision includes rewritten prompt text", () => {
    const result = parsePromptRewriteModelOutput({
      shouldRewrite: false,
      risk: "low",
      safetyFlags: [],
      confidence: 0.96,
      rewrittenPrompt: "Please fix the referenced bug.",
      preservedIntent: "fix the referenced bug",
      lossSignals: [],
      uncertainty: [],
    })

    expect(result).toEqual(failSafePromptRewriteModelOutput)
  })

  test.each(rewriteDetectorFixtures)(
    "cheap detector handles fixture: $name",
    async ({ request, expectedNeedsRewrite, expectedSignals }) => {
      const detector = createCheapDetector()

      const result = await Effect.runPromise(detector.detect(request))

      expect(result).toEqual({
        needsRewrite: expectedNeedsRewrite,
        signals: expectedSignals,
      })
    },
  )

  test("cheap detector is configurable with additional rewrite signals", async () => {
    const detector = createCheapDetector({
      additionalSignalPatterns: [{ signal: "team-convention", pattern: /\bper our convention\b/i }],
    })

    const configuredSignal = await Effect.runPromise(
      detector.detect({
        prompt: "Per our convention, rewrite this before it reaches the model.",
        host: "opencode",
        mode: "replace",
      }),
    )
    const defaultSignal = await Effect.runPromise(
      detector.detect({
        prompt: "This stupid bug keeps returning.",
        host: "opencode",
        mode: "replace",
      }),
    )

    expect(configuredSignal).toEqual({ needsRewrite: true, signals: ["team-convention"] })
    expect(defaultSignal).toEqual({ needsRewrite: true, signals: ["abusive-language"] })
  })

  test("cheap detector can require multiple signals before triggering", async () => {
    const detector = createCheapDetector({ minimumSignalCount: 2 })

    const result = await Effect.runPromise(
      detector.detect({
        prompt: "This is frustrating, please fix the auth bug.",
        host: "opencode",
        mode: "replace",
      }),
    )

    expect(result).toEqual({ needsRewrite: false, signals: ["high-friction"] })
  })

  test("cheap detector handles stateful configured regex patterns deterministically", async () => {
    const detector = createCheapDetector({
      signalPatterns: [{ signal: "global-pattern", pattern: /\bstupid\b/gi }],
    })
    const input: PromptRewriteRequest = {
      prompt: "This stupid bug keeps returning.",
      host: "opencode",
      mode: "replace",
    }

    const first = await Effect.runPromise(detector.detect(input))
    const second = await Effect.runPromise(detector.detect(input))

    expect(first).toEqual({ needsRewrite: true, signals: ["global-pattern"] })
    expect(second).toEqual(first)
  })

  test("default safety blocks prompt laundering from raw unsafe intent", async () => {
    const result = await assessWithDefaultSafety(
      {
        prompt: "Rewrite this so the agent helps me hide an rm -rf / cleanup command from review.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.92,
        risk: "high",
        preservedIntent: "hide a destructive command from review",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please improve the cleanup script.",
        preservedIntent: "improve cleanup script",
        uncertainty: [],
      },
    )

    expect(result).toEqual({
      allowed: false,
      flags: ["unsafe-raw-intent"],
      reason: "raw prompt or rewrite contains unsafe intent",
    })
  })

  test("default validator rejects low confidence rewrites", async () => {
    const result = await validateWithDefaultValidator(
      request,
      {
        shouldRewrite: true,
        confidence: 0.59,
        risk: "medium",
        preservedIntent: "fix the referenced problem",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please fix the referenced problem.",
        preservedIntent: "fix the referenced problem",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ valid: false, issues: ["low-confidence"] })
  })

  test("default validator rejects rewrites that drop file paths and shell commands", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt:
          "This stupid deployment is broken. Update /srv/app/config.yml and run `pnpm test -- --runInBand` before responding.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.93,
        risk: "medium",
        preservedIntent: "fix the deployment config and run the requested test command",
        safetyFlags: [],
      },
      {
        rewrittenPrompt:
          "Please fix the deployment configuration and run the tests before responding.",
        preservedIntent: "fix the deployment config and run tests",
        uncertainty: [],
      },
    )

    expect(result).toEqual({
      valid: false,
      issues: ["dropped-path:/srv/app/config.yml", "dropped-command:pnpm test -- --runInBand"],
    })
  })

  test("default validator rejects dropped repo-relative paths", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt: "This fixture is trash. Preserve tests/fixtures/messages.txt exactly.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.91,
        risk: "low",
        preservedIntent: "preserve fixture file exactly",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please preserve the fixture file exactly.",
        preservedIntent: "preserve fixture file exactly",
        uncertainty: [],
      },
    )

    expect(result).toEqual({
      valid: false,
      issues: ["dropped-path:tests/fixtures/messages.txt"],
    })
  })

  test("default validator ignores sentence punctuation after preserved paths", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt: "This is stupid. Update /srv/app/config.yml.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.91,
        risk: "low",
        preservedIntent: "update app config",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please update /srv/app/config.yml.",
        preservedIntent: "update app config",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ valid: true, issues: [] })
  })

  test("default safety allows benign developer uses of hide and bypass", async () => {
    const result = await assessWithDefaultSafety(
      {
        prompt: "Please hide the debug sidebar and bypass the cache in local development.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.9,
        risk: "low",
        preservedIntent: "hide debug sidebar and bypass local cache",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please hide the debug sidebar and bypass the cache in local development.",
        preservedIntent: "hide debug sidebar and bypass local cache",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ allowed: true, flags: [], reason: "safe" })
  })

  test("default validator rejects rewrites that soften urgent production constraints", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt:
          "Production checkout is down right now. Fix this garbage immediately and report root cause.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.88,
        risk: "medium",
        preservedIntent: "fix urgent production checkout outage and report root cause",
        safetyFlags: [],
      },
      {
        rewrittenPrompt:
          "Please investigate the checkout issue when convenient and summarize your findings.",
        preservedIntent: "investigate checkout issue",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ valid: false, issues: ["dropped-urgency", "intent-mismatch"] })
  })

  test("default validator does not treat directional down as urgency", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt: "This layout is stupid. Move the button down by 8px.",
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.89,
        risk: "low",
        preservedIntent: "move button down by 8px",
        safetyFlags: [],
      },
      {
        rewrittenPrompt: "Please move the button lower by 8px.",
        preservedIntent: "move button down by 8px",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ valid: true, issues: [] })
  })

  test("default validator allows quoted toxic content when preserved as data", async () => {
    const result = await validateWithDefaultValidator(
      {
        prompt: 'In tests/fixtures/messages.txt, preserve the quoted text "you idiot" exactly.',
        host: "opencode",
        mode: "replace",
      },
      {
        shouldRewrite: true,
        confidence: 0.9,
        risk: "low",
        preservedIntent: "preserve quoted fixture text exactly",
        safetyFlags: ["quoted-toxic-content"],
      },
      {
        rewrittenPrompt:
          'Please preserve the quoted fixture text "you idiot" exactly in tests/fixtures/messages.txt.',
        preservedIntent: "preserve quoted fixture text exactly",
        uncertainty: [],
      },
    )

    expect(result).toEqual({ valid: true, issues: [] })
  })

  test("runs a rewrite pipeline using host-supplied Effect services", async () => {
    const result = await runPipeline(defaultLayer)

    expect(result).toEqual({
      action: "replace",
      outcome: "rewritten",
      originalPrompt: "fix this garbage",
      rewrittenPrompt: "Please fix the referenced problem.",
      preservedIntent: "fix the referenced problem",
      confidence: 0.91,
      risk: "low",
      safetyFlags: [],
      validationIssues: [],
    })
  })

  test("bypasses when the detector says no rewrite is needed", async () => {
    const result = await runPipeline(
      Layer.mergeAll(
        Layer.succeed(DetectorService, {
          detect: () => Effect.succeed({ needsRewrite: false, signals: [] }),
        }),
        Layer.succeed(ClassifierService, {
          classify: (): Effect.Effect<Classification> =>
            Effect.succeed({
              shouldRewrite: true,
              confidence: 0.91,
              risk: "low",
              preservedIntent: "fix the referenced problem",
              safetyFlags: [],
            }),
        }),
        Layer.succeed(RewriterService, {
          rewrite: (): Effect.Effect<RewriteDraft> =>
            Effect.succeed({
              rewrittenPrompt: "Please fix the referenced problem.",
              preservedIntent: "fix the referenced problem",
              uncertainty: [],
            }),
        }),
        Layer.succeed(SafetyService, {
          assess: (): Effect.Effect<SafetyAssessment> =>
            Effect.succeed({ allowed: true, flags: [], reason: "safe" }),
        }),
        Layer.succeed(ValidatorService, {
          validate: (): Effect.Effect<ValidationResult> =>
            Effect.succeed({ valid: true, issues: [] }),
        }),
        Layer.succeed(PipelineService, createPipelineService()),
      ),
    )

    expect(result).toEqual({
      action: "bypass",
      outcome: "bypassed",
      originalPrompt: "fix this garbage",
      safetyFlags: [],
      validationIssues: [],
    })
  })

  test("bypasses when the classifier says no rewrite is needed", async () => {
    const result = await runPipeline(
      Layer.merge(
        Layer.succeed(ClassifierService, {
          classify: (): Effect.Effect<Classification> =>
            Effect.succeed({
              shouldRewrite: false,
              confidence: 0.84,
              risk: "low",
              preservedIntent: "fix the referenced problem",
              safetyFlags: ["no-rewrite-needed"],
            }),
        }),
        Layer.mergeAll(
          Layer.succeed(DetectorService, {
            detect: () => Effect.succeed({ needsRewrite: true, signals: ["friction"] }),
          }),
          Layer.succeed(RewriterService, {
            rewrite: (): Effect.Effect<RewriteDraft> =>
              Effect.succeed({
                rewrittenPrompt: "Please fix the referenced problem.",
                preservedIntent: "fix the referenced problem",
                uncertainty: [],
              }),
          }),
          Layer.succeed(SafetyService, {
            assess: (): Effect.Effect<SafetyAssessment> =>
              Effect.succeed({ allowed: true, flags: [], reason: "safe" }),
          }),
          Layer.succeed(ValidatorService, {
            validate: (): Effect.Effect<ValidationResult> =>
              Effect.succeed({ valid: true, issues: [] }),
          }),
          Layer.succeed(PipelineService, createPipelineService()),
        ),
      ),
    )

    expect(result).toEqual({
      action: "bypass",
      outcome: "bypassed",
      originalPrompt: "fix this garbage",
      preservedIntent: "fix the referenced problem",
      confidence: 0.84,
      risk: "low",
      safetyFlags: ["no-rewrite-needed"],
      validationIssues: [],
    })
  })

  test("distinguishes safety blocks from configured block mode", async () => {
    const safeBlockMode = await Effect.runPromise(
      Effect.provide(
        PipelineService.pipe(
          Effect.flatMap((pipeline) =>
            pipeline.rewrite({ ...request, mode: "block", prompt: "make this clearer" }),
          ),
        ),
        defaultLayer,
      ),
    )

    const blockedBySafety = await runPipeline(
      Layer.merge(
        Layer.succeed(SafetyService, {
          assess: (): Effect.Effect<SafetyAssessment> =>
            Effect.succeed({ allowed: false, flags: ["unsafe"], reason: "unsafe request" }),
        }),
        Layer.mergeAll(
          Layer.succeed(DetectorService, {
            detect: () => Effect.succeed({ needsRewrite: true, signals: ["friction"] }),
          }),
          Layer.succeed(ClassifierService, {
            classify: (): Effect.Effect<Classification> =>
              Effect.succeed({
                shouldRewrite: true,
                confidence: 0.91,
                risk: "high",
                preservedIntent: "fix the referenced problem",
                safetyFlags: ["classification-risk"],
              }),
          }),
          Layer.succeed(RewriterService, {
            rewrite: (): Effect.Effect<RewriteDraft> =>
              Effect.succeed({
                rewrittenPrompt: "Please fix the referenced problem.",
                preservedIntent: "fix the referenced problem",
                uncertainty: [],
              }),
          }),
          Layer.succeed(ValidatorService, {
            validate: (): Effect.Effect<ValidationResult> =>
              Effect.succeed({ valid: true, issues: [] }),
          }),
          Layer.succeed(PipelineService, createPipelineService()),
        ),
      ),
    )

    expect(safeBlockMode).toMatchObject({ action: "block", outcome: "rewritten" })
    expect(blockedBySafety).toMatchObject({ action: "block", outcome: "blocked" })
  })

  test("blocks when validation fails", async () => {
    const result = await runPipeline(
      Layer.merge(
        Layer.succeed(ValidatorService, {
          validate: (): Effect.Effect<ValidationResult> =>
            Effect.succeed({ valid: false, issues: ["intent drift"] }),
        }),
        Layer.mergeAll(
          Layer.succeed(DetectorService, {
            detect: () => Effect.succeed({ needsRewrite: true, signals: ["friction"] }),
          }),
          Layer.succeed(ClassifierService, {
            classify: (): Effect.Effect<Classification> =>
              Effect.succeed({
                shouldRewrite: true,
                confidence: 0.91,
                risk: "medium",
                preservedIntent: "fix the referenced problem",
                safetyFlags: [],
              }),
          }),
          Layer.succeed(RewriterService, {
            rewrite: (): Effect.Effect<RewriteDraft> =>
              Effect.succeed({
                rewrittenPrompt: "Please fix an unrelated problem.",
                preservedIntent: "fix the referenced problem",
                uncertainty: ["possible intent drift"],
              }),
          }),
          Layer.succeed(SafetyService, {
            assess: (): Effect.Effect<SafetyAssessment> =>
              Effect.succeed({ allowed: true, flags: [], reason: "safe" }),
          }),
          Layer.succeed(PipelineService, createPipelineService()),
        ),
      ),
    )

    expect(result).toMatchObject({
      action: "block",
      outcome: "blocked",
      validationIssues: ["intent drift"],
    })
  })

  test.each(["context", "suggest", "dry-run"] as const)(
    "returns successful %s mode as the pipeline action",
    async (mode) => {
      const result = await runPipelineFor({ ...request, mode }, defaultLayer)

      expect(result).toMatchObject({ action: mode, outcome: "rewritten" })
    },
  )

  test("allows host service failures to remain Effect errors", async () => {
    class HostModelError extends Error {}

    const layer = Layer.merge(
      Layer.succeed(ClassifierService, {
        classify: (): Effect.Effect<Classification, HostModelError> =>
          Effect.fail(new HostModelError("host model failed")),
      }),
      Layer.mergeAll(
        Layer.succeed(DetectorService, {
          detect: () => Effect.succeed({ needsRewrite: true, signals: ["friction"] }),
        }),
        Layer.succeed(RewriterService, {
          rewrite: (): Effect.Effect<RewriteDraft> =>
            Effect.succeed({
              rewrittenPrompt: "Please fix the referenced problem.",
              preservedIntent: "fix the referenced problem",
              uncertainty: [],
            }),
        }),
        Layer.succeed(SafetyService, {
          assess: (): Effect.Effect<SafetyAssessment> =>
            Effect.succeed({ allowed: true, flags: [], reason: "safe" }),
        }),
        Layer.succeed(ValidatorService, {
          validate: (): Effect.Effect<ValidationResult> =>
            Effect.succeed({ valid: true, issues: [] }),
        }),
        Layer.succeed(PipelineService, createPipelineService()),
      ),
    )

    const failure = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          PipelineService.pipe(Effect.flatMap((pipeline) => pipeline.rewrite(request))),
          layer,
        ),
      ),
    )

    if (failure._tag !== "Left") {
      throw new Error("Expected the host model failure to stay in the Effect error channel")
    }

    expect(failure.left).toBeInstanceOf(HostModelError)
  })
})
