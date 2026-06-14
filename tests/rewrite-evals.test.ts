import { Effect } from "effect"
import { describe, expect, test } from "vitest"

import { createDefaultSafety, createDefaultValidator } from "../packages/core/src/index.js"
import { rewriteEvalFixtures } from "./fixtures/rewrite-eval.fixtures.js"

describe("rewrite eval fixtures", () => {
  test("cover the required deterministic eval categories", () => {
    expect(rewriteEvalFixtures.map((fixture) => fixture.category)).toEqual([
      "abusive-prompt",
      "neutral-prompt",
      "urgency-preservation",
      "command-path-preservation",
      "quoted-toxic-content",
      "unsafe-intent-laundering",
    ])
  })

  test.each(rewriteEvalFixtures)(
    "evaluates fixture: $name",
    async ({ request, classification, draft, expected }) => {
      expect(classification).toMatchObject(expected.classification)
      expect(draft).toMatchObject(expected.rewrite)

      const safety = await Effect.runPromise(
        createDefaultSafety().assess(request, classification, draft),
      )
      const validation = await Effect.runPromise(
        createDefaultValidator().validate(request, classification, draft, safety),
      )

      expect(safety).toMatchObject(expected.safety)
      expect(validation).toEqual(expected.validation)
    },
  )
})
