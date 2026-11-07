import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const betterSqlite3Path = process.env.MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH
if (!betterSqlite3Path) {
  throw new Error('production driver path is required for the process test')
}

function privateFile(path, value) {
  writeFileSync(path, value, { mode: 0o600 })
  chmodSync(path, 0o600)
}

function waitForJsonLine(child, event, timeoutMs = 10_000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${event}; output=${buffer}`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines) {
        if (!line) continue
        const parsed = JSON.parse(line)
        if (parsed.event === event) {
          clearTimeout(timer)
          resolvePromise(parsed)
          return
        }
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`child exited before ${event}: code=${code} signal=${signal}`))
    })
  })
}

test('real entrypoint starts with production driver and stops cleanly', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-phase3-main-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  privateFile(join(root, 'admin.token'), 'admin-000000000000000000000000000001\n')
  privateFile(join(root, 'inbound.token'), 'inbound-0000000000000000000000000001\n')
  privateFile(join(root, 'outbound.token'), 'outbound-000000000000000000000000001\n')
  mkdirSync(join(root, 'runtime'))
  mkdirSync(join(root, 'workspace'))
  const configPath = join(root, 'config.json')
  privateFile(configPath, `${JSON.stringify({
    version: 1,
    systemId: 'codex',
    listen: { host: '127.0.0.1', port: 0 },
    storage: { database: './state/federation.sqlite3' },
    codex: {
      binary: process.execPath,
      expectedVersion: '0.164.0',
      runtimeRoot: join(root, 'runtime'),
    },
    admin: { tokenFile: './admin.token' },
    agents: [{
      id: 'programozo',
      displayName: 'Programozó',
      model: 'gpt-5.6-terra',
      workspacePath: join(root, 'workspace'),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      reasoningEffort: 'high',
    }],
    peers: [{
      id: 'marveen',
      baseUrl: 'http://127.0.0.1:3420',
      inboundTokenFile: './inbound.token',
      outboundTokenFile: './outbound.token',
    }],
    workers: { intervalMs: 1_000 },
  })}\n`)

  const child = spawn(process.execPath, [resolve('src/main.mjs')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      MARVEEN_CODEX_BRIDGE_CONFIG: configPath,
      MARVEEN_CODEX_BRIDGE_RUNTIME_MODULE:
        resolve('test/fixtures/mock-runtime-module.mjs'),
      MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH: betterSqlite3Path,
      NODE_OPTIONS: '--no-warnings',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const started = await waitForJsonLine(child, 'service_started')
  assert.equal(started.bridgeVersion, '0.3.4.1')
  const ready = await fetch(`http://127.0.0.1:${started.port}/readyz`)
  assert.equal(ready.status, 200)
  assert.equal((await ready.json()).status, 'ready')

  const stoppedLine = waitForJsonLine(child, 'service_stopped')
  child.kill('SIGTERM')
  await stoppedLine
  const exit = await new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  })
  assert.deepEqual(exit, { code: 0, signal: null })
  assert.equal(stderr, '')
})
