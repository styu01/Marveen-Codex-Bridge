#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  marveenSystemIdFromPairingResult,
  reconcileBridgePeerIdentity,
} from '../src/bridge-peer-reconciliation.mjs'

const home = homedir()
const options = {
  configPath: join(home, '.config/marveen-codex-bridge/config.json'),
  pairingResult: '',
  expectedBridgeSystemId: 'codex',
  execute: false,
}

function usage() {
  console.log(`Usage:
  reconcile-bridge-peer.mjs --pairing-result PATH [options]

Options:
  --config PATH
  --expected-bridge-system-id ID
  --execute

Without --execute the command validates and reports the required identity
change without modifying the Bridge configuration.`)
}

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  const take = () => {
    index += 1
    if (index >= process.argv.length) throw new Error(`${arg} requires a value`)
    return process.argv[index]
  }
  if (arg === '--config') options.configPath = take()
  else if (arg === '--pairing-result') options.pairingResult = take()
  else if (arg === '--expected-bridge-system-id') {
    options.expectedBridgeSystemId = take()
  } else if (arg === '--execute') options.execute = true
  else if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else throw new Error(`Unknown option: ${arg}`)
}

if (!options.pairingResult) throw new Error('--pairing-result is required')
const stat = lstatSync(options.pairingResult)
if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
  throw new Error('Pairing result must be a private regular non-symlink file')
}
if (stat.size > 512 * 1024) throw new Error('Pairing result is too large')
const pairing = JSON.parse(readFileSync(options.pairingResult, 'utf8'))
const marveenSystemId = marveenSystemIdFromPairingResult(pairing)
const result = reconcileBridgePeerIdentity({
  configPath: options.configPath,
  marveenSystemId,
  expectedBridgeSystemId: options.expectedBridgeSystemId,
  execute: options.execute,
})
console.log(JSON.stringify(result))
