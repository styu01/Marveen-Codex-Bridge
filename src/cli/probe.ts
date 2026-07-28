import { loadConfig } from '../config.js'
import { Logger } from '../logging.js'
import { CodexSupervisor, declineUnknownServerRequest } from '../codex/supervisor.js'

const config = loadConfig()
const logger = new Logger(config.logging.level)
const supervisor = new CodexSupervisor(config, logger, declineUnknownServerRequest)

try {
  const binary = await supervisor.probeBinary()
  const client = await supervisor.start()
  process.stdout.write(`${JSON.stringify({
    status: 'compatible',
    binary,
    model: config.codex.model,
    generation: supervisor.generation,
    pendingRpc: client.pendingCount,
    protocolErrors: client.protocolErrorCount,
  }, null, 2)}\n`)
  await supervisor.stop()
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'incompatible',
    error: (error as Error).message,
  }, null, 2)}\n`)
  process.exitCode = 1
}
