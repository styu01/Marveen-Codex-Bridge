#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createMarveenAdminClient,
  disableFederation,
  enableFederation,
  preflightFederation,
  readCutoverToken,
  runFederationCanary,
} from '../src/federation-cutover-api.mjs'

const home = homedir()
const options = {
  command: '',
  origin: 'http://127.0.0.1:3420',
  tokenFile: join(home, 'marveen/store/.dashboard-token'),
  peerId: 'codex',
  remoteAgentId: 'programozo',
  mainAgentId: 'bela',
  routingMode: 'advisory',
  marker: '',
}

function usage() {
  console.log(`Usage:
  federation-cutover-api.mjs COMMAND [options]

Commands:
  preflight-disabled   Require a reachable, disabled Federation configuration.
  preflight-paired     Also require the codex peer.
  enable               Enable advisory Federation and apply main-agent config.
  disable              Disable Federation (rollback safety boundary).
  canary               Verify Marveen -> Codex -> Marveen exactly once.

Options:
  --origin URL
  --token-file PATH
  --peer-id ID
  --remote-agent-id ID
  --main-agent-id ID
  --routing-mode strong|catalog-first|advisory
  --marker MARKER`)
}

options.command = process.argv[2] ?? ''
for (let index = 3; index < process.argv.length; index += 1) {
  const arg = process.argv[index]
  const take = () => {
    index += 1
    if (index >= process.argv.length) throw new Error(`${arg} requires a value`)
    return process.argv[index]
  }
  if (arg === '--origin') options.origin = take()
  else if (arg === '--token-file') options.tokenFile = take()
  else if (arg === '--peer-id') options.peerId = take()
  else if (arg === '--remote-agent-id') options.remoteAgentId = take()
  else if (arg === '--main-agent-id') options.mainAgentId = take()
  else if (arg === '--routing-mode') options.routingMode = take()
  else if (arg === '--marker') options.marker = take()
  else if (arg === '--help') {
    usage()
    process.exit(0)
  } else throw new Error(`Unknown option: ${arg}`)
}

try {
  const token = readCutoverToken(options.tokenFile)
  const request = createMarveenAdminClient({ origin: options.origin, token })
  let result
  if (options.command === 'preflight-disabled') {
    result = await preflightFederation({
      request,
      peerId: options.peerId,
      requirePeer: false,
    })
  } else if (options.command === 'preflight-paired') {
    result = await preflightFederation({
      request,
      peerId: options.peerId,
      requirePeer: true,
    })
  } else if (options.command === 'enable') {
    result = await enableFederation({
      request,
      peerId: options.peerId,
      routingMode: options.routingMode,
    })
  } else if (options.command === 'disable') {
    result = await disableFederation({ request })
  } else if (options.command === 'canary') {
    result = await runFederationCanary({
      request,
      mainAgentId: options.mainAgentId,
      peerId: options.peerId,
      remoteAgentId: options.remoteAgentId,
      marker: options.marker,
    })
  } else {
    usage()
    throw new Error('A valid command is required')
  }
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(`FAIL: ${error?.message ?? String(error)}`)
  process.exitCode = 1
}
