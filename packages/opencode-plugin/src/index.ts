import { Effect } from "effect"

import {
  parsePromptRewriteModelOutput,
  promptRewriteModelOutputSchema,
  promptRewriteModelContract,
  type Classification,
  type Classifier,
  type PromptRewriteModelOutput,
  type PromptRewriteRequest,
  type RewriteDraft,
  type Rewriter,
} from "@opencandor/core"

export interface OpenCandorOpenCodeConfig {
  readonly classifierModel: string
  readonly rewriterModel: string
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

const parseModelJson = (raw: string): PromptRewriteModelOutput => {
  try {
    return parsePromptRewriteModelOutput(JSON.parse(raw))
  } catch {
    return parsePromptRewriteModelOutput(undefined)
  }
}

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
