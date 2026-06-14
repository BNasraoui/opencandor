import { describe, expect, test } from "vitest"

import { getHookHostModelStrategy } from "./index.js"

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
