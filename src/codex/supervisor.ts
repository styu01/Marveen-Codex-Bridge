import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BridgeConfig } from '../config.js'
import { BridgeError } from '../errors.js'
import type { Logger } from '../logging.js'
import { CodexProtocolClient, type RpcRequest, type ServerRequestHandler } from './protocol-client.js'

const execFileAsync = promisify(execFile)

export class CodexSupervisor {
  private clientValue: CodexProtocolClient | null = null
  private generationValue = 0
  private compatibleValue = false
  private providerCapabilitiesValue = {
    imageGeneration: false,
    namespaceTools: false,
    webSearch: false,
  }
  private starting: Promise<CodexProtocolClient> | null = null
  private restartHistory: number[] = []

  constructor(
    private readonly config: BridgeConfig,
    private readonly logger: Logger,
    private readonly requestHandler: ServerRequestHandler,
  ) {}

  get generation(): number { return this.generationValue }
  get compatible(): boolean { return this.compatibleValue }
  get providerCapabilities(): Readonly<typeof this.providerCapabilitiesValue> {
    return this.providerCapabilitiesValue
  }
  get online(): boolean { return this.clientValue?.running ?? false }
  get client(): CodexProtocolClient {
    if (!this.clientValue?.running) throw new BridgeError('app_server_offline', 'Codex App Server is offline', 503)
    return this.clientValue
  }

  async probeBinary(): Promise<{ version: string; login: string }> {
    let versionOutput: string
    try {
      const result = await execFileAsync(this.config.codex.binary, ['--version'], { timeout: 15000 })
      versionOutput = `${result.stdout} ${result.stderr}`.trim()
    } catch (error) {
      throw new BridgeError('codex_binary_unavailable', `Cannot execute Codex CLI: ${(error as Error).message}`, 503)
    }
    if (!versionOutput.includes(this.config.codex.expectedVersion)) {
      throw new BridgeError(
        'codex_version_mismatch',
        `Expected Codex ${this.config.codex.expectedVersion}, received: ${versionOutput}`,
        503,
      )
    }
    let login = ''
    try {
      const result = await execFileAsync(this.config.codex.binary, ['login', 'status'], { timeout: 30000 })
      login = `${result.stdout} ${result.stderr}`.trim()
    } catch (error) {
      throw new BridgeError('auth_required', `Codex login status failed: ${(error as Error).message}`, 503)
    }
    if (!/logged in/i.test(login)) {
      throw new BridgeError('auth_required', `Codex is not logged in: ${login}`, 503)
    }
    return { version: versionOutput, login }
  }

  async start(): Promise<CodexProtocolClient> {
    if (this.clientValue?.running) return this.clientValue
    if (this.starting) return this.starting
    this.starting = this.doStart()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private async doStart(): Promise<CodexProtocolClient> {
    await this.probeBinary()
    const now = Date.now()
    this.restartHistory = this.restartHistory.filter(
      (timestamp) => now - timestamp <= this.config.codex.restartWindowMs,
    )
    if (this.restartHistory.length >= this.config.codex.maxRestartsInWindow) {
      throw new BridgeError('app_server_circuit_open', 'Codex App Server restart circuit is open', 503)
    }
    this.restartHistory.push(now)

    const client = new CodexProtocolClient(
      this.config.codex.binary,
      this.config.storage.runtimeRoot,
      this.config.codex.requestTimeoutMs,
      this.config.codex.startupTimeoutMs,
      this.logger,
      this.requestHandler,
    )
    client.on('exit', (error: Error) => {
      this.compatibleValue = false
      this.providerCapabilitiesValue = {
        imageGeneration: false,
        namespaceTools: false,
        webSearch: false,
      }
      if (this.clientValue === client) this.clientValue = null
      this.logger.error('Codex App Server exited', { error: error.message })
    })
    await client.start()
    await this.compatibilityProbe(client)
    this.generationValue += 1
    this.compatibleValue = true
    this.clientValue = client
    this.logger.info('Codex App Server ready', { generation: this.generationValue })
    return client
  }

  async stop(): Promise<void> {
    this.compatibleValue = false
    this.providerCapabilitiesValue = {
      imageGeneration: false,
      namespaceTools: false,
      webSearch: false,
    }
    const client = this.clientValue
    this.clientValue = null
    if (client) await client.stop()
  }

  async restart(): Promise<CodexProtocolClient> {
    await this.stop()
    return this.start()
  }

  private async compatibilityProbe(client: CodexProtocolClient): Promise<void> {
    const result = await client.request('model/list', { includeHidden: false, limit: 100 }, 60000) as {
      data?: Array<{ id?: string; model?: string }>
    }
    const models = (result.data ?? []).map((model) => model.model ?? model.id).filter(Boolean)
    if (!models.includes(this.config.codex.model)) {
      throw new BridgeError(
        'model_unavailable',
        `Configured model ${this.config.codex.model} is not available for this ChatGPT account`,
        503,
        { availableModels: models },
      )
    }
    const capabilities = await client.request(
      'modelProvider/capabilities/read',
      {},
      60000,
    ) as {
      imageGeneration?: unknown
      namespaceTools?: unknown
      webSearch?: unknown
    }
    this.providerCapabilitiesValue = {
      imageGeneration: capabilities.imageGeneration === true,
      namespaceTools: capabilities.namespaceTools === true,
      webSearch: capabilities.webSearch === true,
    }
    this.logger.info('Codex provider capabilities loaded', this.providerCapabilitiesValue)
  }
}

export function declineUnknownServerRequest(request: RpcRequest): Promise<unknown> {
  if (
    request.method === 'item/commandExecution/requestApproval'
    || request.method === 'item/fileChange/requestApproval'
  ) {
    return Promise.resolve({ decision: 'decline' })
  }
  if (request.method === 'item/tool/requestUserInput') return Promise.resolve({ answers: {} })
  if (request.method === 'mcpServer/elicitation/request') {
    return Promise.resolve({ action: 'decline', content: null, _meta: null })
  }
  throw new BridgeError('unsupported_server_request', `Unsupported Codex request: ${request.method}`, 400)
}
