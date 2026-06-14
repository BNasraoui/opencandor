import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

for (const packageName of ["core", "opencode-plugin", "hooks-cli"]) {
  await import(`../packages/${packageName}/dist/index.js`)
}

const cliPath = join(root, "packages/hooks-cli/dist/cli.js")
assert.equal(existsSync(cliPath), true)
assert.match(readFileSync(cliPath, "utf8"), /^#!\/usr\/bin\/env node/)

for (const packageName of ["core", "opencode-plugin", "hooks-cli"]) {
  const distFiles = await readdir(join(root, `packages/${packageName}/dist`))

  assert.equal(
    distFiles.some((file) => file.endsWith(".map")),
    false,
  )
}
