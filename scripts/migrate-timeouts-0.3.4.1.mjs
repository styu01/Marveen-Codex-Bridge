#!/usr/bin/env node
// 0.3.4 -> 0.3.4.1 offline migration: never edits the source; atomic failure on invalid input.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw Error('usage: migrate-timeouts-0.3.4.1.mjs SOURCE_CONFIG OUTPUT_CONFIG')
if (resolve(source) === resolve(destination)) throw Error('source and destination must differ')
const stat = lstatSync(source)
if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
   (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
  throw Error('source config must be private, owned by user and not a symlink')
}
const buffer = readFileSync(source)
if (buffer.length > 128 * 1024) throw Error('config file exceeds size limit')
const data = JSON.parse(buffer.toString('utf8'))
if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
   !Array.isArray(data.agents) || !data.codex || typeof data.codex !== 'object' ||
   Array.isArray(data.codex) || !data.storage ||
   (data.workers !== undefined && (!data.workers || typeof data.workers !== 'object' || Array.isArray(data.workers)))) {
  throw Error('invalid Bridge config structure')
}
const check = (value, name, min) => {
  if (value !== undefined && value !== null &&
    (!Number.isSafeInteger(value) || value < min || value > 3_600_000)) {
    throw Error(`existing ${name} is invalid`)
  }
}
check(data.codex.turnTimeoutMs, 'codex.turnTimeoutMs', 10_000)
check(data.workers?.runtimeLeaseMs, 'workers.runtimeLeaseMs', 1_000)
const oldTurn = data.codex.turnTimeoutMs ?? 900_000
const oldLease = data.workers?.runtimeLeaseMs ?? 1_800_000
const TIMEOUT = 45 * 60 * 1000
// Explicit upgrade policy: both values become 45 minutes. Other config is preserved.
data.codex.turnTimeoutMs = TIMEOUT
data.workers ??= {}
data.workers.runtimeLeaseMs = TIMEOUT
writeFileSync(destination, `${JSON.stringify(data, null, 2)}\n`, {
  encoding: 'utf8', mode: 0o600, flag: 'wx',
})
console.log(`PASS: Codex turn ${oldTurn} -> ${TIMEOUT} ms; runtime lease ${oldLease} -> ${TIMEOUT} ms; source unchanged`)
