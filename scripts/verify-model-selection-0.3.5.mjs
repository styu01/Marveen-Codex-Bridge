#!/usr/bin/env node
// Verify selection policy after activation without changing the chosen model.
import { readFileSync, lstatSync } from 'node:fs'
import { BRIDGE_ALLOWED_MODELS, effortsForModel } from '../src/model-policy.mjs'
const [configPath, tokenPath] = process.argv.slice(2)
if (!configPath || !tokenPath) throw Error('usage: verify-model-selection-0.3.5.mjs CONFIG TOKEN')
for (const p of [configPath, tokenPath]) {
  const s = lstatSync(p)
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid()) {
    throw Error('private file permission failure')
  }
}
const c = JSON.parse(readFileSync(configPath, 'utf8'))
const token = readFileSync(tokenPath, 'utf8').trim()
if (token.length < 32 || /[\r\n]/.test(token)) throw Error('invalid token file')
if (c.codex.turnTimeoutMs !== 2_700_000 || c.workers.runtimeLeaseMs !== 2_700_000
    || c.codex.expectedVersion !== '0.171.0') throw Error('45 minute timeouts or CLI pin changed')
for (const model of BRIDGE_ALLOWED_MODELS) {
  if (!c.codex.allowedModels.includes(model)) throw Error(`model ${model} missing from allowlist`)
}
const r = await fetch('http://127.0.0.1:3431/v1/dashboard/agent-settings', {
  headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
})
if (!r.ok) throw Error(`dashboard model API failed (${r.status})`)
const data = (await r.json())?.data
if (!data || !Array.isArray(data.selectableModels) || !data.effortsByModel) throw Error('malformed dashboard model response')
if (data.model !== c.agents[0].model || data.reasoningEffort !== c.agents[0].reasoningEffort) {
  throw Error('current model/effort was unexpectedly changed')
}
for (const model of data.selectableModels) {
  if (!BRIDGE_ALLOWED_MODELS.includes(model)) throw Error(`unauthorized model ${model} exposed`)
  if (JSON.stringify(data.effortsByModel[model]) !== JSON.stringify(effortsForModel(model))) {
    throw Error(`reasoning effort mismatch for ${model}`)
  }
}
const additions = ['gpt-6.1-terra','gpt-6.2-sol','gpt-6.2-astra']
const listed = additions.filter(m => data.selectableModels.includes(m))
if (listed.length === 0) throw Error('no new model exposed on dashboard')
console.log(`PASS: 9 models allowed, ${data.selectableModels.length} selectable, new ${listed.join(', ')}, active ${data.model}/${data.reasoningEffort} preserved`)
