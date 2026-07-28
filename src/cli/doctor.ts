import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { loadConfig } from '../config.js'

function commandOutput(binary: string, args: string[], timeout: number): string {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(output || `command exited with status ${String(result.status)}`)
  }
  return output
}

function check(label: string, fn: () => string): boolean {
  try {
    process.stdout.write(`PASS  ${label}: ${fn()}\n`)
    return true
  } catch (error) {
    process.stdout.write(`FAIL  ${label}: ${(error as Error).message}\n`)
    return false
  }
}

let passed = true
let config: ReturnType<typeof loadConfig> | undefined
try {
  config = loadConfig()
  process.stdout.write('PASS  configuration: valid\n')
} catch (error) {
  passed = false
  process.stdout.write(`FAIL  configuration: ${(error as Error).message}\n`)
}
if (config !== undefined) {
  const value: ReturnType<typeof loadConfig> = config
  passed = check('Node major', () => {
    if (process.versions.node.split('.')[0] !== '22') throw new Error(`expected 22, got ${process.version}`)
    return process.version
  }) && passed
  passed = check('Codex binary', () => {
    accessSync(value.codex.binary, constants.X_OK)
    return value.codex.binary
  }) && passed
  passed = check('Codex version', () => {
    const output = commandOutput(value.codex.binary, ['--version'], 15000)
    if (!output.includes(value.codex.expectedVersion)) throw new Error(output)
    return output
  }) && passed
  passed = check('ChatGPT login', () => {
    const output = commandOutput(value.codex.binary, ['login', 'status'], 30000)
    if (!/logged in/i.test(output)) throw new Error(output)
    return output
  }) && passed
  passed = check('runtime root', () => value.storage.runtimeRoot) && passed
  passed = check('token source', () => {
    const path = process.env.BELA_CODEX_BRIDGE_TOKEN_FILE
    if (path && (!existsSync(path) || !readFileSync(path, 'utf8').trim())) throw new Error('token file unavailable')
    return path ? 'file is readable' : 'environment variable'
  }) && passed
}
process.exitCode = passed ? 0 : 1
