#!/usr/bin/env node

import { createHookCliProcessor, parseHookCliArgs } from "./index.js"

const readStdin = async (): Promise<string> => {
  const chunks: string[] = []
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk))
  }

  return chunks.join("")
}

const { host, mode } = parseHookCliArgs(process.argv)
const input = await readStdin()
const result = await createHookCliProcessor()({ host, mode, input })

if (result.stdout !== "") {
  process.stdout.write(result.stdout)
}
if (result.stderr !== "") {
  process.stderr.write(result.stderr)
}
process.exitCode = result.exitCode
