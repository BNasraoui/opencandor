import { Context, Effect } from "effect"

export type HostRuntime = "opencode" | "claude-code" | "codex" | (string & {})

export type RewriteMode = "replace" | "context" | "block" | "suggest" | "dry-run"

export type RiskLevel = "low" | "medium" | "high"

export interface PromptRewriteRequest {
  readonly prompt: string
  readonly host: HostRuntime
  readonly mode: RewriteMode
  readonly metadata?: Readonly<Record<string, string>>
}

export interface DetectionResult {
  readonly needsRewrite: boolean
  readonly signals: readonly string[]
}

export interface Classification {
  readonly shouldRewrite: boolean
  readonly confidence: number
  readonly risk: RiskLevel
  readonly preservedIntent: string
  readonly safetyFlags: readonly string[]
}

export interface RewriteDraft {
  readonly rewrittenPrompt: string
  readonly preservedIntent: string
  readonly uncertainty: readonly string[]
}

export interface SafetyAssessment {
  readonly allowed: boolean
  readonly flags: readonly string[]
  readonly reason?: string
}

export interface ValidationResult {
  readonly valid: boolean
  readonly issues: readonly string[]
}

export type PipelineAction = "bypass" | "replace" | "context" | "block" | "suggest" | "dry-run"

export type PipelineOutcome = "bypassed" | "rewritten" | "blocked"

export interface PipelineResult {
  readonly action: PipelineAction
  readonly outcome: PipelineOutcome
  readonly originalPrompt: string
  readonly rewrittenPrompt?: string
  readonly preservedIntent?: string
  readonly confidence?: number
  readonly risk?: RiskLevel
  readonly safetyFlags: readonly string[]
  readonly validationIssues: readonly string[]
}

export interface Detector {
  readonly detect: (request: PromptRewriteRequest) => Effect.Effect<DetectionResult, unknown>
}

export interface Classifier {
  readonly classify: (request: PromptRewriteRequest) => Effect.Effect<Classification, unknown>
}

export interface Rewriter {
  readonly rewrite: (
    request: PromptRewriteRequest,
    classification: Classification,
  ) => Effect.Effect<RewriteDraft, unknown>
}

export interface Safety {
  readonly assess: (
    request: PromptRewriteRequest,
    classification: Classification,
    draft: RewriteDraft,
  ) => Effect.Effect<SafetyAssessment, unknown>
}

export interface Validator {
  readonly validate: (
    request: PromptRewriteRequest,
    classification: Classification,
    draft: RewriteDraft,
    safety: SafetyAssessment,
  ) => Effect.Effect<ValidationResult, unknown>
}

export interface Pipeline {
  readonly rewrite: (
    request: PromptRewriteRequest,
  ) => Effect.Effect<
    PipelineResult,
    unknown,
    DetectorService | ClassifierService | RewriterService | SafetyService | ValidatorService
  >
}

export class DetectorService extends Context.Tag("@opencandor/core/DetectorService")<
  DetectorService,
  Detector
>() {}

export class ClassifierService extends Context.Tag("@opencandor/core/ClassifierService")<
  ClassifierService,
  Classifier
>() {}

export class RewriterService extends Context.Tag("@opencandor/core/RewriterService")<
  RewriterService,
  Rewriter
>() {}

export class SafetyService extends Context.Tag("@opencandor/core/SafetyService")<
  SafetyService,
  Safety
>() {}

export class ValidatorService extends Context.Tag("@opencandor/core/ValidatorService")<
  ValidatorService,
  Validator
>() {}

export class PipelineService extends Context.Tag("@opencandor/core/PipelineService")<
  PipelineService,
  Pipeline
>() {}

export const createPipelineService = (): Pipeline => ({
  rewrite: (request) =>
    Effect.gen(function* () {
      const detector = yield* DetectorService
      const detection = yield* detector.detect(request)

      if (!detection.needsRewrite) {
        return {
          action: "bypass",
          outcome: "bypassed",
          originalPrompt: request.prompt,
          safetyFlags: [],
          validationIssues: [],
        } satisfies PipelineResult
      }

      const classifier = yield* ClassifierService
      const classification = yield* classifier.classify(request)

      if (!classification.shouldRewrite) {
        return {
          action: "bypass",
          outcome: "bypassed",
          originalPrompt: request.prompt,
          preservedIntent: classification.preservedIntent,
          confidence: classification.confidence,
          risk: classification.risk,
          safetyFlags: classification.safetyFlags,
          validationIssues: [],
        } satisfies PipelineResult
      }

      const rewriter = yield* RewriterService
      const draft = yield* rewriter.rewrite(request, classification)

      const safety = yield* SafetyService
      const assessment = yield* safety.assess(request, classification, draft)

      const validator = yield* ValidatorService
      const validation = yield* validator.validate(request, classification, draft, assessment)

      if (!assessment.allowed || !validation.valid) {
        return {
          action: "block",
          outcome: "blocked",
          originalPrompt: request.prompt,
          preservedIntent: draft.preservedIntent,
          confidence: classification.confidence,
          risk: classification.risk,
          safetyFlags: [...classification.safetyFlags, ...assessment.flags],
          validationIssues: validation.issues,
        } satisfies PipelineResult
      }

      return {
        action: request.mode,
        outcome: "rewritten",
        originalPrompt: request.prompt,
        rewrittenPrompt: draft.rewrittenPrompt,
        preservedIntent: draft.preservedIntent,
        confidence: classification.confidence,
        risk: classification.risk,
        safetyFlags: [...classification.safetyFlags, ...assessment.flags],
        validationIssues: validation.issues,
      } satisfies PipelineResult
    }),
})
