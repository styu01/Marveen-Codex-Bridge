import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/config.js'

const original = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
  Object.assign(process.env, original)
})

test('config rejects unknown keys and short secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-'))
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify({ codex: { surprise: true } }))
  process.env.BELA_CODEX_BRIDGE_TOKEN = 'x'.repeat(32)
  assert.throws(() => loadConfig(path), /Unknown config key/)

  writeFileSync(path, JSON.stringify({ logging: { level: 'debug' } }))
  process.env.BELA_CODEX_BRIDGE_TOKEN = 'short'
  assert.throws(() => loadConfig(path), /at least 32 bytes/)
})

test('config applies a valid strict override', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-config-'))
  const path = join(root, 'config.json')
  writeFileSync(path, JSON.stringify({
    storage: {
      database: join(root, 'db.sqlite3'),
      runtimeRoot: join(root, 'runtime'),
      lockFile: join(root, 'lock'),
    },
    api: { unixSocket: join(root, 'bridge.sock') },
    logging: { level: 'debug' },
  }))
  process.env.BELA_CODEX_BRIDGE_TOKEN = 'x'.repeat(32)
  const config = loadConfig(path)
  assert.equal(config.logging.level, 'debug')
  assert.equal(config.storage.database, join(root, 'db.sqlite3'))
})
