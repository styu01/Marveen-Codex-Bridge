#!/usr/bin/env node
// Offline, append-only model catalog migration for a running 0.3.4.1 installation.
// Deliberately does not change agent settings, permissions, timeouts, Federation or tokens.
import { chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { BRIDGE_ALLOWED_MODELS, isValidModelEffort } from '../src/model-policy.mjs'

const [sourceName, cliName, outputName] = process.argv.slice(2)
if (process.argv.length !== 5 || !sourceName || !cliName || !outputName) {
  throw Error('usage: migrate-models-0.3.5.mjs SOURCE_CONFIG NEW_CODEX_BINARY OUTPUT_CONFIG')
}
const source = resolve(sourceName), output = resolve(outputName)
if (source === output) throw Error('refusing to overwrite source configuration')
if (!isAbsolute(cliName)) throw Error('new Codex path must be absolute')
const stat = lstatSync(source)
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
  throw Error('source configuration must be private, owned, regular, non-symlink')
}
const bytes = readFileSync(source)
if (bytes.length > 128 * 1024) throw Error('oversized configuration')
const c = JSON.parse(bytes.toString('utf8'))
if (!c || c.version !== 1 || !c.codex || c.codex.expectedVersion !== '0.164.0'
    || !Array.isArray(c.agents) || c.agents.length < 1) {
  throw Error('expected a 0.3.4.1 configuration using Codex CLI 0.164.0')
}
if (c.codex.binary === cliName) throw Error('new CLI path must be different from the old one for rollback')
if (c.codex.turnTimeoutMs !== 2_700_000 || c.workers?.runtimeLeaseMs !== 2_700_000) {
  throw Error('45-minute Codex turn and runtime lease must already be configured; no automatic timeout changes')
}
const existing = c.codex.allowedModels ?? BRIDGE_ALLOWED_MODELS.slice(0, 6)
const name = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
if (!Array.isArray(existing) || existing.length < 1 || existing.length > 20
    || existing.some(m => typeof m !== 'string' || !name.test(m))
    || new Set(existing).size !== existing.length) throw Error('invalid old allowedModels')
const merged = [...new Set([...existing, ...BRIDGE_ALLOWED_MODELS])]
if (merged.length > 20) throw Error('merged model list too long')
for (const agent of c.agents) {
  if (!agent || !merged.includes(agent.model) || !isValidModelEffort(agent.model, agent.reasoningEffort ?? 'high', { existingConfig: true })) {
    throw Error('existing agent model/effort is invalid; refusing silent changes')
  }
}
c.codex.allowedModels = merged
c.codex.binary = resolve(cliName)
c.codex.expectedVersion = '0.171.0'
writeFileSync(output, JSON.stringify(c, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
chmodSync(output, 0o600)
process.stdout.write(`PASS: preserved ${existing.length} existing models; ${merged.length} allowed; CLI 0.171.0; active model/effort and 45-minute limits unchanged\n`)
