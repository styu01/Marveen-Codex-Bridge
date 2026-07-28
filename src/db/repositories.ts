import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { BridgeError } from '../errors.js'
import type {
  AgentRecord,
  ImageArtifactRecord,
  RunRecord,
  RunState,
} from '../types.js'

function now(): string {
  return new Date().toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

type AgentRow = {
  agent_id: string
  display_name: string
  desired_state: AgentRecord['desiredState']
  actual_state: AgentRecord['actualState']
  model: string
  reasoning_effort: AgentRecord['reasoningEffort']
  workspace_path: string
  workspace_mode: AgentRecord['workspaceMode']
  sandbox_mode: AgentRecord['sandboxMode']
  approval_policy: AgentRecord['approvalPolicy']
  network_enabled: number
  instructions: string
  config_revision: number
  created_at: string
  updated_at: string
}

function mapAgent(row: AgentRow): AgentRecord {
  return {
    agentId: row.agent_id,
    displayName: row.display_name,
    desiredState: row.desired_state,
    actualState: row.actual_state,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    workspacePath: row.workspace_path,
    workspaceMode: row.workspace_mode,
    sandboxMode: row.sandbox_mode,
    approvalPolicy: row.approval_policy,
    networkEnabled: row.network_enabled === 1,
    instructions: row.instructions,
    configRevision: row.config_revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type RunRow = {
  run_id: string
  agent_id: string
  idempotency_key: string
  payload_hash: string
  state: RunState
  priority: number
  prompt: string
  context_json: string
  thread_id: string | null
  turn_id: string | null
  final_response: string | null
  error_code: string | null
  error_message: string | null
  usage_json: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
  updated_at: string
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    agentId: row.agent_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    state: row.state,
    priority: row.priority,
    prompt: row.prompt,
    context: parseObject(row.context_json) ?? {},
    threadId: row.thread_id,
    turnId: row.turn_id,
    finalResponse: row.final_response,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    usage: parseObject(row.usage_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  }
}

export class AgentRepository {
  constructor(private readonly db: Database.Database) {}

  get(agentId: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM bridge_agents WHERE agent_id = ?').get(agentId) as AgentRow | undefined
    return row ? mapAgent(row) : null
  }

  list(): AgentRecord[] {
    return (this.db.prepare('SELECT * FROM bridge_agents ORDER BY agent_id').all() as AgentRow[]).map(mapAgent)
  }

  remove(agentId: string): boolean {
    return this.db.prepare('DELETE FROM bridge_agents WHERE agent_id = ?').run(agentId).changes > 0
  }

  upsert(input: {
    agentId: string
    displayName: string
    model: string
    reasoningEffort: AgentRecord['reasoningEffort']
    workspacePath: string
    workspaceMode: AgentRecord['workspaceMode']
    sandboxMode: AgentRecord['sandboxMode']
    approvalPolicy: AgentRecord['approvalPolicy']
    networkEnabled: boolean
    instructions: string
  }): AgentRecord {
    const previous = this.get(input.agentId)
    const stamp = now()
    if (!previous) {
      this.db.prepare(`
        INSERT INTO bridge_agents(
          agent_id, display_name, model, reasoning_effort, workspace_path, workspace_mode,
          sandbox_mode, approval_policy, network_enabled, instructions,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.agentId,
        input.displayName,
        input.model,
        input.reasoningEffort,
        input.workspacePath,
        input.workspaceMode,
        input.sandboxMode,
        input.approvalPolicy,
        input.networkEnabled ? 1 : 0,
        input.instructions,
        stamp,
        stamp,
      )
    } else {
      const changed = [
        input.model !== previous.model,
        input.reasoningEffort !== previous.reasoningEffort,
        input.workspacePath !== previous.workspacePath,
        input.workspaceMode !== previous.workspaceMode,
        input.sandboxMode !== previous.sandboxMode,
        input.approvalPolicy !== previous.approvalPolicy,
        input.networkEnabled !== previous.networkEnabled,
        input.instructions !== previous.instructions,
      ].some(Boolean)
      this.db.prepare(`
        UPDATE bridge_agents SET
          display_name = ?, model = ?, reasoning_effort = ?, workspace_path = ?, workspace_mode = ?,
          sandbox_mode = ?, approval_policy = ?, network_enabled = ?,
          instructions = ?, config_revision = config_revision + ?, updated_at = ?
        WHERE agent_id = ?
      `).run(
        input.displayName,
        input.model,
        input.reasoningEffort,
        input.workspacePath,
        input.workspaceMode,
        input.sandboxMode,
        input.approvalPolicy,
        input.networkEnabled ? 1 : 0,
        input.instructions,
        changed ? 1 : 0,
        stamp,
        input.agentId,
      )
    }
    return this.get(input.agentId)!
  }

  setState(
    agentId: string,
    desiredState: AgentRecord['desiredState'] | null,
    actualState: AgentRecord['actualState'] | null,
  ): AgentRecord {
    const agent = this.get(agentId)
    if (!agent) throw new BridgeError('agent_not_found', `Unknown agent: ${agentId}`, 404)
    this.db.prepare(`
      UPDATE bridge_agents
      SET desired_state = COALESCE(?, desired_state),
          actual_state = COALESCE(?, actual_state),
          updated_at = ?
      WHERE agent_id = ?
    `).run(desiredState, actualState, now(), agentId)
    return this.get(agentId)!
  }
}

export class ThreadRepository {
  constructor(private readonly db: Database.Database) {}

  get(agentId: string): {
    agentId: string
    threadId: string
    appServerGeneration: number
    model: string
    reasoningEffort: AgentRecord['reasoningEffort']
    configRevision: number
    toolContractRevision: number
    invalidatedAt: string | null
  } | null {
    const row = this.db.prepare('SELECT * FROM codex_threads WHERE agent_id = ?').get(agentId) as {
      agent_id: string
      thread_id: string
      app_server_generation: number
      model: string
      reasoning_effort: AgentRecord['reasoningEffort']
      config_revision: number
      tool_contract_revision: number
      invalidated_at: string | null
    } | undefined
    return row ? {
      agentId: row.agent_id,
      threadId: row.thread_id,
      appServerGeneration: row.app_server_generation,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      configRevision: row.config_revision,
      toolContractRevision: row.tool_contract_revision,
      invalidatedAt: row.invalidated_at,
    } : null
  }

  save(
    agentId: string,
    threadId: string,
    generation: number,
    model: string,
    reasoningEffort: AgentRecord['reasoningEffort'],
    configRevision: number,
    toolContractRevision: number,
  ): void {
    const stamp = now()
    this.db.prepare(`
      INSERT INTO codex_threads(
        agent_id, thread_id, app_server_generation, model, reasoning_effort, config_revision,
        tool_contract_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        app_server_generation = excluded.app_server_generation,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        config_revision = excluded.config_revision,
        tool_contract_revision = excluded.tool_contract_revision,
        resumed_at = excluded.created_at,
        invalidated_at = NULL
    `).run(
      agentId,
      threadId,
      generation,
      model,
      reasoningEffort,
      configRevision,
      toolContractRevision,
      stamp,
    )
  }

  touchGeneration(agentId: string, generation: number): void {
    this.db.prepare(`
      UPDATE codex_threads SET app_server_generation = ?, resumed_at = ?
      WHERE agent_id = ?
    `).run(generation, now(), agentId)
  }

  invalidate(agentId: string): void {
    this.db.prepare('UPDATE codex_threads SET invalidated_at = ? WHERE agent_id = ?').run(now(), agentId)
  }
}

export class RunRepository {
  constructor(private readonly db: Database.Database) {}

  get(runId: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM bridge_runs WHERE run_id = ?').get(runId) as RunRow | undefined
    return row ? mapRun(row) : null
  }

  create(input: {
    agentId: string
    idempotencyKey: string
    prompt: string
    context: Record<string, unknown>
    priority: number
  }): { run: RunRecord; duplicate: boolean } {
    const bodyHash = payloadHash({
      prompt: input.prompt,
      context: input.context,
      priority: input.priority,
    })
    const existing = this.db.prepare(`
      SELECT * FROM bridge_runs WHERE agent_id = ? AND idempotency_key = ?
    `).get(input.agentId, input.idempotencyKey) as RunRow | undefined
    if (existing) {
      if (existing.payload_hash !== bodyHash) {
        throw new BridgeError(
          'idempotency_conflict',
          'The idempotency key was already used with a different payload',
          409,
          { runId: existing.run_id },
        )
      }
      return { run: mapRun(existing), duplicate: true }
    }
    const runId = randomUUID()
    const stamp = now()
    this.db.prepare(`
      INSERT INTO bridge_runs(
        run_id, agent_id, idempotency_key, payload_hash, state, priority,
        prompt, context_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(
      runId,
      input.agentId,
      input.idempotencyKey,
      bodyHash,
      input.priority,
      input.prompt,
      JSON.stringify(input.context),
      stamp,
      stamp,
    )
    return { run: this.get(runId)!, duplicate: false }
  }

  countQueued(agentId: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) AS count FROM bridge_runs WHERE agent_id = ? AND state = 'queued'
    `).get(agentId) as { count: number }).count
  }

  nextQueued(limit: number): RunRecord[] {
    return (this.db.prepare(`
      SELECT * FROM bridge_runs
      WHERE state = 'queued'
      ORDER BY (priority + MIN(100, CAST((julianday('now') - julianday(created_at)) * 1440 AS INTEGER))) DESC,
               created_at ASC
      LIMIT ?
    `).all(limit) as RunRow[]).map(mapRun)
  }

  updateState(
    runId: string,
    state: RunState,
    fields: {
      threadId?: string | null
      turnId?: string | null
      finalResponse?: string | null
      errorCode?: string | null
      errorMessage?: string | null
      usage?: Record<string, unknown> | null
    } = {},
  ): RunRecord {
    const current = this.get(runId)
    if (!current) throw new BridgeError('run_not_found', `Unknown run: ${runId}`, 404)
    const stamp = now()
    const startedAt = state === 'starting' && !current.startedAt ? stamp : current.startedAt
    const terminal = ['succeeded', 'failed', 'cancelled', 'interrupted', 'interrupted_unknown', 'timed_out'].includes(state)
    this.db.prepare(`
      UPDATE bridge_runs SET
        state = ?,
        thread_id = COALESCE(?, thread_id),
        turn_id = COALESCE(?, turn_id),
        final_response = COALESCE(?, final_response),
        error_code = COALESCE(?, error_code),
        error_message = COALESCE(?, error_message),
        usage_json = COALESCE(?, usage_json),
        started_at = ?,
        finished_at = ?,
        updated_at = ?
      WHERE run_id = ?
    `).run(
      state,
      fields.threadId ?? null,
      fields.turnId ?? null,
      fields.finalResponse ?? null,
      fields.errorCode ?? null,
      fields.errorMessage ?? null,
      fields.usage === undefined ? null : JSON.stringify(fields.usage),
      startedAt,
      terminal ? stamp : current.finishedAt,
      stamp,
      runId,
    )
    return this.get(runId)!
  }

  recoverInterrupted(): number {
    const result = this.db.prepare(`
      UPDATE bridge_runs
      SET state = 'interrupted_unknown',
          error_code = 'bridge_restart',
          error_message = 'Bridge restarted while the run was active',
          finished_at = ?,
          updated_at = ?
      WHERE state IN ('starting', 'running', 'interrupting', 'waiting_approval')
    `).run(now(), now())
    return result.changes
  }
}

export class EventRepository {
  constructor(private readonly db: Database.Database) {}

  append(runId: string, type: string, payload: Record<string, unknown>): number {
    const sequence = (this.db.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM bridge_events WHERE run_id = ?
    `).get(runId) as { sequence: number }).sequence
    this.db.prepare(`
      INSERT INTO bridge_events(run_id, sequence, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(runId, sequence, type, JSON.stringify(payload), now())
    return sequence
  }

  list(runId: string, afterSequence = 0, limit = 1000): Array<{
    sequence: number
    type: string
    payload: Record<string, unknown>
    createdAt: string
  }> {
    const rows = this.db.prepare(`
      SELECT sequence, type, payload_json, created_at
      FROM bridge_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(runId, afterSequence, limit) as Array<{
      sequence: number
      type: string
      payload_json: string
      created_at: string
    }>
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      payload: parseObject(row.payload_json) ?? {},
      createdAt: row.created_at,
    }))
  }
}

type ArtifactRow = {
  artifact_id: string
  run_id: string
  agent_id: string
  provider_item_id: string
  kind: 'image'
  status: 'ready'
  mime_type: ImageArtifactRecord['mimeType']
  file_name: string
  absolute_path: string
  workspace_relative_path: string
  sha256: string
  byte_size: number
  revised_prompt: string | null
  created_at: string
}

function mapArtifact(row: ArtifactRow): ImageArtifactRecord {
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    agentId: row.agent_id,
    providerItemId: row.provider_item_id,
    kind: row.kind,
    status: row.status,
    mimeType: row.mime_type,
    fileName: row.file_name,
    absolutePath: row.absolute_path,
    workspaceRelativePath: row.workspace_relative_path,
    sha256: row.sha256,
    byteSize: row.byte_size,
    revisedPrompt: row.revised_prompt,
    createdAt: row.created_at,
  }
}

export class ArtifactRepository {
  constructor(private readonly db: Database.Database) {}

  get(artifactId: string): ImageArtifactRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM bridge_artifacts WHERE artifact_id = ?',
    ).get(artifactId) as ArtifactRow | undefined
    return row ? mapArtifact(row) : null
  }

  listForRun(runId: string): ImageArtifactRecord[] {
    return (this.db.prepare(`
      SELECT * FROM bridge_artifacts
      WHERE run_id = ?
      ORDER BY created_at ASC, artifact_id ASC
    `).all(runId) as ArtifactRow[]).map(mapArtifact)
  }

  create(input: Omit<ImageArtifactRecord, 'artifactId' | 'createdAt'>): ImageArtifactRecord {
    const existing = this.db.prepare(`
      SELECT * FROM bridge_artifacts
      WHERE run_id = ? AND provider_item_id = ?
    `).get(input.runId, input.providerItemId) as ArtifactRow | undefined
    if (existing) return mapArtifact(existing)

    const artifactId = randomUUID()
    const stamp = now()
    this.db.prepare(`
      INSERT INTO bridge_artifacts(
        artifact_id, run_id, agent_id, provider_item_id, kind, status,
        mime_type, file_name, absolute_path, workspace_relative_path,
        sha256, byte_size, revised_prompt, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      artifactId,
      input.runId,
      input.agentId,
      input.providerItemId,
      input.kind,
      input.status,
      input.mimeType,
      input.fileName,
      input.absolutePath,
      input.workspaceRelativePath,
      input.sha256,
      input.byteSize,
      input.revisedPrompt,
      stamp,
    )
    return this.get(artifactId)!
  }

  registerFinal(
    input: Omit<ImageArtifactRecord, 'artifactId' | 'createdAt'>,
  ): ImageArtifactRecord {
    const existing = this.db.prepare(`
      SELECT * FROM bridge_artifacts
      WHERE run_id = ? AND absolute_path = ?
      ORDER BY created_at ASC, artifact_id ASC
      LIMIT 1
    `).get(input.runId, input.absolutePath) as ArtifactRow | undefined
    if (!existing) return this.create(input)

    this.db.prepare(`
      UPDATE bridge_artifacts SET
        status = ?,
        mime_type = ?,
        file_name = ?,
        workspace_relative_path = ?,
        sha256 = ?,
        byte_size = ?,
        revised_prompt = COALESCE(?, revised_prompt)
      WHERE artifact_id = ?
    `).run(
      input.status,
      input.mimeType,
      input.fileName,
      input.workspaceRelativePath,
      input.sha256,
      input.byteSize,
      input.revisedPrompt,
      existing.artifact_id,
    )
    return this.get(existing.artifact_id)!
  }
}

export class OutboxRepository {
  constructor(private readonly db: Database.Database) {}

  enqueue(runId: string, eventType: string, payload: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO bridge_outbox(
        event_key, run_id, event_type, payload_json, available_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(`${runId}:${eventType}`, runId, eventType, JSON.stringify(payload), now(), now())
  }

  next(limit = 20): Array<{
    outboxId: number
    runId: string
    eventType: string
    payload: Record<string, unknown>
    attempts: number
  }> {
    const rows = this.db.prepare(`
      SELECT outbox_id, run_id, event_type, payload_json, attempts
      FROM bridge_outbox
      WHERE state = 'pending' AND available_at <= ?
      ORDER BY outbox_id ASC LIMIT ?
    `).all(now(), limit) as Array<{
      outbox_id: number
      run_id: string
      event_type: string
      payload_json: string
      attempts: number
    }>
    return rows.map((row) => ({
      outboxId: row.outbox_id,
      runId: row.run_id,
      eventType: row.event_type,
      payload: parseObject(row.payload_json) ?? {},
      attempts: row.attempts,
    }))
  }

  delivered(outboxId: number): void {
    this.db.prepare(`
      UPDATE bridge_outbox SET state = 'delivered', delivered_at = ? WHERE outbox_id = ?
    `).run(now(), outboxId)
  }

  retry(outboxId: number, attempts: number, availableAt: string, error: string, dead: boolean): void {
    this.db.prepare(`
      UPDATE bridge_outbox
      SET state = ?, attempts = ?, available_at = ?, last_error = ?
      WHERE outbox_id = ?
    `).run(dead ? 'dead' : 'pending', attempts, availableAt, error.slice(0, 2000), outboxId)
  }
}

export class RepositorySet {
  readonly agents: AgentRepository
  readonly threads: ThreadRepository
  readonly runs: RunRepository
  readonly events: EventRepository
  readonly artifacts: ArtifactRepository
  readonly outbox: OutboxRepository

  constructor(readonly db: Database.Database) {
    this.agents = new AgentRepository(db)
    this.threads = new ThreadRepository(db)
    this.runs = new RunRepository(db)
    this.events = new EventRepository(db)
    this.artifacts = new ArtifactRepository(db)
    this.outbox = new OutboxRepository(db)
  }
}
