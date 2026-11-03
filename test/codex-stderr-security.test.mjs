import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CodexProtocolClient,
  sanitizeCodexStderr,
} from '../src/codex-protocol-client.mjs'
import { createRuntime } from '../src/codex-runtime-module.mjs'

test('Codex stderr is bounded and credential-shaped values are redacted', () => {
  const safe = sanitizeCodexStderr(
    '\u0000Authorization: Bearer secret-value '
      + '{"access_token":"oauth-secret","api_key":"key-secret"} '
      + 'OPENAI_API_KEY=environment-secret '
      + 'https://user:password@example.test/path?token=query-secret '
      + 'x'.repeat(3_000),
  )
  assert.doesNotMatch(
    safe,
    /secret-value|oauth-secret|key-secret|environment-secret|password|query-secret/,
  )
  assert.match(safe, /Bearer \[REDACTED\]/)
  assert.match(safe, /"access_token":"\[REDACTED\]"/)
  assert.match(safe, /\[TRUNCATED\]$/)
  assert.ok(safe.length < 2_100)
})

test('production runtime module forwards the service event callback', () => {
  const onEvent = () => {}
  const runtime = createRuntime({
    config: {
      agents: [{
        id: 'programozo',
        displayName: 'Programozó',
        model: 'gpt-5.6-terra',
      }],
    },
    environment: {},
    onEvent,
  })
  assert.equal(runtime.onEvent, onEvent)
})

test('unexpected Codex exit reports only a sanitized bounded stderr tail', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codex-stderr-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const fake = join(root, 'codex')
  writeFileSync(fake, `#!/usr/bin/env node
process.stderr.write('Authorization: Bearer live-secret\\n')
process.stderr.write('{"refresh_token":"refresh-secret"}\\n')
process.exit(1)
`)
  chmodSync(fake, 0o755)
  const observed = []
  const client = new CodexProtocolClient({
    binary: fake,
    cwd: root,
    requestTimeoutMs: 5_000,
    startupTimeoutMs: 5_000,
    environment: process.env,
    serverRequestHandler: async () => ({}),
    onStderr: (line) => observed.push(line),
  })
  await assert.rejects(
    client.start(),
    (error) => {
      assert.equal(error.code, 'app_server_exit')
      assert.doesNotMatch(error.message, /live-secret|refresh-secret/)
      assert.match(error.message, /Bearer \[REDACTED\]/)
      assert.deepEqual(error.details.stderrTail, observed)
      return true
    },
  )
})
