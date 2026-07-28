import { EventEmitter } from 'node:events'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BridgeConfig } from '../config.js'
import type { RpcNotification, RpcRequest } from '../codex/protocol-client.js'
import { normalizeNotification, notificationIdentity, turnStatus } from '../codex/event-normalizer.js'
import type { CodexSupervisor } from '../codex/supervisor.js'
import { BridgeError } from '../errors.js'
import type { Logger } from '../logging.js'
import type { RepositorySet } from '../db/repositories.js'
import type { RuntimeManager } from '../runtime/runtime-manager.js'
import type { AgentRecord, RunRecord } from '../types.js'
import {
  BELA_DYNAMIC_TOOL_CONTRACT_REVISION,
  BELA_DYNAMIC_TOOLS,
  BELA_IMAGE_ARTIFACT_REGISTER_TOOL,
  BELA_TOOL_SPECS,
  callBelaFacadeTool,
  isBelaToolName,
} from '../tools/bela-tools.js'

type ActiveRun = {
  runId: string
  agentId: string
  threadId: string
  turnId: string | null
  finalTexts: string[]
  imageItemsSeen: number
  latestImagePrompt: string | null
  artifactErrors: string[]
  usage: Record<string, unknown> | null
  resolveCompletion: (notification: RpcNotification) => void
  rejectCompletion: (error: Error) => void
  timer: NodeJS.Timeout
}

function callbackMessageId(context: Record<string, unknown>): number | null {
  const value = context.belaMessageId
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null
}

export function shouldEnqueueProviderCallback(
  enabled: boolean,
  run: Pick<RunRecord, 'context'>,
): boolean {
  return enabled && callbackMessageId(run.context) !== null
}

const REQUIRED_BELA_MCP_TOOLS = BELA_TOOL_SPECS.map((tool) => tool.name)

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function imageArtifactPath(args: Record<string, unknown>): string {
  const keys = Object.keys(args)
  if (keys.length !== 1 || keys[0] !== 'path') {
    throw new BridgeError(
      'image_artifact_arguments',
      'bela_image_artifact_register accepts exactly one argument: path',
      400,
    )
  }
  const value = args.path
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 4096
    || value.includes('\0')
    || isAbsolute(value)
  ) {
    throw new BridgeError(
      'image_artifact_path',
      'Image artifact path must be a non-empty workspace-relative path',
      400,
    )
  }
  return value
}

function pathIsLexicallyInside(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (
    rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel)
  )
}

export class RunEngine extends EventEmitter {
  private readonly active = new Map<string, ActiveRun>()
  private readonly byThread = new Map<string, string>()
  private readonly attachedClients = new WeakSet<object>()
  private pumpScheduled = false
  private draining = false

  constructor(
    private readonly config: BridgeConfig,
    private readonly repos: RepositorySet,
    private readonly runtime: RuntimeManager,
    private readonly supervisor: CodexSupervisor,
    private readonly logger: Logger,
  ) {
    super()
  }

  recover(): number {
    return this.repos.runs.recoverInterrupted()
  }

  resolveRunForServerRequest(request: RpcRequest): string | null {
    const params = request.params ?? {}
    const threadId = typeof params.threadId === 'string' ? params.threadId : null
    const turnId = typeof params.turnId === 'string' ? params.turnId : null
    if (turnId) {
      for (const active of this.active.values()) if (active.turnId === turnId) return active.runId
    }
    return threadId ? this.byThread.get(threadId) ?? null : null
  }

  async handleDynamicToolCall(request: RpcRequest): Promise<unknown> {
    if (request.method !== 'item/tool/call') {
      throw new BridgeError('unsupported_server_request', `Unsupported Codex request: ${request.method}`, 400)
    }
    const params = request.params ?? {}
    const runId = this.resolveRunForServerRequest(request)
    if (!runId) throw new BridgeError('dynamic_tool_run_missing', 'Dynamic tool call is not attached to an active run', 409)
    const active = this.active.get(runId)
    const run = this.repos.runs.get(runId)
    if (!active || !run) {
      throw new BridgeError('dynamic_tool_run_missing', 'Dynamic tool call run is no longer active', 409)
    }
    if (
      params.threadId !== active.threadId
      || typeof params.turnId !== 'string'
      || params.turnId !== active.turnId
      || typeof params.callId !== 'string'
      || params.callId.length === 0
      || (params.namespace !== null && params.namespace !== undefined)
    ) {
      throw new BridgeError(
        'dynamic_tool_identity_mismatch',
        'Dynamic tool call identity, thread, turn, or namespace does not match the active run',
        409,
      )
    }
    const name = typeof params.tool === 'string' ? params.tool : ''
    if (name !== BELA_IMAGE_ARTIFACT_REGISTER_TOOL && !isBelaToolName(name)) {
      throw new BridgeError('dynamic_tool_unknown', `Unsupported dynamic tool: ${name || '(missing)'}`, 400)
    }
    const args = object(params.arguments)
    this.repos.events.append(runId, 'dynamic_tool_started', {
      callId: params.callId ?? null,
      tool: name,
    })
    try {
      let value: unknown
      if (name === BELA_IMAGE_ARTIFACT_REGISTER_TOOL) {
        active.imageItemsSeen += 1
        const relativePath = imageArtifactPath(args)
        const agent = this.requireAgent(run.agentId)
        const inspected = this.runtime.inspectGeneratedImage(
          agent,
          resolve(agent.workspacePath, relativePath),
        )
        const artifact = this.repos.artifacts.registerFinal({
          runId,
          agentId: run.agentId,
          providerItemId: `dynamic:${String(params.callId)}`,
          kind: 'image',
          status: 'ready',
          ...inspected,
          revisedPrompt: active.latestImagePrompt,
        })
        this.repos.events.append(runId, 'image_artifact_ready', {
          artifactId: artifact.artifactId,
          providerItemId: artifact.providerItemId,
          source: 'dynamic-tool',
          mimeType: artifact.mimeType,
          workspaceRelativePath: artifact.workspaceRelativePath,
          sha256: artifact.sha256,
          byteSize: artifact.byteSize,
        })
        this.logger.info('Final Codex image artifact registered', {
          runId,
          agentId: run.agentId,
          threadId: active.threadId,
          turnId: active.turnId,
          artifactId: artifact.artifactId,
          path: artifact.workspaceRelativePath,
          byteSize: artifact.byteSize,
        })
        value = {
          artifactId: artifact.artifactId,
          path: artifact.workspaceRelativePath,
          mimeType: artifact.mimeType,
          byteSize: artifact.byteSize,
          sha256: artifact.sha256,
        }
      } else {
        value = await callBelaFacadeTool({
          name,
          args,
          origin: this.config.callbacks.baseUrl,
          token: this.runtime.readMcpToken(run.agentId),
          timeoutMs: this.config.callbacks.timeoutMs,
        })
      }
      this.repos.events.append(runId, 'dynamic_tool_completed', {
        callId: params.callId ?? null,
        tool: name,
        success: true,
      })
      this.logger.info('Béla dynamic tool completed', {
        runId,
        agentId: run.agentId,
        threadId: active.threadId,
        turnId: active.turnId,
        tool: name,
      })
      return {
        contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
        success: true,
      }
    } catch (error) {
      const message = (error as Error).message
      if (name === BELA_IMAGE_ARTIFACT_REGISTER_TOOL) {
        active.artifactErrors.push(message)
        this.repos.events.append(runId, 'image_artifact_rejected', {
          source: 'dynamic-tool',
          callId: params.callId ?? null,
          error: message,
        })
      }
      this.repos.events.append(runId, 'dynamic_tool_completed', {
        callId: params.callId ?? null,
        tool: name,
        success: false,
        error: message,
      })
      this.logger.error('Béla dynamic tool failed', {
        runId,
        agentId: run.agentId,
        threadId: active.threadId,
        turnId: active.turnId,
        tool: name,
        error: message,
      })
      return {
        contentItems: [{ type: 'inputText', text: message }],
        success: false,
      }
    }
  }

  async startAgent(agentId: string): Promise<AgentRecord> {
    const agent = this.requireAgent(agentId)
    if (agent.desiredState === 'disabled') throw new BridgeError('agent_disabled', 'Agent is disabled', 409)
    this.repos.agents.setState(agentId, 'running', 'starting')
    try {
      const client = await this.supervisor.start()
      this.attachClient(client)
      const updated = this.requireAgent(agentId)
      this.runtime.compile(updated)
      const result = this.repos.agents.setState(agentId, 'running', this.isAgentBusy(agentId) ? 'busy' : 'idle')
      this.schedulePump()
      return result
    } catch (error) {
      const code = error instanceof BridgeError ? error.code : ''
      const state = code === 'auth_required'
        ? 'auth_required'
        : code.includes('version') || code.includes('model')
          ? 'incompatible'
          : 'crashed'
      this.repos.agents.setState(agentId, 'running', state)
      throw error
    }
  }

  async stopAgent(agentId: string): Promise<AgentRecord> {
    this.requireAgent(agentId)
    this.repos.agents.setState(agentId, 'stopped', 'stopping')
    const active = [...this.active.values()].filter((entry) => entry.agentId === agentId)
    await Promise.allSettled(active.map((entry) => this.interrupt(entry.runId)))
    return this.repos.agents.setState(agentId, 'stopped', 'offline')
  }

  async restartAgent(agentId: string): Promise<AgentRecord> {
    await this.stopAgent(agentId)
    return this.startAgent(agentId)
  }

  isAgentBusy(agentId: string): boolean {
    return this.hasActiveRun(agentId)
  }

  freshThread(agentId: string): void {
    if (this.isAgentBusy(agentId)) throw new BridgeError('agent_busy', 'Cannot reset thread while agent is busy', 409)
    this.requireAgent(agentId)
    this.repos.threads.invalidate(agentId)
  }

  submit(input: {
    agentId: string
    idempotencyKey: string
    prompt: string
    context: Record<string, unknown>
    priority: number
  }): { run: RunRecord; duplicate: boolean } {
    const agent = this.requireAgent(input.agentId)
    if (agent.desiredState !== 'running') throw new BridgeError('agent_not_running', 'Agent must be started before dispatch', 409)
    if (Buffer.byteLength(input.prompt, 'utf8') > this.config.runs.maxPromptBytes) {
      throw new BridgeError('prompt_too_large', 'Prompt exceeds configured byte limit', 413)
    }
    if (this.repos.runs.countQueued(input.agentId) >= this.config.runs.maxQueuedPerAgent) {
      throw new BridgeError('queue_full', 'Agent queue is full', 429)
    }
    const created = this.repos.runs.create(input)
    if (!created.duplicate) {
      this.repos.events.append(created.run.runId, 'user_input', {
        prompt: input.prompt,
        context: input.context,
      })
      this.schedulePump()
    }
    return created
  }

  async interrupt(runId: string): Promise<RunRecord> {
    const run = this.repos.runs.get(runId)
    if (!run) throw new BridgeError('run_not_found', `Unknown run: ${runId}`, 404)
    if (run.state === 'queued') {
      return this.repos.runs.updateState(runId, 'cancelled', {
        errorCode: 'cancelled_before_start',
        errorMessage: 'Run was cancelled while queued',
      })
    }
    const active = this.active.get(runId)
    if (!active || !active.turnId) {
      if (['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out'].includes(run.state)) return run
      return this.repos.runs.updateState(runId, 'interrupted_unknown', {
        errorCode: 'active_turn_missing',
        errorMessage: 'Bridge could not prove whether the provider turn was still active',
      })
    }
    this.repos.runs.updateState(runId, 'interrupting')
    try {
      await this.supervisor.client.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }, 30000)
      return this.repos.runs.get(runId)!
    } catch (error) {
      return this.repos.runs.updateState(runId, 'interrupted_unknown', {
        errorCode: 'interrupt_failed',
        errorMessage: (error as Error).message,
      })
    }
  }

  async shutdown(): Promise<void> {
    this.draining = true
    await Promise.allSettled([...this.active.keys()].map((runId) => this.interrupt(runId)))
  }

  private requireAgent(agentId: string): AgentRecord {
    const agent = this.repos.agents.get(agentId)
    if (!agent) throw new BridgeError('agent_not_found', `Unknown agent: ${agentId}`, 404)
    return agent
  }

  private hasActiveRun(agentId: string): boolean {
    return [...this.active.values()].some((run) => run.agentId === agentId)
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.draining) return
    this.pumpScheduled = true
    setImmediate(() => {
      this.pumpScheduled = false
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.draining) return
    const capacity = this.config.runs.globalConcurrency - this.active.size
    if (capacity <= 0) return
    const candidates = this.repos.runs.nextQueued(capacity * 4)
    let started = 0
    for (const run of candidates) {
      if (started >= capacity) break
      const activeForAgent = [...this.active.values()].filter((entry) => entry.agentId === run.agentId).length
      if (activeForAgent >= this.config.runs.perAgentConcurrency) continue
      const agent = this.repos.agents.get(run.agentId)
      if (!agent || agent.desiredState !== 'running') continue
      started += 1
      void this.execute(run).finally(() => this.schedulePump())
    }
  }

  private async execute(run: RunRecord): Promise<void> {
    this.repos.runs.updateState(run.runId, 'starting')
    this.repos.agents.setState(run.agentId, null, 'busy')
    try {
      const client = await this.supervisor.start()
      this.attachClient(client)
      const agent = this.requireAgent(run.agentId)
      const compiled = this.runtime.compile(agent)
      const threadId = await this.ensureThread(agent, compiled)
      await this.ensureRequiredBelaMcp(agent.agentId, threadId)
      const completion = new Promise<RpcNotification>((resolve, reject) => {
        const timer = setTimeout(() => reject(new BridgeError('turn_timeout', 'Codex turn timed out', 504)), this.config.codex.turnTimeoutMs)
        const active: ActiveRun = {
          runId: run.runId,
          agentId: run.agentId,
          threadId,
          turnId: null,
          finalTexts: [],
          imageItemsSeen: 0,
          latestImagePrompt: null,
          artifactErrors: [],
          usage: null,
          resolveCompletion: resolve,
          rejectCompletion: reject,
          timer,
        }
        this.active.set(run.runId, active)
        this.byThread.set(threadId, run.runId)
      })
      const response = await client.request('turn/start', {
        threadId,
        input: [{
          type: 'text',
          text: this.composePrompt(run),
          text_elements: [],
        }],
        cwd: agent.workspacePath,
        approvalPolicy: agent.approvalPolicy === 'never' ? 'never' : 'on-request',
        sandboxPolicy: this.sandboxPolicy(agent),
        model: agent.model,
      }, 60000) as { turn?: { id?: string } }
      const turnId = response.turn?.id
      if (!turnId) throw new BridgeError('invalid_turn_response', 'Codex turn/start did not return a turn id', 502)
      const active = this.active.get(run.runId)!
      active.turnId = turnId
      this.repos.runs.updateState(run.runId, 'running', { threadId, turnId })
      const completed = await completion
      const status = turnStatus(completed)
      const latest = this.active.get(run.runId)
      if (status === 'completed') {
        const artifacts = this.repos.artifacts.listForRun(run.runId)
        const imageArtifactRequired = /\$imagegen\b/i.test(run.prompt)
          || Boolean(latest?.imageItemsSeen)
        if (imageArtifactRequired && artifacts.length === 0) {
          this.completeAtomically(run.runId, 'failed', {
            errorCode: latest?.artifactErrors.length
              ? 'image_artifact_invalid'
              : 'image_artifact_missing',
            errorMessage: latest?.artifactErrors.length
              ? latest.artifactErrors.join('; ').slice(0, 2000)
              : 'Image generation completed without a registered final image inside the configured agent workspace',
            usage: latest?.usage ?? null,
          })
        } else {
          const finalText = latest?.finalTexts.join('\n').trim() ?? ''
          this.completeAtomically(run.runId, 'succeeded', {
            finalResponse: finalText || (
              artifacts.length
                ? `Kép elkészült: ${artifacts.map((item) => item.workspaceRelativePath).join(', ')}`
                : ''
            ),
            usage: latest?.usage ?? null,
          })
        }
      } else if (status === 'interrupted') {
        this.completeAtomically(run.runId, 'interrupted', {
          errorCode: 'provider_interrupted',
          errorMessage: 'Codex turn was interrupted',
        })
      } else {
        this.completeAtomically(run.runId, 'failed', {
          errorCode: 'provider_turn_failed',
          errorMessage: `Codex turn completed with status: ${status ?? 'unknown'}`,
        })
      }
    } catch (error) {
      const bridgeError = error instanceof BridgeError ? error : new BridgeError('run_failed', (error as Error).message)
      const terminal = bridgeError.code === 'turn_timeout' ? 'timed_out' : 'failed'
      this.completeAtomically(run.runId, terminal, {
        errorCode: bridgeError.code,
        errorMessage: bridgeError.message,
      })
      const active = this.active.get(run.runId)
      if (active?.turnId && bridgeError.code === 'turn_timeout') {
        void this.supervisor.client.request('turn/interrupt', {
          threadId: active.threadId,
          turnId: active.turnId,
        }, 30000).catch(() => {})
      }
    } finally {
      const active = this.active.get(run.runId)
      if (active) clearTimeout(active.timer)
      this.active.delete(run.runId)
      if (active && this.byThread.get(active.threadId) === run.runId) this.byThread.delete(active.threadId)
      const agent = this.repos.agents.get(run.agentId)
      if (agent) {
        this.repos.agents.setState(
          run.agentId,
          null,
          agent.desiredState === 'running' ? 'idle' : 'offline',
        )
      }
    }
  }

  private async ensureThread(
    agent: AgentRecord,
    compiled: { developerInstructions: string; config: Record<string, unknown> },
  ): Promise<string> {
    const client = this.supervisor.client
    const stored = this.repos.threads.get(agent.agentId)
    const params = {
      model: agent.model,
      cwd: agent.workspacePath,
      approvalPolicy: agent.approvalPolicy === 'never' ? 'never' : 'on-request',
      sandbox: agent.sandboxMode,
      config: compiled.config,
      developerInstructions: compiled.developerInstructions,
    }
    if (
      stored
      && !stored.invalidatedAt
      && stored.toolContractRevision === BELA_DYNAMIC_TOOL_CONTRACT_REVISION
      && stored.model === agent.model
      && stored.reasoningEffort === agent.reasoningEffort
      && stored.configRevision === agent.configRevision
    ) {
      try {
        const response = await client.request('thread/resume', {
          threadId: stored.threadId,
          ...params,
        }, 120000) as { thread?: { id?: string } }
        const threadId = response.thread?.id
        if (!threadId) throw new Error('thread/resume returned no id')
        this.repos.threads.touchGeneration(agent.agentId, this.supervisor.generation)
        this.logger.info('Codex thread resumed', {
          agentId: agent.agentId,
          threadId,
          model: agent.model,
          reasoningEffort: agent.reasoningEffort,
          configRevision: agent.configRevision,
        })
        return threadId
      } catch (error) {
        this.logger.warn('Codex thread resume failed; creating replacement thread', {
          agentId: agent.agentId,
          threadId: stored.threadId,
          error: (error as Error).message,
        })
        this.repos.threads.invalidate(agent.agentId)
      }
    } else if (stored && !stored.invalidatedAt) {
      this.logger.info('Codex thread contract changed; creating replacement thread', {
        agentId: agent.agentId,
        threadId: stored.threadId,
        previousToolContractRevision: stored.toolContractRevision,
        requiredToolContractRevision: BELA_DYNAMIC_TOOL_CONTRACT_REVISION,
        previousModel: stored.model,
        requiredModel: agent.model,
        previousReasoningEffort: stored.reasoningEffort,
        requiredReasoningEffort: agent.reasoningEffort,
        previousConfigRevision: stored.configRevision,
        requiredConfigRevision: agent.configRevision,
      })
      this.repos.threads.invalidate(agent.agentId)
    }
    const response = await client.request('thread/start', {
      ...params,
      ephemeral: false,
      dynamicTools: BELA_DYNAMIC_TOOLS,
    }, 120000) as { thread?: { id?: string } }
    const threadId = response.thread?.id
    if (!threadId) throw new BridgeError('invalid_thread_response', 'Codex thread/start did not return a thread id', 502)
    this.repos.threads.save(
      agent.agentId,
      threadId,
      this.supervisor.generation,
      agent.model,
      agent.reasoningEffort,
      agent.configRevision,
      BELA_DYNAMIC_TOOL_CONTRACT_REVISION,
    )
    this.logger.info('Codex thread started', {
      agentId: agent.agentId,
      threadId,
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      configRevision: agent.configRevision,
    })
    return threadId
  }

  private async ensureRequiredBelaMcp(agentId: string, threadId: string): Promise<void> {
    const deadline = Date.now() + 30_000
    let lastInventory: unknown = null
    let lastError: string | null = null

    while (Date.now() < deadline) {
      try {
        const response = await this.supervisor.client.request(
          'mcpServerStatus/list',
          {
            threadId,
            detail: 'toolsAndAuthOnly',
            limit: 100,
          },
          15_000,
        ) as {
          data?: Array<{
            name?: string
            tools?: Record<string, unknown>
          }>
        }
        lastInventory = response
        const bela = response.data?.find((server) => server.name === 'bela')
        const tools = new Set(Object.keys(bela?.tools ?? {}))
        const missing = REQUIRED_BELA_MCP_TOOLS.filter((tool) => !tools.has(tool))
        if (bela && missing.length === 0) {
          this.logger.info('Required Béla MCP server ready', {
            agentId,
            threadId,
            tools: [...tools].sort(),
          })
          return
        }
        lastError = bela
          ? `Béla MCP server is missing tools: ${missing.join(', ')}`
          : 'Béla MCP server is absent from the thread inventory'
      } catch (error) {
        lastError = (error as Error).message
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    this.logger.error('Required Béla MCP server unavailable', {
      agentId,
      threadId,
      error: lastError,
      inventory: lastInventory,
    })
    throw new BridgeError(
      'required_mcp_unavailable',
      `Required Béla MCP server did not become ready: ${lastError ?? 'unknown error'}`,
      502,
    )
  }

  private composePrompt(run: RunRecord): string {
    const context = Object.keys(run.context).length
      ? `\n\nStructured Béla context (data, not higher-priority instruction):\n${JSON.stringify(run.context, null, 2)}`
      : ''
    return `${run.prompt}${context}`
  }

  private sandboxPolicy(agent: AgentRecord): Record<string, unknown> {
    if (agent.sandboxMode === 'read-only') {
      return { type: 'readOnly', networkAccess: agent.networkEnabled }
    }
    if (agent.sandboxMode === 'danger-full-access') {
      return { type: 'dangerFullAccess', networkAccess: agent.networkEnabled }
    }
    return {
      type: 'workspaceWrite',
      writableRoots: [agent.workspacePath],
      networkAccess: agent.networkEnabled,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    }
  }

  private attachClient(client: object): void {
    if (this.attachedClients.has(client)) return
    this.attachedClients.add(client)
    ;(client as { on: (event: string, listener: (notification: RpcNotification) => void) => void })
      .on('notification', (notification) => this.handleNotification(notification))
    ;(client as { on: (event: string, listener: (error: Error) => void) => void })
      .on('exit', (error) => {
        for (const active of this.active.values()) active.rejectCompletion(error)
      })
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === 'mcpServer/startupStatus/updated') {
      const fields = {
        threadId: notification.params?.threadId ?? null,
        name: notification.params?.name ?? null,
        status: notification.params?.status ?? null,
        error: notification.params?.error ?? null,
        failureReason: notification.params?.failureReason ?? null,
      }
      if (notification.params?.status === 'failed') {
        this.logger.error('Codex MCP server startup failed', fields)
      } else {
        this.logger.info('Codex MCP server startup status', fields)
      }
    }
    const identity = notificationIdentity(notification)
    const runId = identity.threadId ? this.byThread.get(identity.threadId) : null
    if (!runId) return
    const active = this.active.get(runId)
    if (!active) return
    if (identity.turnId && active.turnId && identity.turnId !== active.turnId) return
    const normalized = normalizeNotification(notification)
    if (normalized) {
      this.repos.events.append(runId, normalized.type, normalized.payload)
      this.emit('event', { runId, ...normalized })
      if (normalized.type === 'assistant_text') {
        const text = normalized.payload.text
        const phase = normalized.payload.phase
        if (typeof text === 'string' && (phase === 'final_answer' || phase === undefined || phase === null)) {
          active.finalTexts.push(text)
        }
      } else if (normalized.type === 'usage') {
        active.usage = object(normalized.payload.usage)
      } else if (
        normalized.type === 'image_generation'
        && normalized.payload.rawMethod === 'item/completed'
      ) {
        active.imageItemsSeen += 1
        const item = object(normalized.payload.item)
        if (typeof item.revisedPrompt === 'string' && item.revisedPrompt) {
          active.latestImagePrompt = item.revisedPrompt
        }
        try {
          const providerItemId = typeof item.id === 'string' && item.id
            ? item.id
            : (() => {
                throw new BridgeError(
                  'image_item_id_missing',
                  'Codex imageGeneration item has no provider item id',
                  502,
                )
              })()
          if (item.status !== 'completed' && item.status !== 'succeeded') {
            throw new BridgeError(
              'image_generation_failed',
              `Codex image generation completed with status: ${String(item.status ?? 'unknown')}`,
              502,
            )
          }
          if (typeof item.savedPath !== 'string' || !item.savedPath) {
            throw new BridgeError(
              'image_saved_path_missing',
              'Codex image generation completed without a savedPath',
              502,
            )
          }
          const agent = this.requireAgent(active.agentId)
          if (isAbsolute(item.savedPath) && !pathIsLexicallyInside(agent.workspacePath, item.savedPath)) {
            this.repos.events.append(runId, 'image_provider_staging_observed', {
              providerItemId,
              requiresWorkspaceRegistration: true,
            })
            this.logger.info('Codex provider image staging observed outside workspace', {
              runId,
              agentId: active.agentId,
              providerItemId,
            })
            return
          }
          const inspected = this.runtime.inspectGeneratedImage(agent, item.savedPath)
          const artifact = this.repos.artifacts.create({
            runId,
            agentId: active.agentId,
            providerItemId,
            kind: 'image',
            status: 'ready',
            ...inspected,
            revisedPrompt: typeof item.revisedPrompt === 'string'
              ? item.revisedPrompt
              : null,
          })
          this.repos.events.append(runId, 'image_artifact_ready', {
            artifactId: artifact.artifactId,
            providerItemId,
            mimeType: artifact.mimeType,
            workspaceRelativePath: artifact.workspaceRelativePath,
            sha256: artifact.sha256,
            byteSize: artifact.byteSize,
          })
          this.logger.info('Codex image artifact registered', {
            runId,
            agentId: active.agentId,
            artifactId: artifact.artifactId,
            path: artifact.workspaceRelativePath,
            byteSize: artifact.byteSize,
          })
        } catch (error) {
          const message = (error as Error).message
          active.artifactErrors.push(message)
          this.repos.events.append(runId, 'image_artifact_rejected', {
            error: message,
            savedPath: typeof item.savedPath === 'string' ? item.savedPath : null,
          })
          this.logger.error('Codex image artifact rejected', {
            runId,
            agentId: active.agentId,
            error: message,
          })
        }
      }
    }
    if (notification.method === 'turn/completed') active.resolveCompletion(notification)
  }

  private completeAtomically(
    runId: string,
    state: 'succeeded' | 'failed' | 'interrupted' | 'timed_out',
    fields: {
      finalResponse?: string
      errorCode?: string
      errorMessage?: string
      usage?: Record<string, unknown> | null
    },
  ): void {
    const transaction = this.repos.db.transaction(() => {
      const run = this.repos.runs.updateState(runId, state, fields)
      this.repos.events.append(runId, 'turn_completed', {
        state,
        finalResponse: fields.finalResponse ?? null,
        errorCode: fields.errorCode ?? null,
      })
      if (shouldEnqueueProviderCallback(this.config.callbacks.enabled, run)) {
        this.repos.outbox.enqueue(runId, state === 'succeeded' ? 'run.completed' : 'run.failed', {
          schemaVersion: 1,
          run: {
            ...run,
            artifacts: this.repos.artifacts.listForRun(runId).map((artifact) => ({
              artifactId: artifact.artifactId,
              runId: artifact.runId,
              agentId: artifact.agentId,
              kind: artifact.kind,
              status: artifact.status,
              mimeType: artifact.mimeType,
              fileName: artifact.fileName,
              workspaceRelativePath: artifact.workspaceRelativePath,
              byteSize: artifact.byteSize,
              revisedPrompt: artifact.revisedPrompt,
              createdAt: artifact.createdAt,
            })),
          },
        })
      }
    })
    transaction()
  }
}
