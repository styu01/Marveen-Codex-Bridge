import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import { BridgeError } from '../errors.js'
import type { Logger } from '../logging.js'

export interface RpcRequest {
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface RpcNotification {
  method: string
  params?: Record<string, unknown>
}

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export type ServerRequestHandler = (request: RpcRequest) => Promise<unknown>

export class CodexProtocolClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private stopping = false
  private invalidJsonCount = 0

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly requestTimeoutMs: number,
    private readonly startupTimeoutMs: number,
    private readonly logger: Logger,
    private readonly serverRequestHandler: ServerRequestHandler,
  ) {
    super()
  }

  get running(): boolean {
    return Boolean(this.process && !this.process.killed)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  get protocolErrorCount(): number {
    return this.invalidJsonCount
  }

  async start(): Promise<void> {
    if (this.process) return
    this.stopping = false
    this.process = spawn(this.binary, ['app-server', '--stdio'], {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process.once('error', (error) => this.handleExit(error))
    this.process.once('exit', (code, signal) => {
      if (!this.stopping) {
        this.handleExit(new BridgeError(
          'app_server_exit',
          `Codex App Server exited unexpectedly: code=${code}, signal=${signal}`,
          503,
        ))
      }
    })

    const stdout = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => void this.handleLine(line))
    const stderr = readline.createInterface({ input: this.process.stderr, crlfDelay: Infinity })
    stderr.on('line', (line) => this.logger.warn('codex app-server stderr', { line }))

    await this.request('initialize', {
      clientInfo: {
        name: 'bela_codex_bridge',
        title: 'Béla Codex Bridge',
        version: '0.1.8',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
        optOutNotificationMethods: [],
      },
    }, this.startupTimeoutMs)
    this.notify('initialized')
  }

  async stop(graceMs = 5000): Promise<void> {
    const child = this.process
    if (!child) return
    this.stopping = true
    this.process = null
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.stdin.end()
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs)
    await exited.catch(() => {})
    clearTimeout(timer)
    this.rejectAll(new BridgeError('app_server_stopped', 'Codex App Server stopped', 503))
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('rpc_timeout', `Codex RPC timeout: ${method}`, 504, { method }))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send(params ? { method, params } : { method })
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process || this.process.stdin.destroyed) {
      throw new BridgeError('app_server_offline', 'Codex App Server is not running', 503)
    }
    this.logger.debug('codex rpc send', {
      id: message.id,
      method: message.method,
    })
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      this.invalidJsonCount += 1
      this.logger.error('invalid JSON from Codex App Server', {
        preview: line.slice(0, 500),
        count: this.invalidJsonCount,
      })
      this.emit('protocol-error', { line })
      return
    }

    const id = message.id
    const method = typeof message.method === 'string' ? message.method : null
    if ((typeof id === 'number' || typeof id === 'string') && method) {
      try {
        const result = await this.serverRequestHandler({
          id,
          method,
          ...(message.params && typeof message.params === 'object'
            ? { params: message.params as Record<string, unknown> }
            : {}),
        })
        this.send({ id, result })
      } catch (error) {
        this.send({
          id,
          error: {
            code: -32000,
            message: (error as Error).message || 'Bridge rejected server request',
          },
        })
      }
      return
    }

    if (typeof id === 'number') {
      const pending = this.pending.get(id)
      if (!pending) {
        this.logger.warn('orphan Codex RPC response', { id })
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(id)
      if (message.error) {
        pending.reject(new BridgeError(
          'codex_rpc_error',
          `${pending.method}: ${JSON.stringify(message.error)}`,
          502,
          { method: pending.method },
        ))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (method) {
      const notification: RpcNotification = {
        method,
        ...(message.params && typeof message.params === 'object'
          ? { params: message.params as Record<string, unknown> }
          : {}),
      }
      this.emit('notification', notification)
      this.emit(`notification:${method}`, notification)
    }
  }

  private handleExit(error: Error): void {
    this.process = null
    this.rejectAll(error)
    this.emit('exit', error)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
