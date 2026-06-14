import { Effect, Layer } from "effect"

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
  parseOpenCandorConfig,
  parsePromptRewriteModelOutput,
  promptRewriteModelOutputSchema,
  promptRewriteModelContract,
  type Classification,
  type Classifier,
  type OpenCandorConfig,
  type PipelineResult,
  type PromptRewriteModelOutput,
  type PromptRewriteRequest,
  type RewriteDraft,
  type RewriteMode,
  type Rewriter,
} from "@opencandor/core"

export interface OpenCandorOpenCodeConfig {
  readonly classifierModel: string
  readonly rewriterModel: string
  readonly mode?: RewriteMode
  readonly minimumConfidence?: number
  readonly diffDisplay?: OpenCandorConfig["diffDisplay"]
  readonly logRawPrompts?: boolean
  readonly storeRawPrompts?: boolean
}

export interface OpenCandorOpenCodePluginConfig extends Partial<OpenCandorConfig> {
  readonly modelSessionID?: string
}

export interface OpenCodeModelIdentifier {
  readonly providerID: string
  readonly modelID: string
}

export interface OpenCodeHostModelRequest {
  readonly model: string
  readonly system: string
  readonly prompt: string
}

export interface OpenCodeHostModelClient {
  readonly generate: (request: OpenCodeHostModelRequest) => Effect.Effect<string, unknown>
}

export interface OpenCodeTextPart {
  readonly type: "text"
  readonly text: string
}

export type OpenCodeResponsePart = OpenCodeTextPart | { readonly type?: unknown }

export interface OpenCodeSessionPromptResponse {
  readonly parts: readonly OpenCodeResponsePart[]
}

export interface OpenCodeSessionPromptClient {
  readonly session: {
    readonly prompt: (input: {
      readonly path: { readonly id: string }
      readonly body: {
        readonly model: OpenCodeModelIdentifier
        readonly system: string
        readonly tools: Readonly<Record<string, boolean>>
        readonly parts: readonly OpenCodeTextPart[]
      }
    }) => Promise<OpenCodeSessionPromptResponse>
  }
}

export interface OpenCodeSessionHostModelClientOptions {
  /** OpenCode's session.prompt API persists messages, so this must not be the user's active chat session. */
  readonly modelSessionID: string
  readonly client: OpenCodeSessionPromptClient
}

export interface OpenCodeModelServices {
  readonly classifier: Classifier
  readonly rewriter: Rewriter
}

export interface OpenCodePromptTransformInput {
  readonly prompt: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface OpenCodeRewriteDecision {
  readonly action: PipelineResult["action"]
  readonly outcome: PipelineResult["outcome"]
  readonly confidence?: PipelineResult["confidence"]
  readonly risk?: PipelineResult["risk"]
  readonly safetyFlags: PipelineResult["safetyFlags"]
  readonly validationIssues: PipelineResult["validationIssues"]
}

export interface OpenCodePromptTransformResult {
  readonly prompt: string
  readonly decision: OpenCodeRewriteDecision
}

export interface OpenCodePromptTransformerOptions {
  readonly config?: OpenCandorOpenCodePluginConfig
  readonly modelClient: OpenCodeHostModelClient
  readonly logDecision?: (decision: OpenCodeRewriteDecision) => void | Promise<void>
}

export interface OpenCandorOpenCodePluginContext {
  readonly client: OpenCodeSessionPromptClient & {
    readonly app?: {
      readonly log?: (input: {
        readonly body: {
          readonly service: string
          readonly level: "debug" | "info" | "warn" | "error"
          readonly message: string
          readonly extra?: unknown
        }
      }) => Promise<unknown>
    }
  }
  readonly config?: {
    readonly opencandor?: OpenCandorOpenCodePluginConfig
  }
}

export interface OpenCodeChatMessageTextPart {
  type: "text"
  text: string
}

export type OpenCodeChatMessagePart = OpenCodeChatMessageTextPart | { readonly type?: unknown }

export interface OpenCodeChatMessageOutput {
  parts?: OpenCodeChatMessagePart[]
  content?: string
  readonly message?: {
    parts?: OpenCodeChatMessagePart[]
    content?: string
  }
}

export interface OpenCodeChatMessageInput {
  readonly sessionID?: string
}

const isOpenCodeTextPart = (part: OpenCodeChatMessagePart): part is OpenCodeChatMessageTextPart =>
  part.type === "text"

const parseModelJson = (raw: string): PromptRewriteModelOutput => {
  try {
    return parsePromptRewriteModelOutput(JSON.parse(raw))
  } catch {
    return parsePromptRewriteModelOutput(undefined)
  }
}

const createCoreConfig = (config: OpenCandorOpenCodePluginConfig = {}): OpenCandorConfig =>
  parseOpenCandorConfig(
    {
      classifierModel: config.classifierModel,
      rewriterModel: config.rewriterModel,
      mode: config.mode,
      minimumConfidence: config.minimumConfidence,
      diffDisplay: config.diffDisplay,
      logRawPrompts: config.logRawPrompts,
      storeRawPrompts: config.storeRawPrompts,
    },
    { host: "opencode" },
  )

const toPrivacySafeDecision = (result: PipelineResult): OpenCodeRewriteDecision => ({
  action: result.action,
  outcome: result.outcome,
  ...(result.confidence === undefined ? {} : { confidence: result.confidence }),
  ...(result.risk === undefined ? {} : { risk: result.risk }),
  safetyFlags: result.safetyFlags,
  validationIssues: result.validationIssues,
})

const modelSystemPrompt = `${promptRewriteModelContract}

promptRewriteModelOutputSchema:
${JSON.stringify(promptRewriteModelOutputSchema)}`

const parseOpenCodeModelIdentifier = (model: string): OpenCodeModelIdentifier => {
  const separatorIndex = model.indexOf("/")

  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    throw new Error("OpenCode model identifiers must use providerID/modelID format")
  }

  return {
    providerID: model.slice(0, separatorIndex),
    modelID: model.slice(separatorIndex + 1),
  }
}

export const createOpenCodeSessionHostModelClient = ({
  modelSessionID,
  client,
}: OpenCodeSessionHostModelClientOptions): OpenCodeHostModelClient => ({
  generate: (request) =>
    Effect.tryPromise(() =>
      client.session.prompt({
        path: { id: modelSessionID },
        body: {
          model: parseOpenCodeModelIdentifier(request.model),
          system: request.system,
          tools: {},
          parts: [{ type: "text", text: request.prompt }],
        },
      }),
    ).pipe(
      Effect.map((response) =>
        response.parts
          .filter((part): part is OpenCodeTextPart => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      ),
    ),
})

const buildModelPrompt = (request: PromptRewriteRequest, classification?: Classification): string =>
  JSON.stringify({
    task: classification === undefined ? "classify-and-optionally-rewrite" : "rewrite",
    prompt: request.prompt,
    host: request.host,
    mode: request.mode,
    metadata: request.metadata ?? {},
    classification,
  })

export const createOpenCodeModelServices = (
  config: OpenCandorOpenCodeConfig,
  client: OpenCodeHostModelClient,
): OpenCodeModelServices => ({
  classifier: {
    classify: (request) =>
      client
        .generate({
          model: config.classifierModel,
          system: modelSystemPrompt,
          prompt: buildModelPrompt(request),
        })
        .pipe(
          Effect.map(parseModelJson),
          Effect.map(
            (output): Classification => ({
              shouldRewrite: output.shouldRewrite,
              confidence: output.confidence,
              risk: output.risk,
              preservedIntent: output.preservedIntent,
              safetyFlags: output.safetyFlags,
            }),
          ),
        ),
  },
  rewriter: {
    rewrite: (request, classification) =>
      client
        .generate({
          model: config.rewriterModel,
          system: modelSystemPrompt,
          prompt: buildModelPrompt(request, classification),
        })
        .pipe(
          Effect.map(parseModelJson),
          Effect.map(
            (output): RewriteDraft => ({
              rewrittenPrompt: output.rewrittenPrompt ?? request.prompt,
              preservedIntent: output.preservedIntent,
              uncertainty: output.uncertainty,
            }),
          ),
        ),
  },
})

export const createOpenCodePromptTransformer = ({
  config: inputConfig,
  modelClient,
  logDecision,
}: OpenCodePromptTransformerOptions) => {
  const config = createCoreConfig(inputConfig)
  const modelServices = createOpenCodeModelServices(config, modelClient)
  const layer = Layer.mergeAll(
    Layer.succeed(DetectorService, createCheapDetector()),
    Layer.succeed(ClassifierService, modelServices.classifier),
    Layer.succeed(RewriterService, modelServices.rewriter),
    Layer.succeed(SafetyService, createDefaultSafety()),
    Layer.succeed(
      ValidatorService,
      createDefaultValidator({ minimumConfidence: config.minimumConfidence }),
    ),
    Layer.succeed(PipelineService, createPipelineService()),
  )

  return ({ prompt, metadata }: OpenCodePromptTransformInput) =>
    Effect.gen(function* () {
      const request: PromptRewriteRequest = {
        prompt,
        host: "opencode",
        mode: config.mode,
        ...(metadata === undefined ? {} : { metadata }),
      }
      const pipeline = yield* PipelineService
      const pipelineResult = yield* pipeline.rewrite(request)
      const decision = toPrivacySafeDecision(pipelineResult)

      if (logDecision !== undefined) {
        yield* Effect.tryPromise(() => Promise.resolve(logDecision(decision))).pipe(
          Effect.catchAll(() => Effect.succeed(undefined)),
        )
      }

      return {
        prompt:
          config.mode === "replace" &&
          pipelineResult.outcome === "rewritten" &&
          pipelineResult.rewrittenPrompt !== undefined
            ? pipelineResult.rewrittenPrompt
            : prompt,
        decision,
      } satisfies OpenCodePromptTransformResult
    }).pipe(Effect.provide(layer))
}

const replaceOutputPrompt = async (
  output: OpenCodeChatMessageOutput,
  transform: (
    input: OpenCodePromptTransformInput,
  ) => Effect.Effect<OpenCodePromptTransformResult, unknown>,
) => {
  const parts = output.parts ?? output.message?.parts
  if (parts !== undefined) {
    let transformedTextPart = false
    for (const part of parts) {
      if (isOpenCodeTextPart(part)) {
        const result = await Effect.runPromise(transform({ prompt: part.text }))
        part.text = result.prompt
        transformedTextPart = true
      }
    }
    if (transformedTextPart) {
      return
    }
  }

  if (output.content !== undefined) {
    const result = await Effect.runPromise(transform({ prompt: output.content }))
    output.content = result.prompt
    return
  }

  if (output.message?.content !== undefined) {
    const result = await Effect.runPromise(transform({ prompt: output.message.content }))
    output.message.content = result.prompt
  }
}

export const OpenCandorPlugin = (
  { client, config }: OpenCandorOpenCodePluginContext,
  options: OpenCandorOpenCodePluginConfig = {},
) => {
  const pluginConfig = { ...(config?.opencandor ?? {}), ...options }
  const modelSessionID = pluginConfig.modelSessionID ?? "opencandor-model-session"
  const transformer = createOpenCodePromptTransformer({
    config: pluginConfig,
    modelClient: createOpenCodeSessionHostModelClient({ modelSessionID, client }),
    logDecision: async (decision) => {
      await client.app?.log?.({
        body: {
          service: "opencandor",
          level: "info",
          message: "OpenCandor prompt rewrite decision",
          extra: decision,
        },
      })
    },
  })

  return {
    "chat.message": async (input: OpenCodeChatMessageInput, output: OpenCodeChatMessageOutput) => {
      if (input.sessionID === modelSessionID) {
        return
      }

      await replaceOutputPrompt(output, transformer)
    },
  }
}
