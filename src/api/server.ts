import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname } from 'node:path'
import type { BridgeConfig } from '../config.js'
import { asBridgeError, BridgeError } from '../errors.js'
import type { Logger } from '../logging.js'
import type { RepositorySet } from '../db/repositories.js'
import type { RuntimeManager } from '../runtime/runtime-manager.js'
import type { RunEngine } from '../runs/run-engine.js'
import type { ApprovalBroker } from '../runs/approval-broker.js'
import type { CodexSupervisor } from '../codex/supervisor.js'
import {
  BELA_DYNAMIC_TOOL_CONTRACT_REVISION,
  BELA_DYNAMIC_TOOLS,
  BELA_TOOL_SPECS,
} from '../tools/bela-tools.js'
import { authorized } from './auth.js'

const AGENT_ID = /^[a-z][a-z0-9-]{1,62}$/

function send(response: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(`${JSON.stringify(body)}\n`)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(data)
}

function routePath(request: IncomingMessage): URL {
  return new URL(request.url ?? '/', 'http://localhost')
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new BridgeError('body_too_large', 'Request body exceeds configured limit', 413)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeError('invalid_json', 'Request body is not valid JSON', 400)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeError('invalid_body', 'Request body must be a JSON object', 400)
  }
  return parsed as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string, max = 10000): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new BridgeError('validation_error', `${key} must be a non-empty string`, 400)
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw new BridgeError('validation_error', `${key} is too long`, 400)
  }
  return value.trim()
}

function optionalString(body: Record<string, unknown>, key: string, fallback: string, max = 100000): string {
  const value = body[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) {
    throw new BridgeError('validation_error', `${key} must be a string within the size limit`, 400)
  }
  return value
}

function enumValue<T extends string>(
  body: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = body[key] ?? fallback
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BridgeError('validation_error', `${key} must be one of: ${allowed.join(', ')}`, 400)
  }
  return value as T
}

function bool(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new BridgeError('validation_error', `${key} must be boolean`, 400)
  return value
}

function integer(body: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = body[key] ?? fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BridgeError('validation_error', `${key} must be an integer between ${min} and ${max}`, 400)
  }
  return value as number
}

function validateAgentId(value: string): string {
  if (!AGENT_ID.test(value)) throw new BridgeError('invalid_agent_id', `Invalid agent id: ${value}`, 400)
  return value
}

export class BridgeApiServer {
  private server: Server | null = null
  private accepting = false
  private testPortValue: number | null = null

  constructor(
    private readonly config: BridgeConfig,
    private readonly repos: RepositorySet,
    private readonly runtime: RuntimeManager,
    private readonly runs: RunEngine,
    private readonly approvals: ApprovalBroker,
    private readonly supervisor: CodexSupervisor,
    private readonly logger: Logger,
  ) {}

  get isListening(): boolean { return this.accepting }
  get testPort(): number | null { return this.testPortValue }

  private withProviderCapabilities<T extends Record<string, unknown>>(agent: T): T & {
    capabilities: {
      imageGeneration: boolean
      imageModel: string | null
    }
  } {
    return {
      ...agent,
      capabilities: {
        imageGeneration: this.supervisor.providerCapabilities.imageGeneration,
        imageModel: this.supervisor.providerCapabilities.imageGeneration
          ? 'gpt-image-2'
          : null,
      },
    }
  }

  async start(): Promise<void> {
    if (this.server) return
    mkdirSync(dirname(this.config.api.unixSocket), { recursive: true, mode: 0o700 })
    if (existsSync(this.config.api.unixSocket)) {
      if (!lstatSync(this.config.api.unixSocket).isSocket()) {
        throw new BridgeError('socket_path_conflict', 'Configured Unix socket path exists and is not a socket', 500)
      }
      unlinkSync(this.config.api.unixSocket)
    }
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const bridgeError = asBridgeError(error)
        this.logger.error('Bridge API request failed', {
          method: request.method,
          url: request.url,
          code: bridgeError.code,
          error: bridgeError.message,
        })
        if (!response.headersSent) {
          send(response, bridgeError.status, {
            error: {
              code: bridgeError.code,
              message: bridgeError.message,
              requestId: request.headers['x-request-id'] ?? null,
              details: bridgeError.details ?? null,
            },
          })
        } else {
          response.destroy()
        }
      })
    })
    server.requestTimeout = this.config.codex.turnTimeoutMs + 60000
    server.headersTimeout = 15000
    server.keepAliveTimeout = 5000
    const testTcp = process.env.BELA_CODEX_BRIDGE_TEST_TCP === '1'
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      const ready = () => {
        server.off('error', reject)
        const address = server.address()
        this.testPortValue = address && typeof address === 'object' ? address.port : null
        resolve()
      }
      if (testTcp) server.listen(0, '127.0.0.1', ready)
      else server.listen(this.config.api.unixSocket, ready)
    })
    if (!testTcp) chmodSync(this.config.api.unixSocket, this.config.api.socketMode)
    this.server = server
    this.accepting = true
    this.logger.info('Bridge API listening', { socket: this.config.api.unixSocket })
  }

  async stop(): Promise<void> {
    this.accepting = false
    const server = this.server
    this.server = null
    this.testPortValue = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.env.BELA_CODEX_BRIDGE_TEST_TCP !== '1') {
      try { unlinkSync(this.config.api.unixSocket) } catch {}
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = routePath(request)
    const method = request.method ?? 'GET'

    if (method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, {
        status: 'ok',
        service: 'bela-codex-bridge',
        version: '0.2.1',
      })
      return
    }
    if (method === 'GET' && url.pathname === '/readyz') {
      const ready = this.supervisor.online && this.supervisor.compatible
      send(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        appServerOnline: this.supervisor.online,
        compatible: this.supervisor.compatible,
        generation: this.supervisor.generation,
      })
      return
    }

    if (!authorized(request, this.config.auth.token)) {
      send(response, 401, { error: { code: 'unauthorized', message: 'Bearer token required' } })
      return
    }

    if (method === 'GET' && url.pathname === '/v1/meta') {
      send(response, 200, {
        apiVersion: 'v1',
        bridgeVersion: '0.2.1',
        node: process.version,
        codex: {
          expectedVersion: this.config.codex.expectedVersion,
          model: this.config.codex.model,
          reasoningEfforts: ['medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'medium',
          appServerGeneration: this.supervisor.generation,
          online: this.supervisor.online,
          compatible: this.supervisor.compatible,
          providerCapabilities: this.supervisor.providerCapabilities,
          imageGeneration: {
            available: this.supervisor.providerCapabilities.imageGeneration,
            model: 'gpt-image-2',
            effort: null,
            transport: 'codex-app-server',
            billing: 'chatgpt-subscription',
          },
        },
        toolContract: {
          revision: BELA_DYNAMIC_TOOL_CONTRACT_REVISION,
          exposure: ['dynamicTools', 'mcpInventory'],
          tools: BELA_DYNAMIC_TOOLS.map((tool) => tool.name),
          mcpTools: BELA_TOOL_SPECS.map((tool) => tool.name),
        },
        limits: this.config.runs,
      })
      return
    }

    if (method === 'GET' && url.pathname === '/v1/agents') {
      send(response, 200, { data: this.repos.agents.list() })
      return
    }

    const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/)
    if (agentMatch) {
      const agentId = validateAgentId(decodeURIComponent(agentMatch[1]!))
      if (method === 'GET') {
        const agent = this.repos.agents.get(agentId)
        if (!agent) throw new BridgeError('agent_not_found', `Unknown agent: ${agentId}`, 404)
        send(response, 200, {
          data: {
            ...agent,
            thread: this.repos.threads.get(agentId),
            runtime: this.runtime.describe(agentId),
            capabilities: {
              imageGeneration: this.supervisor.providerCapabilities.imageGeneration,
              imageModel: this.supervisor.providerCapabilities.imageGeneration
                ? 'gpt-image-2'
                : null,
            },
          },
        })
        return
      }
      if (method === 'PUT') {
        const body = await readJson(request, this.config.api.maxBodyBytes)
        const existing = this.repos.agents.get(agentId)
        const reasoningEffort = enumValue(
          body,
          'reasoningEffort',
          ['medium', 'high', 'xhigh'] as const,
          'medium',
        )
        if (
          existing
          && existing.reasoningEffort !== reasoningEffort
          && this.runs.isAgentBusy(agentId)
        ) {
          throw new BridgeError(
            'agent_busy',
            'Cannot change reasoning effort while the agent has an active run',
            409,
          )
        }
        const workspaceMode = enumValue(body, 'workspaceMode', ['directory', 'worktree'] as const, 'directory')
        const workspacePath = this.runtime.prepareWorkspace(
          agentId,
          requiredString(body, 'workspacePath', 4096),
          workspaceMode,
        )
        const agent = this.repos.agents.upsert({
          agentId,
          displayName: optionalString(body, 'displayName', agentId, 200).trim() || agentId,
          model: optionalString(body, 'model', this.config.codex.model, 200),
          reasoningEffort,
          workspacePath,
          workspaceMode,
          sandboxMode: enumValue(
            body,
            'sandboxMode',
            ['read-only', 'workspace-write', 'danger-full-access'] as const,
            'workspace-write',
          ),
          approvalPolicy: enumValue(body, 'approvalPolicy', ['never', 'bela'] as const, 'bela'),
          networkEnabled: bool(body, 'networkEnabled', false),
          instructions: optionalString(body, 'instructions', '', 256 * 1024),
        })
        if (existing && agent.configRevision !== existing.configRevision) {
          this.repos.threads.invalidate(agentId)
        }
        this.runtime.compile(agent)
        send(response, 200, {
          data: this.withProviderCapabilities(agent as unknown as Record<string, unknown>),
        })
        return
      }
      if (method === 'DELETE') {
        const existing = this.repos.agents.get(agentId)
        if (!existing) throw new BridgeError('agent_not_found', `Unknown agent: ${agentId}`, 404)
        await this.runs.stopAgent(agentId)
        const archivedRuntime = this.runtime.archiveAgent(agentId)
        this.repos.agents.remove(agentId)
        send(response, 200, { data: { agentId, deleted: true, archivedRuntime } })
        return
      }
    }

    const lifecycleMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(start|stop|restart|fresh-thread)$/)
    if (lifecycleMatch && method === 'POST') {
      const agentId = validateAgentId(decodeURIComponent(lifecycleMatch[1]!))
      const action = lifecycleMatch[2]
      if (action === 'start') {
        send(response, 200, {
          data: this.withProviderCapabilities(
            await this.runs.startAgent(agentId) as unknown as Record<string, unknown>,
          ),
        })
      } else if (action === 'stop') {
        send(response, 200, {
          data: this.withProviderCapabilities(
            await this.runs.stopAgent(agentId) as unknown as Record<string, unknown>,
          ),
        })
      } else if (action === 'restart') {
        send(response, 200, {
          data: this.withProviderCapabilities(
            await this.runs.restartAgent(agentId) as unknown as Record<string, unknown>,
          ),
        })
      }
      else {
        this.runs.freshThread(agentId)
        send(response, 202, { data: { agentId, threadReset: true } })
      }
      return
    }

    const runsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/runs$/)
    if (runsMatch && method === 'POST') {
      const agentId = validateAgentId(decodeURIComponent(runsMatch[1]!))
      const key = request.headers['idempotency-key']
      if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
        throw new BridgeError('idempotency_key_required', 'Idempotency-Key header must contain 8-200 characters', 400)
      }
      const body = await readJson(request, this.config.api.maxBodyBytes)
      const context = body.context === undefined
        ? {}
        : body.context && typeof body.context === 'object' && !Array.isArray(body.context)
          ? body.context as Record<string, unknown>
          : (() => { throw new BridgeError('validation_error', 'context must be an object', 400) })()
      const result = this.runs.submit({
        agentId,
        idempotencyKey: key,
        prompt: requiredString(body, 'prompt', this.config.runs.maxPromptBytes),
        context,
        priority: integer(body, 'priority', 0, -100, 100),
      })
      send(response, result.duplicate ? 200 : 202, {
        data: result.run,
        duplicate: result.duplicate,
      })
      return
    }

    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/)
    if (runMatch && method === 'GET') {
      const run = this.repos.runs.get(decodeURIComponent(runMatch[1]!))
      if (!run) throw new BridgeError('run_not_found', 'Run not found', 404)
      send(response, 200, {
        data: {
          ...run,
          artifacts: this.repos.artifacts.listForRun(run.runId),
        },
      })
      return
    }

    const runArtifactsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/artifacts$/)
    if (runArtifactsMatch && method === 'GET') {
      const runId = decodeURIComponent(runArtifactsMatch[1]!)
      if (!this.repos.runs.get(runId)) throw new BridgeError('run_not_found', 'Run not found', 404)
      send(response, 200, { data: this.repos.artifacts.listForRun(runId) })
      return
    }

    const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/)
    if (artifactMatch && method === 'GET') {
      const artifact = this.repos.artifacts.get(decodeURIComponent(artifactMatch[1]!))
      if (!artifact) throw new BridgeError('artifact_not_found', 'Artifact not found', 404)
      send(response, 200, { data: artifact })
      return
    }

    const eventMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/)
    if (eventMatch && method === 'GET') {
      const runId = decodeURIComponent(eventMatch[1]!)
      if (!this.repos.runs.get(runId)) throw new BridgeError('run_not_found', 'Run not found', 404)
      const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10)
      const limit = Math.min(2000, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '500', 10)))
      send(response, 200, { data: this.repos.events.list(runId, Number.isFinite(after) ? after : 0, limit) })
      return
    }

    const interruptMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/interrupt$/)
    if (interruptMatch && method === 'POST') {
      send(response, 202, { data: await this.runs.interrupt(decodeURIComponent(interruptMatch[1]!)) })
      return
    }

    if (url.pathname === '/v1/approvals' && method === 'GET') {
      send(response, 200, { data: this.approvals.list(url.searchParams.get('runId') ?? undefined) })
      return
    }

    const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/decision$/)
    if (approvalMatch && method === 'POST') {
      const body = await readJson(request, this.config.api.maxBodyBytes)
      const decision = enumValue(body, 'decision', ['approve', 'decline'] as const, 'decline')
      this.approvals.decide(decodeURIComponent(approvalMatch[1]!), decision)
      send(response, 200, { data: { approvalId: approvalMatch[1], decision } })
      return
    }

    throw new BridgeError('not_found', 'API route not found', 404)
  }
}
