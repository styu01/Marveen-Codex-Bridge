import { mkdirSync } from 'node:fs'
import type { BridgeConfig } from './config.js'
import { BridgeDatabase } from './db/database.js'
import { RepositorySet } from './db/repositories.js'
import { Logger } from './logging.js'
import { RuntimeManager } from './runtime/runtime-manager.js'
import { CodexSupervisor } from './codex/supervisor.js'
import { RunEngine } from './runs/run-engine.js'
import { ApprovalBroker } from './runs/approval-broker.js'
import { BridgeApiServer } from './api/server.js'
import { OutboxWorker } from './callbacks/outbox-worker.js'

export class BridgeService {
  readonly logger: Logger
  readonly database: BridgeDatabase
  readonly repos: RepositorySet
  readonly runtime: RuntimeManager
  readonly supervisor: CodexSupervisor
  readonly runs: RunEngine
  readonly approvals: ApprovalBroker
  readonly api: BridgeApiServer
  readonly outbox: OutboxWorker

  private stopping = false

  constructor(readonly config: BridgeConfig) {
    this.logger = new Logger(config.logging.level)
    mkdirSync(config.storage.runtimeRoot, { recursive: true, mode: 0o700 })
    this.database = new BridgeDatabase(config.storage.database)
    this.database.migrate()
    this.repos = new RepositorySet(this.database.raw)
    this.runtime = new RuntimeManager(config)

    let approvalBroker: ApprovalBroker | null = null
    let runEngine: RunEngine | null = null
    this.supervisor = new CodexSupervisor(
      config,
      this.logger,
      (request) => {
        if (request.method === 'item/tool/call') {
          if (!runEngine) throw new Error('Run engine is not initialized')
          return runEngine.handleDynamicToolCall(request)
        }
        if (!approvalBroker) throw new Error('Approval broker is not initialized')
        return approvalBroker.handle(request)
      },
    )
    this.runs = new RunEngine(config, this.repos, this.runtime, this.supervisor, this.logger)
    runEngine = this.runs
    this.approvals = new ApprovalBroker(
      this.database.raw,
      this.logger,
      (request) => this.runs.resolveRunForServerRequest(request),
      () => this.supervisor.generation,
    )
    approvalBroker = this.approvals
    this.api = new BridgeApiServer(
      config,
      this.repos,
      this.runtime,
      this.runs,
      this.approvals,
      this.supervisor,
      this.logger,
    )
    this.outbox = new OutboxWorker(config, this.repos.outbox, this.logger)
  }

  async start(): Promise<void> {
    const recovered = this.runs.recover()
    if (recovered) this.logger.warn('Recovered active runs as interrupted_unknown', { count: recovered })
    await this.api.start()
    this.outbox.start()
    try {
      const client = await this.supervisor.start()
      this.logger.info('Bridge service ready', {
        appServerPending: client.pendingCount,
        generation: this.supervisor.generation,
      })
    } catch (error) {
      this.logger.error('Bridge started in not-ready state', { error: (error as Error).message })
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.logger.info('Bridge graceful shutdown started')
    await this.api.stop()
    await this.runs.shutdown()
    this.approvals.shutdown()
    await this.outbox.drain(5000)
    this.outbox.stop()
    await this.supervisor.stop()
    this.database.close()
    this.logger.info('Bridge graceful shutdown complete')
  }
}
