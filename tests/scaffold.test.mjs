import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import test from "node:test"

const root = fileURLToPath(new URL("..", import.meta.url))

const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"))

test("root project is a strict pnpm TypeScript workspace", () => {
  const packageJson = readJson("package.json")
  const tsconfig = readJson("tsconfig.base.json")

  assert.equal(packageJson.private, true)
  assert.match(packageJson.packageManager, /^pnpm@/)
  assert.equal(packageJson.engines.node, ">=22.13.0 <23 || >=24.0.0")
  assert.deepEqual(packageJson.workspaces, ["packages/*"])
  assert.equal(
    packageJson.scripts.check,
    "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm build:smoke",
  )
  assert.equal(tsconfig.compilerOptions.strict, true)
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true)
  assert.equal(tsconfig.compilerOptions.exactOptionalPropertyTypes, true)
  assert.equal(tsconfig.compilerOptions.noImplicitOverride, true)
  assert.equal(tsconfig.compilerOptions.noPropertyAccessFromIndexSignature, true)
})

test("expected packages exist and build independently", () => {
  for (const packageName of ["core", "opencode-plugin", "hooks-cli"]) {
    const packageJson = readJson(`packages/${packageName}/package.json`)

    assert.ok(existsSync(join(root, `packages/${packageName}/src/index.ts`)))
    assert.equal(packageJson.private, true)
    assert.equal(packageJson.publishConfig, undefined)
    assert.equal(packageJson.scripts.build, "tsc -p tsconfig.json")
    assert.equal(packageJson.scripts.prepack, "pnpm build")
    assert.equal(packageJson.scripts.typecheck, "tsc -p tsconfig.json --noEmit")
  }
})

test("scaffold packages do not add production dependencies before contracts exist", () => {
  for (const packagePath of [
    "packages/core/package.json",
    "packages/opencode-plugin/package.json",
    "packages/hooks-cli/package.json",
  ]) {
    const packageJson = readJson(packagePath)

    assert.deepEqual(packageJson.dependencies ?? {}, {})
  }
})

test("hooks CLI package declares an executable bin with a source entrypoint", () => {
  const packageJson = readJson("packages/hooks-cli/package.json")

  assert.equal(packageJson.bin["opencandor-hook"], "./dist/cli.js")
  assert.match(
    readFileSync(join(root, "packages/hooks-cli/src/cli.ts"), "utf8"),
    /^#!\/usr\/bin\/env node/,
  )
})

test("scaffold does not introduce provider-specific model SDKs", () => {
  const forbiddenDependencies = new Set([
    "openai",
    "@anthropic-ai/sdk",
    "ollama",
    "langchain",
    "@langchain/core",
    "ai",
  ])

  for (const packagePath of [
    "package.json",
    "packages/core/package.json",
    "packages/opencode-plugin/package.json",
    "packages/hooks-cli/package.json",
  ]) {
    const packageJson = readJson(packagePath)
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    }

    for (const dependencyName of Object.keys(dependencies)) {
      assert.equal(
        forbiddenDependencies.has(dependencyName),
        false,
        `${packagePath} must not depend on provider SDK ${dependencyName}`,
      )
    }
  }
})
