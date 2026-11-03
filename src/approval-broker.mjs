import { randomUUID } from 'node:crypto'

function approvalError(code, message, status = 409) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function mapApproval(row) {
  if (!row) return null
  return {
    approvalId: row.approval_id,
    runId: row.run_id,
    agentId: row.agent_id,
    appServerGeneration: row.app_server_generation,
    providerRequestId: row.provider_request_id,
    category: row.category,
    request: JSON.parse(row.request_json),
    state: row.state,
    decision: row.decision_json === null ? null : JSON.parse(row.decision_json),
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    decidedAtMs: row.decided_at_ms,
  }
}

export class ApprovalBroker {
  constructor({
    state,
    timeoutMs,
    clock = Date.now,
    onEvent = () => {},
  }) {
    this.state = state
    this.timeoutMs = timeoutMs
    this.clock = clock
    this.onEvent = onEvent
    this.pending = new Map()
    this.pendingByProvider = new Map()
  }

  reconcileAfterRestart() {
    const now = this.clock()
    const changed = this.state.db.prepare(`
      UPDATE codex_approvals
      SET state = 'expired',
          decision_json = '{"decision":"decline","reason":"app_server_restart"}',
          decided_at_ms = ?
      WHERE state = 'pending'
    `).run(now).changes
    if (changed > 0) this.onEvent('approvals_expired_after_restart', { count: changed })
    return changed
  }

  request({ runId, agentId, generation, providerRequestId, category, request }) {
    const providerKey = `${generation}:${providerRequestId}`
    const currentId = this.pendingByProvider.get(providerKey)
    if (currentId) return this.pending.get(currentId).promise

    const existing = this.state.db.prepare(`
      SELECT * FROM codex_approvals
      WHERE app_server_generation = ? AND provider_request_id = ?
    `).get(generation, providerRequestId)
    if (existing) {
      if (existing.run_id !== runId || existing.agent_id !== agentId) {
        throw approvalError(
          'approval_identity_conflict',
          'Provider request id is already bound to another active run',
        )
      }
      if (existing.state !== 'pending') {
        return Promise.resolve({
          decision: existing.state === 'approved' ? 'accept' : 'decline',
        })
      }
      throw approvalError(
        'approval_waiter_missing',
        'Pending approval has no active App Server request',
      )
    }

    const approvalId = randomUUID()
    const createdAtMs = this.clock()
    const expiresAtMs = createdAtMs + this.timeoutMs
    this.state.db.prepare(`
      INSERT INTO codex_approvals(
        approval_id, run_id, agent_id, app_server_generation,
        provider_request_id, category, request_json, state,
        expires_at_ms, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      approvalId,
      runId,
      agentId,
      generation,
      providerRequestId,
      category,
      JSON.stringify(request),
      expiresAtMs,
      createdAtMs,
    )

    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    const timer = setTimeout(() => {
      this.finish(approvalId, 'expired', {
        decision: 'decline',
        reason: 'timeout',
      })
    }, this.timeoutMs)
    timer.unref()
    this.pending.set(approvalId, { promise, resolve, timer, providerKey })
    this.pendingByProvider.set(providerKey, approvalId)
    this.onEvent('approval_requested', { approvalId, runId, agentId, category })
    return promise
  }

  list({ state = 'pending', runId = null } = {}) {
    const clauses = []
    const values = []
    if (state !== null) {
      if (!['pending', 'approved', 'declined', 'expired'].includes(state)) {
        throw approvalError('invalid_approval_state', 'Invalid approval state', 400)
      }
      clauses.push('state = ?')
      values.push(state)
    }
    if (runId !== null) {
      clauses.push('run_id = ?')
      values.push(runId)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.state.db.prepare(`
      SELECT * FROM codex_approvals ${where}
      ORDER BY created_at_ms ASC
    `).all(...values).map(mapApproval)
  }

  get(approvalId) {
    return mapApproval(this.state.db.prepare(`
      SELECT * FROM codex_approvals WHERE approval_id = ?
    `).get(approvalId))
  }

  decide(approvalId, decision) {
    if (decision !== 'approve' && decision !== 'decline') {
      throw approvalError('invalid_approval_decision', 'Decision must be approve or decline', 400)
    }
    const row = this.get(approvalId)
    if (!row) throw approvalError('approval_not_found', 'Approval was not found', 404)
    const desiredState = decision === 'approve' ? 'approved' : 'declined'
    if (row.state === desiredState) return { approval: row, duplicate: true }
    if (row.state !== 'pending') {
      throw approvalError('approval_already_decided', 'Approval already has another decision')
    }
    if (row.expiresAtMs <= this.clock()) {
      this.finish(approvalId, 'expired', {
        decision: 'decline',
        reason: 'timeout',
      })
      throw approvalError('approval_expired', 'Approval has expired')
    }
    if (!this.pending.has(approvalId)) {
      throw approvalError(
        'approval_waiter_missing',
        'Approval cannot be delivered to the App Server',
      )
    }
    this.finish(approvalId, desiredState, { decision })
    return { approval: this.get(approvalId), duplicate: false }
  }

  finish(approvalId, state, decision) {
    const waiter = this.pending.get(approvalId)
    const changed = this.state.db.prepare(`
      UPDATE codex_approvals
      SET state = ?, decision_json = ?, decided_at_ms = ?
      WHERE approval_id = ? AND state = 'pending'
    `).run(state, JSON.stringify(decision), this.clock(), approvalId).changes
    if (changed !== 1) return false
    if (waiter) {
      clearTimeout(waiter.timer)
      this.pending.delete(approvalId)
      this.pendingByProvider.delete(waiter.providerKey)
      waiter.resolve({ decision: state === 'approved' ? 'accept' : 'decline' })
    }
    this.onEvent('approval_decided', { approvalId, state })
    return true
  }

  shutdown(reason = 'bridge_shutdown') {
    for (const approvalId of [...this.pending.keys()]) {
      this.finish(approvalId, 'expired', { decision: 'decline', reason })
    }
  }
}
