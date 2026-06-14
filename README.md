# OpenCandor

OpenCandor rewrites high-friction prompts before they reach an AI coding agent. It is an input-pipeline rewrite layer: the user keeps their intent, constraints, files, commands, urgency, and requested output, while OpenCandor makes the prompt clearer and less likely to trigger defensive or low-quality agent behavior.

The MVP is OpenCode-first. OpenCode supports replacement mode through a native plugin. Claude Code and Codex are supported only through honest hook modes because their user-prompt hooks cannot transparently replace the submitted prompt or invoke the host runtime model.

## What It Does

- Detects prompts that may benefit from rewriting, such as frustrated or high-friction requests.
- Uses the configured host model to classify and rewrite prompts when the host supports it.
- Preserves concrete user intent instead of laundering unsafe or ambiguous requests into something else.
- Blocks rewrites that drop paths, commands, quoted text, urgency, or key intent.
- Defaults to privacy-preserving decisions that do not log or store raw prompts.

## Packages

- `@opencandor/core`: provider-agnostic Effect TS rewrite pipeline, config validation, safety checks, and rewrite contracts.
- `@opencandor/opencode-plugin`: OpenCode plugin that can replace a user message before the main model sees it.
- `@opencandor/hooks-cli`: CLI for Claude Code and Codex hook integrations in context, block, suggest, and dry-run modes.

## Modes

| Mode      | OpenCode  | Claude Code   | Codex         | Behavior                                                           |
| --------- | --------- | ------------- | ------------- | ------------------------------------------------------------------ |
| `replace` | Supported | Not supported | Not supported | Replaces the submitted prompt with the rewritten prompt when safe. |
| `context` | Supported | Supported     | Supported     | Adds OpenCandor context without replacing the prompt.              |
| `block`   | Supported | Supported     | Supported     | Blocks high-friction or unsafe prompts with a reason.              |
| `suggest` | Supported | Supported     | Supported     | Suggests a rewrite or revision path without replacing the prompt.  |
| `dry-run` | Supported | Supported     | Supported     | Runs detection without changing host context or prompt text.       |

`replace` is intentionally unavailable for Claude Code and Codex hook-only integrations. Claiming otherwise would be misleading because those hook APIs do not provide transparent prompt replacement in this implementation.

## OpenCode Quickstart

Build the workspace first:

```bash
pnpm install
pnpm build
```

Use the OpenCode plugin from the workspace package and configure OpenCandor under the plugin config key:

```ts
import { OpenCandorPlugin } from "@opencandor/opencode-plugin"

export default [OpenCandorPlugin]
```

Example OpenCandor config:

```json
{
  "opencandor": {
    "classifierModel": "openai/gpt-5.5",
    "rewriterModel": "openai/gpt-5.5",
    "mode": "replace",
    "minimumConfidence": 0.6,
    "diffDisplay": "summary",
    "logRawPrompts": false,
    "storeRawPrompts": false,
    "modelSessionID": "opencandor-model-session"
  }
}
```

The plugin uses OpenCode's `chat.message` hook and a separate model session for classification and rewrite calls. Do not point `modelSessionID` at the user's active chat session; OpenCode's `session.prompt` API persists messages.

## Claude Code Hook Setup

Build the hook package:

```bash
pnpm --filter @opencandor/hooks-cli build
```

Configure a `UserPromptSubmit` hook that pipes the hook JSON to `opencandor-hook`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "opencandor-hook --host claude-code --mode suggest"
          }
        ]
      }
    ]
  }
}
```

For Claude Code, OpenCandor emits `hookSpecificOutput.additionalContext` in `suggest` and `context` style flows. It can also emit a block decision in `block` mode. It does not replace the original prompt.

## Codex Hook Setup

Build the hook package:

```bash
pnpm --filter @opencandor/hooks-cli build
```

Configure the Codex prompt hook command with the desired non-replacement mode:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "command": "opencandor-hook --host codex --mode suggest"
      }
    ]
  }
}
```

For Codex, OpenCandor emits additional context or a block decision. It does not replace the original prompt.

## Configuration Reference

| Option              | Default                    | Description                                                           |
| ------------------- | -------------------------- | --------------------------------------------------------------------- |
| `classifierModel`   | `host/default`             | Model identifier used to decide whether a prompt should be rewritten. |
| `rewriterModel`     | `host/default`             | Model identifier used to produce the rewritten prompt.                |
| `mode`              | `suggest`                  | One of `replace`, `context`, `block`, `suggest`, or `dry-run`.        |
| `minimumConfidence` | `0.6`                      | Minimum classification confidence accepted by validation.             |
| `diffDisplay`       | `summary`                  | Decision display preference: `none`, `summary`, or `unified`.         |
| `logRawPrompts`     | `false`                    | Allows raw prompt logging only when explicitly enabled.               |
| `storeRawPrompts`   | `false`                    | Allows raw prompt storage only when explicitly enabled.               |
| `modelSessionID`    | `opencandor-model-session` | OpenCode plugin session used for model calls.                         |

Unknown config options are rejected. Unsupported host/mode combinations are rejected instead of silently degrading to misleading behavior.

## Privacy Policy

OpenCandor is private by default:

- Raw prompts are not logged by default.
- Raw prompts are not stored by default.
- OpenCode decision logs contain privacy-safe metadata: action, outcome, confidence, risk, safety flags, and validation issues.
- The hook CLI does not persist prompts; it reads hook JSON from stdin and writes host-compatible output to stdout.

If `logRawPrompts` or `storeRawPrompts` is enabled in future integrations, treat that as an explicit privacy boundary change and document where data is written.

## Threat Model And Safety Caveats

OpenCandor treats the user's prompt as inert data during rewrite. The rewrite contract requires the model to return structured JSON and preserve intent.

Safety checks are designed to reduce these risks:

- Prompt laundering: unsafe raw intent must not be rewritten into a harmless-looking request.
- Intent loss: paths, commands, quoted strings, urgency, and important terms should not be dropped.
- Low-confidence rewrites: uncertain rewrites are blocked instead of sent downstream.
- Host capability confusion: hook-only hosts must not claim transparent replacement.

OpenCandor is not a security sandbox. It does not prove a prompt is safe, prevent every malicious instruction, or replace host-side permissions, code review, secrets hygiene, or command approval. A blocked or rewritten prompt should still be reviewed in context.

## Development

Run focused tests while changing code:

```bash
pnpm test
```

Run the full quality gate before release work:

```bash
pnpm check
```
