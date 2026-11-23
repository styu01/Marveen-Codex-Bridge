#!/usr/bin/env node
// Account-aware, read-only Codex App Server model/list probe (does not submit a turn).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { CodexProtocolClient } from '../src/codex-protocol-client.mjs'
import { BRIDGE_ALLOWED_MODELS } from '../src/model-policy.mjs'

const [binary, active] = process.argv.slice(2)
if (!binary || !isAbsolute(binary) || !active || !BRIDGE_ALLOWED_MODELS.includes(active)) {
  throw Error('usage: check-codex-models-0.3.5.mjs ABSOLUTE_NEW_CODEX_BINARY EXISTING_ACTIVE_MODEL')
}
const tmp = mkdtempSync(join(tmpdir(), 'bridge035-probe-'))
const client = new CodexProtocolClient({
  binary: resolve(binary), cwd: tmp,
  requestTimeoutMs: 60_000, startupTimeoutMs: 60_000,
  serverRequestHandler: () => { throw Error('unexpected App Server request during read-only model probe') },
})
try {
  await client.start()
  const result = await client.request('model/list', { includeHidden: false, limit: 100 }, 60_000)
  if (!Array.isArray(result?.data)) throw Error('model/list response missing data array')
  const available = new Set(result.data.map(m => m?.model ?? m?.id).filter(x => typeof x === 'string'))
  if (!available.has(active)) throw Error(`active model ${active} not present in CLI 0.171.0 model/list; refusing cutover`)
  const selectable = BRIDGE_ALLOWED_MODELS.filter(m => available.has(m))
  const additions = ['gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']
  const newAvailable = additions.filter(m => available.has(m))
  if (!newAvailable.length) throw Error('none of the three new models visible in model/list; refusing an upgrade with no benefit')
  console.log(`PASS: active model ${active} available; ${selectable.length}/9 selectable; new models: ${newAvailable.join(', ')}`)
  const unavailable = BRIDGE_ALLOWED_MODELS.filter(m => !available.has(m))
  if (unavailable.length) console.log(`NOTE: unavailable to this account/CLI (will not appear in selector): ${unavailable.join(', ')}`)
} finally {
  await client.stop().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
}
