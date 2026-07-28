import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { testConfig } from '../helpers.js'

test('doctor accepts Codex login status written to stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-doctor-'))
  const codex = join(root, 'codex.mjs')
  writeFileSync(codex, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.145.0\\n')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stderr.write('Logged in using ChatGPT\\n')
  process.exit(0)
}
process.exit(2)
`)
  chmodSync(codex, 0o755)

  const { auth: _auth, ...config } = testConfig(root)
  config.codex.binary = codex
  config.codex.restartBaseDelayMs = 100
  config.codex.restartMaxDelayMs = 1000
  config.callbacks.initialDelayMs = 100
  config.callbacks.maxDelayMs = 1000
  const configPath = join(root, 'config.json')
  const tokenPath = join(root, 'token')
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(tokenPath, 'x'.repeat(64))

  const result = spawnSync(process.execPath, [resolve('dist/src/cli/doctor.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BELA_CODEX_BRIDGE_CONFIG: configPath,
      BELA_CODEX_BRIDGE_TOKEN_FILE: tokenPath,
    },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PASS  ChatGPT login: Logged in using ChatGPT/)
})
