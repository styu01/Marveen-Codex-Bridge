#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { CodexProtocolClient } from '../src/codex-protocol-client.mjs'
import { BRIDGE_ALLOWED_MODELS } from '../src/model-policy.mjs'

const binary = process.argv[2]
if (!binary?.startsWith('/')) throw new Error('usage: check-codex-models-0.3.3.mjs /ABSOLUTE/CODEX/BINARY')
const runtime = mkdtempSync(join(tmpdir(), 'bridge-model-probe-'))
const client = new CodexProtocolClient({
  binary: resolve(binary), cwd: runtime,
  requestTimeoutMs: 45_000, startupTimeoutMs: 45_000,
  serverRequestHandler: () => { throw new Error('unexpected server request during catalog probe') },
})
try {
  await client.start()
  const result = await client.request('model/list', { includeHidden: false, limit: 100 }, 45_000)
  if (!Array.isArray(result?.data)) throw new Error('model/list did not return an array')
  const available = new Set(result.data.map((m) => m?.model ?? m?.id))
  const selectable = BRIDGE_ALLOWED_MODELS.filter((model) => available.has(model))
  process.stdout.write(`Available supported models: ${selectable.join(', ')}\n`)
  if (!available.has('gpt-6.1-sol')) {
    throw new Error('gpt-6.1-sol is not exposed to the new Codex CLI for this account; no production migration allowed')
  }
  for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol']) {
    if (!available.has(model)) {
      throw new Error(`legacy model ${model} unavailable in new CLI; rollback compatibility not proven`)
    }
  }
  process.stdout.write('PASS: GPT-6.1 Sol and both legacy models are discoverable\n')
} finally {
  await client.stop().catch(() => {})
  rmSync(runtime, { force: true, recursive: true })
}
