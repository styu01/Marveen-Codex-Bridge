#!/usr/bin/env node
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BRIDGE_ALLOWED_MODELS } from '../src/model-policy.mjs'

if (process.argv.length !== 5) {
  throw new Error('usage: migrate-models-0.3.3.mjs ORIGINAL_CONFIG NEW_CODEX_BINARY OUTPUT_CONFIG')
}
const [source, newBinary, output] = process.argv.slice(2).map((arg) => resolve(arg))
if (source === output) throw new Error('never overwrite the source configuration')
const stat = lstatSync(source)
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
  throw new Error('source config must be a private regular file')
}
if (stat.uid !== process.getuid()) throw new Error('source config owner mismatch')
const config = JSON.parse(readFileSync(source, 'utf8'))
if (config.version !== 1 || !config.codex || !Array.isArray(config.agents)) {
  throw new Error('unexpected configuration format')
}
if (config.codex.expectedVersion !== '0.145.0') {
  throw new Error('expected a 0.3.2 baseline with Codex 0.145.0')
}
// In 0.3.2 `codex.allowedModels` was OPTIONAL. Its runtime loader used
// [gpt-5.6-terra, gpt-5.6-sol] when the property was absent or null.
// Keep that behavior while migrating, rather than rejecting a valid 0.3.2
// production configuration. An explicitly supplied list may also contain
// only one of the legacy IDs, or custom models; preserve its existing order.
const baselineModels = ['gpt-5.6-terra', 'gpt-5.6-sol']
const configured = config.codex.allowedModels
const existing = configured == null ? baselineModels : configured
const validModel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
if (
  !Array.isArray(existing) || existing.length < 1 || existing.length > 20
  || existing.some((model) => typeof model !== 'string' || !validModel.test(model))
  || new Set(existing).size !== existing.length
) {
  throw new Error('invalid existing model allowlist')
}
const merged = [...new Set([...existing, ...BRIDGE_ALLOWED_MODELS])]
if (merged.length > 20) throw new Error('allowlist would exceed 20 models')
config.codex.allowedModels = merged
config.codex.binary = newBinary
config.codex.expectedVersion = '0.164.0'
// Do NOT change the running agent's selected model, reasoning effort, role, permissions, or secrets.
writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
chmodSync(output, 0o600)
process.stdout.write(`PASS: preserved ${existing.length} model(s), migrated to ${merged.length}; active model unchanged\n`)
