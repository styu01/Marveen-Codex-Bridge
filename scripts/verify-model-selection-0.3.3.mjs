#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs'
import { BRIDGE_ALLOWED_MODELS, effortsForModel } from '../src/model-policy.mjs'

const [configPath, tokenPath] = process.argv.slice(2)
if (!configPath || !tokenPath) throw new Error('usage: verify-model-selection-0.3.3.mjs CONFIG TOKEN')
for (const path of [configPath, tokenPath]) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
    throw new Error('private file permissions invalid')
  }
}
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const token = readFileSync(tokenPath, 'utf8').trim()
if (token.length < 32 || /[\r\n]/.test(token)) throw new Error('invalid local admin token')
const r = await fetch('http://127.0.0.1:3431/v1/dashboard/agent-settings', {
  headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
})
if (!r.ok) throw new Error(`admin API failed (${r.status})`)
const settings = (await r.json())?.data
if (!settings || !Array.isArray(settings.selectableModels)) throw new Error('invalid settings response')
for (const model of ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6.1-sol']) {
  if (!settings.selectableModels.includes(model)) throw new Error(`${model} missing from selectable model list`)
}
if (!settings.effortsByModel || typeof settings.effortsByModel !== 'object') {
  throw new Error('model-specific effort catalog missing')
}
for (const model of settings.selectableModels) {
  if (BRIDGE_ALLOWED_MODELS.includes(model)) {
    const expected = effortsForModel(model)
    if (JSON.stringify(settings.effortsByModel[model]) !== JSON.stringify(expected)) {
      throw new Error(`reasoning effort mismatch for ${model}`)
    }
  }
}
if (settings.model !== config.agents[0].model || settings.reasoningEffort !== config.agents[0].reasoningEffort) {
  throw new Error('active model/effort changed unexpectedly')
}
process.stdout.write(`PASS: old models retained, GPT-6.1 Sol selectable; current model ${settings.model}/${settings.reasoningEffort} unchanged\n`)
