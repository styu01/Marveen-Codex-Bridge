import { loadConfig } from './config.js'
import { ProcessLock } from './process-lock.js'
import { BridgeService } from './service.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const lock = new ProcessLock(config.storage.lockFile)
  lock.acquire()
  const service = new BridgeService(config)
  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    service.logger.info('Shutdown signal received', { signal })
    try {
      await service.stop()
    } finally {
      lock.release()
    }
  }
  process.once('SIGTERM', () => void stop('SIGTERM'))
  process.once('SIGINT', () => void stop('SIGINT'))
  process.once('uncaughtException', (error) => {
    service.logger.error('Uncaught exception', { error: error.message, stack: error.stack })
    void stop('uncaughtException').finally(() => { process.exitCode = 1 })
  })
  process.once('unhandledRejection', (error) => {
    service.logger.error('Unhandled rejection', { error: String(error) })
    void stop('unhandledRejection').finally(() => { process.exitCode = 1 })
  })
  await service.start()
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    time: new Date().toISOString(),
    level: 'error',
    message: 'Bridge startup failed',
    error: (error as Error).message,
  })}\n`)
  process.exitCode = 1
})
