#!/usr/bin/env node
// Offline only: writes a new private config; never mutates the source config.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw Error('usage: migrate-lease-0.3.4.mjs SOURCE_CONFIG OUTPUT_CONFIG')
if (resolve(source) === resolve(destination)) throw Error('output must differ from input')
const stat = lstatSync(source)
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
  throw Error('source config must be private and not a symlink')
}
const data = JSON.parse(readFileSync(source, 'utf8'))
if (!data || !Array.isArray(data.agents) || !data.codex || !data.storage ||
  (data.workers !== undefined && (typeof data.workers !== 'object' || data.workers === null || Array.isArray(data.workers)))) {
  throw Error('invalid Bridge config structure')
}
const old = data.workers?.runtimeLeaseMs ?? 120_000
if (!Number.isSafeInteger(old) || old < 1_000 || old > 3_600_000) {
  throw Error('existing runtimeLeaseMs out of supported range')
}
data.workers ??= {}
data.workers.runtimeLeaseMs = 1_800_000
writeFileSync(destination, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
console.log(`PASS: runtime lease ${old} ms -> 1800000 ms (30 minutes); original configuration unchanged`)
