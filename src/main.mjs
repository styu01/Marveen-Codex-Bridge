#!/usr/bin/env node
import { loadServiceConfig } from './config.mjs'
import { loadRuntimeModule } from './runtime-loader.mjs'
import { FederationBridgeService } from './service.mjs'
import { AgentSettingsManager } from './agent-settings-manager.mjs'

function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    time: new Date().toISOString(),
    level,
    event,
    ...fields,
  })}\n`)
}

const configPath = process.env.MARVEEN_CODEX_BRIDGE_CONFIG
const runtimeModule = process.env.MARVEEN_CODEX_BRIDGE_RUNTIME_MODULE
if (!configPath) throw new Error('MARVEEN_CODEX_BRIDGE_CONFIG is required')
if (!runtimeModule) throw new Error('MARVEEN_CODEX_BRIDGE_RUNTIME_MODULE is required')

const config = loadServiceConfig(configPath)
const runtime = await loadRuntimeModule(runtimeModule, {
  config,
  environment: process.env,
  onEvent(event, fields = {}) {
    log(event === 'app_server_stderr' ? 'warn' : 'info', event, fields)
  },
})

const settingsManager = new AgentSettingsManager({ configPath, config, runtime })
const service = new FederationBridgeService({ config, runtime, settingsManager })
if (typeof runtime.start === 'function') await runtime.start()
const endpoint = await service.start()
log('info', 'service_started', {
  bridgeVersion: '0.3.4',
  host: endpoint.host,
  port: endpoint.port,
  systemId: config.systemId,
})

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log('info', 'service_stopping', { signal })
  try {
    if (typeof runtime.prepareStop === 'function') runtime.prepareStop()
    if (service.server.listening) await service.stop()
    if (typeof runtime.stop === 'function') await runtime.stop()
    log('info', 'service_stopped')
    process.exitCode = 0
  } catch (error) {
    log('error', 'shutdown_failed', { message: error.message })
    process.exitCode = 1
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
