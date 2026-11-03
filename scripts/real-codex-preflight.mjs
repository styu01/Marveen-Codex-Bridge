#!/usr/bin/env node
import {
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { FederationDurabilityStore } from '../src/durability-store.mjs'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near '${key ?? ''}'`)
    }
    values[key.slice(2)] = value
  }
  return values
}

const args = parseArgs(process.argv.slice(2))
for (const required of ['codex-bin', 'better-sqlite3-path', 'output-root']) {
  if (!args[required]) throw new Error(`--${required} is required`)
}

const outputRoot = resolve(args['output-root'])
const runtimeRoot = resolve(outputRoot, 'runtime')
const workspacePath = resolve(outputRoot, 'workspace')
const database = resolve(outputRoot, 'state', 'federation.sqlite3')
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
mkdirSync(workspacePath, { recursive: true, mode: 0o700 })

const model = args.model ?? 'gpt-5.6-terra'
const expectedVersion = args['expected-version'] ?? '0.164.0'
const config = {
  storage: { database },
  codex: {
    binary: realpathSync(resolve(args['codex-bin'])),
    expectedVersion,
    runtimeRoot,
    startupTimeoutMs: 120_000,
    requestTimeoutMs: 120_000,
    turnTimeoutMs: 600_000,
  },
  agents: [{
    id: 'phase4preflight',
    displayName: 'Phase 4 preflight',
    model,
    capabilitySummary: 'Read-only App Server integration preflight.',
    workspacePath,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    reasoningEffort: 'high',
    networkEnabled: false,
    developerInstructions:
      'This is a read-only protocol preflight. Do not modify files and do not use external tools.',
  }],
}

const migrationStore = new FederationDurabilityStore(database, {
  driver: 'better-sqlite3',
  betterSqlite3Path: args['better-sqlite3-path'],
})
migrationStore.migrate()
migrationStore.close()

const events = []
const createRuntime = () => new CodexAppServerRuntime({
  config,
  betterSqlite3Path: args['better-sqlite3-path'],
  onEvent: (event, details) => {
    events.push({ time: new Date().toISOString(), event, details })
  },
})

let firstRuntime
let secondRuntime
try {
  firstRuntime = createRuntime()
  await firstRuntime.start()
  const first = await firstRuntime.run({
    agentId: 'phase4preflight',
    prompt:
      'Ne módosíts semmit és ne használj külső eszközt. '
      + 'A teljes válaszod pontosan egyetlen sor legyen: PHASE4_REAL_CODEX_FIRST_OK',
    context: { test: 'phase4-real-first' },
    idempotencyKey: 'phase4-real-first',
  })
  if (first.response.trim() !== 'PHASE4_REAL_CODEX_FIRST_OK') {
    throw new Error(`unexpected first response: ${JSON.stringify(first.response)}`)
  }
  const threadBefore = firstRuntime.state.getThread('phase4preflight')?.threadId
  if (!threadBefore) throw new Error('first run did not persist a thread')
  await firstRuntime.stop()
  firstRuntime = null

  secondRuntime = createRuntime()
  await secondRuntime.start()
  const second = await secondRuntime.run({
    agentId: 'phase4preflight',
    prompt:
      'Ne módosíts semmit és ne használj külső eszközt. '
      + 'A teljes válaszod pontosan egyetlen sor legyen: PHASE4_REAL_CODEX_RESTART_OK',
    context: { test: 'phase4-real-restart' },
    idempotencyKey: 'phase4-real-restart',
  })
  if (second.response.trim() !== 'PHASE4_REAL_CODEX_RESTART_OK') {
    throw new Error(`unexpected restart response: ${JSON.stringify(second.response)}`)
  }
  const threadAfter = secondRuntime.state.getThread('phase4preflight')?.threadId
  if (threadAfter !== threadBefore) {
    throw new Error(`thread changed across restart: ${threadBefore} -> ${threadAfter}`)
  }
  const duplicate = await secondRuntime.run({
    agentId: 'phase4preflight',
    prompt:
      'Ne módosíts semmit és ne használj külső eszközt. '
      + 'A teljes válaszod pontosan egyetlen sor legyen: PHASE4_REAL_CODEX_RESTART_OK',
    context: { test: 'phase4-real-restart' },
    idempotencyKey: 'phase4-real-restart',
  })
  if (!duplicate.duplicate || duplicate.runId !== second.runId) {
    throw new Error('runtime idempotency replay did not return the stored result')
  }
  const report = {
    result: 'PASS',
    model,
    expectedVersion,
    threadBefore,
    threadAfter,
    firstRunId: first.runId,
    secondRunId: second.runId,
    idempotentReplay: true,
    workspacePath,
    events,
  }
  writeFileSync(
    resolve(outputRoot, 'phase4-real-result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  )
  process.stdout.write('PASS: real Codex App Server handshake and model run\n')
  process.stdout.write('PASS: persistent thread resumed after complete App Server restart\n')
  process.stdout.write('PASS: persistent runtime idempotency returned the stored result\n')
  process.stdout.write(`Thread: ${threadAfter}\n`)
  process.stdout.write(`Report: ${resolve(outputRoot, 'phase4-real-result.json')}\n`)
  process.stdout.write('RESULT: PHASE 4 REAL CODEX PREFLIGHT PASS\n')
} finally {
  if (firstRuntime) await firstRuntime.stop().catch(() => {})
  if (secondRuntime) await secondRuntime.stop().catch(() => {})
}
