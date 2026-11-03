#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  createLoopbackAdminClient,
  createMutationSnapshot,
  preflightProductionCanary,
  readPrivateToken,
  runProductionCanary,
} from '../src/production-canary.mjs'
import {
  createMarveenAdminClient,
  readCutoverToken,
  runFederationCanary,
} from '../src/federation-cutover-api.mjs'

const home = homedir()
const options = {
  execute: false,
  bridgeOrigin: 'http://127.0.0.1:3431',
  bridgeTokenFile: join(home, '.config/marveen-codex-bridge/admin.token'),
  bridgeConfig: join(home, '.config/marveen-codex-bridge/config.json'),
  historyPath: join(home, '.config/marveen-codex-bridge/agent-settings-history'),
  currentRelease: join(home, '.local/share/marveen-codex-bridge/current'),
  marveenOrigin: 'http://127.0.0.1:3420',
  marveenTokenFile: join(home, 'marveen/store/.dashboard-token'),
  marveenRoot: join(home, 'marveen'),
  expectedMarveenVersion: '1.34.1',
  mainAgentId: 'bela',
  peerId: 'codex',
  remoteAgentId: 'programozo',
}

function usage() {
  console.log(`Usage: production-canary-0.3.3.mjs [options]

Default mode is read-only preflight. Mutating Terra -> Sol -> Terra and
Federation canaries require --execute.

Options:
  --execute
  --bridge-origin URL
  --bridge-token-file PATH
  --bridge-config PATH
  --history-path PATH
  --current-release PATH
  --marveen-origin URL
  --marveen-token-file PATH
  --marveen-root PATH
  --expected-marveen-version VERSION
  --main-agent-id ID
  --peer-id ID
  --remote-agent-id ID`)
}

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  const take = () => {
    index += 1
    if (index >= process.argv.length) throw new Error(`${arg} requires a value`)
    return process.argv[index]
  }
  if (arg === '--execute') options.execute = true
  else if (arg === '--bridge-origin') options.bridgeOrigin = take()
  else if (arg === '--bridge-token-file') options.bridgeTokenFile = resolve(take())
  else if (arg === '--bridge-config') options.bridgeConfig = resolve(take())
  else if (arg === '--history-path') options.historyPath = resolve(take())
  else if (arg === '--current-release') options.currentRelease = resolve(take())
  else if (arg === '--marveen-origin') options.marveenOrigin = take()
  else if (arg === '--marveen-token-file') options.marveenTokenFile = resolve(take())
  else if (arg === '--marveen-root') options.marveenRoot = resolve(take())
  else if (arg === '--expected-marveen-version') options.expectedMarveenVersion = take()
  else if (arg === '--main-agent-id') options.mainAgentId = take()
  else if (arg === '--peer-id') options.peerId = take()
  else if (arg === '--remote-agent-id') options.remoteAgentId = take()
  else if (arg === '--help' || arg === '-h') {
    usage()
    process.exit(0)
  } else throw new Error(`Unknown option: ${arg}`)
}

function requireService(name, active) {
  const result = spawnSync('systemctl', ['--user', 'is-active', '--quiet', name])
  if ((result.status === 0) !== active) {
    throw new Error(`${name} must be ${active ? 'active' : 'inactive'}`)
  }
}

function requirePrivateConfig(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('Bridge config must be a private regular non-symlink file')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Bridge config must be owned by the service user')
  }
}

function installedVersion() {
  const stat = lstatSync(options.currentRelease)
  if (!stat.isSymbolicLink()) throw new Error('Active release pointer is missing')
  const target = realpathSync(options.currentRelease)
  return JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version
}

function marveenVersion() {
  return JSON.parse(readFileSync(join(options.marveenRoot, 'package.json'), 'utf8')).version
}

async function main() {
  if (!process.versions.node.startsWith('22.')) throw new Error('Node 22 is required')
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Refusing root production canary')
  }
  requireService('marveen-codex-bridge.service', true)
  requireService('bela-codex-bridge.service', false)
  if (installedVersion() !== '0.3.3') throw new Error('Active Bridge must be version 0.3.3')
  if (marveenVersion() !== options.expectedMarveenVersion) {
    throw new Error(`Marveen must be version ${options.expectedMarveenVersion}`)
  }
  requirePrivateConfig(options.bridgeConfig)
  const bridgeToken = readPrivateToken(options.bridgeTokenFile)
  const marveenToken = readCutoverToken(options.marveenTokenFile)
  const bridgeRequest = createLoopbackAdminClient({
    origin: options.bridgeOrigin,
    token: bridgeToken,
  })
  const marveenRequest = createMarveenAdminClient({
    origin: options.marveenOrigin,
    token: marveenToken,
  })
  await preflightProductionCanary({
    bridgeRequest,
    marveenRequest,
    peerId: options.peerId,
  })
  if (!options.execute) {
    console.log('RESULT: 0.3.3 PRODUCTION CANARY READ-ONLY PREFLIGHT PASS')
    return
  }
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const result = await runProductionCanary({
    bridgeRequest,
    marveenRequest,
    runFederationCanary,
    snapshot: createMutationSnapshot({
      configPath: options.bridgeConfig,
      historyPath: options.historyPath,
    }),
    actor: `v033-canary-${stamp}`,
    markerTimestamp: stamp,
    mainAgentId: options.mainAgentId,
    peerId: options.peerId,
    remoteAgentId: options.remoteAgentId,
  })
  console.log(JSON.stringify(result))
  console.log('RESULT: 0.3.3 WSL SYSTEMD MODEL SELECTION AND MARVEEN 1.34.1 CANARY PASS')
}

const invoked = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invoked) {
  main().catch((error) => {
    console.error(`FAIL: ${error?.code ?? 'production_canary_failed'}: ${error?.message ?? String(error)}`)
    process.exitCode = 1
  })
}
