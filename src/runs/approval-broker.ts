import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { BridgeError } from '../errors.js'
import type { RpcRequest } from '../codex/protocol-client.js'
import type { Logger } from '../logging.js'

type PendingDecision = {
  resolve: (result: unknown) => void
  timer: NodeJS.Timeout
  promise: Promise<unknown>
  providerKey: string
}

function now(): string { return new Date().toISOString() }

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingDecision>()

  constructor(
    private readonly db: Database.Database,
    private readonly logger: Logger,
    private readonly resolveRunId: (request: RpcRequest) => string | null,
    private readonly resolveAppServerGeneration: () => number,
    private readonly timeoutMs = 5 * 60 * 1000,
  ) {}

  async handle(request: RpcRequest): Promise<unknown> {
    if (request.method === 'item/tool/requestUserInput') return { answers: {} }
    if (request.method === 'mcpServer/elicitation/request') {
      return { action: 'decline', content: null, _meta: null }
    }
    if (
      request.method !== 'item/commandExecution/requestApproval'
      && request.method !== 'item/fileChange/requestApproval'
    ) {
      throw new BridgeError('unsupported_server_request', `Unsupported Codex request: ${request.method}`, 400)
    }

    const runId = this.resolveRunId(request)
    if (!runId) return { decision: 'decline' }
    const agent = this.db.prepare(`
      SELECT a.approval_policy
      FROM bridge_runs r JOIN bridge_agents a ON a.agent_id = r.agent_id
      WHERE r.run_id = ?
    `).get(runId) as { approval_policy: string } | undefined
    if (!agent || agent.approval_policy === 'never') return { decision: 'decline' }

    const appServerGeneration = this.resolveAppServerGeneration()
    const providerRequestId = String(request.id)
    const providerKey = `${appServerGeneration}:${providerRequestId}`
    const existingApprovalId = [...this.pending.entries()]
      .find(([, pending]) => pending.providerKey === providerKey)?.[0]
    if (existingApprovalId) return this.pending.get(existingApprovalId)!.promise

    const approvalId = randomUUID()
    const expiresAt = new Date(Date.now() + this.timeoutMs).toISOString()
    this.db.prepare(`
      INSERT INTO bridge_approvals(
        approval_id, run_id, app_server_generation, provider_request_id, category, request_json,
        expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      approvalId,
      runId,
      appServerGeneration,
      providerRequestId,
      request.method.includes('fileChange') ? 'file_change' : 'command',
      JSON.stringify(request.params ?? {}),
      expiresAt,
      now(),
    )
    this.db.prepare(`UPDATE bridge_runs SET state = 'waiting_approval', updated_at = ? WHERE run_id = ?`)
      .run(now(), runId)
    this.db.prepare(`
      INSERT INTO bridge_events(run_id, sequence, type, payload_json, created_at)
      VALUES (
        ?,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM bridge_events WHERE run_id = ?),
        'approval_request',
        ?,
        ?
      )
    `).run(runId, runId, JSON.stringify({ approvalId, method: request.method, params: request.params ?? {} }), now())

    let resolveDecision!: (result: unknown) => void
    const promise = new Promise<unknown>((resolve) => {
      resolveDecision = resolve
    })
    const timer = setTimeout(() => {
      this.pending.delete(approvalId)
      this.db.prepare(`
        UPDATE bridge_approvals SET state = 'expired', decided_at = ? WHERE approval_id = ?
      `).run(now(), approvalId)
      this.db.prepare(`
        UPDATE bridge_runs SET state = 'running', updated_at = ?
        WHERE run_id = ? AND state = 'waiting_approval'
      `).run(now(), runId)
      this.logger.warn('Codex approval expired', {
        approvalId,
        runId,
        appServerGeneration,
        providerRequestId,
      })
      resolveDecision({ decision: 'decline' })
    }, this.timeoutMs)
    this.pending.set(approvalId, {
      resolve: resolveDecision,
      timer,
      promise,
      providerKey,
    })
    return promise
  }

  list(runId?: string): Array<Record<string, unknown>> {
    const rows = runId
      ? this.db.prepare(`
          SELECT p.*, r.agent_id
          FROM bridge_approvals p JOIN bridge_runs r ON r.run_id = p.run_id
          WHERE p.run_id = ? ORDER BY p.created_at DESC
        `).all(runId)
      : this.db.prepare(`
          SELECT p.*, r.agent_id
          FROM bridge_approvals p JOIN bridge_runs r ON r.run_id = p.run_id
          WHERE p.state = 'pending' ORDER BY p.created_at ASC
        `).all()
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      approvalId: row.approval_id,
      runId: row.run_id,
      agentId: row.agent_id,
      appServerGeneration: row.app_server_generation,
      providerRequestId: row.provider_request_id,
      category: row.category,
      request: JSON.parse(String(row.request_json)),
      state: row.state,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    }))
  }

  decide(approvalId: string, decision: 'approve' | 'decline'): void {
    const row = this.db.prepare('SELECT * FROM bridge_approvals WHERE approval_id = ?').get(approvalId) as {
      run_id: string
      state: string
      expires_at: string
    } | undefined
    if (!row) throw new BridgeError('approval_not_found', `Unknown approval: ${approvalId}`, 404)
    if (row.state !== 'pending') throw new BridgeError('approval_already_decided', 'Approval is no longer pending', 409)
    if (Date.parse(row.expires_at) <= Date.now()) throw new BridgeError('approval_expired', 'Approval has expired', 409)
    const waiter = this.pending.get(approvalId)
    if (!waiter) throw new BridgeError('approval_delivery_unknown', 'Approval waiter is not active', 409)
    clearTimeout(waiter.timer)
    this.pending.delete(approvalId)
    this.db.prepare(`
      UPDATE bridge_approvals
      SET state = ?, decision_json = ?, decided_at = ?
      WHERE approval_id = ?
    `).run(decision === 'approve' ? 'approved' : 'declined', JSON.stringify({ decision }), now(), approvalId)
    this.db.prepare(`
      UPDATE bridge_runs SET state = 'running', updated_at = ?
      WHERE run_id = ? AND state = 'waiting_approval'
    `).run(now(), row.run_id)
    this.db.prepare(`
      INSERT INTO bridge_events(run_id, sequence, type, payload_json, created_at)
      VALUES (
        ?,
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM bridge_events WHERE run_id = ?),
        'approval_result',
        ?,
        ?
      )
    `).run(
      row.run_id,
      row.run_id,
      JSON.stringify({ approvalId, decision }),
      now(),
    )
    waiter.resolve({ decision: decision === 'approve' ? 'accept' : 'decline' })
  }

  shutdown(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve({ decision: 'decline' })
    }
    this.pending.clear()
  }
}
