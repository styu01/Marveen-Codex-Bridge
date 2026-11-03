import { createHash, randomUUID } from 'node:crypto'

function payloadHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export class MockCodexRuntime {
  constructor({ agents, responder, ready = true }) {
    this.agents = new Map(agents.map((agent) => [agent.id, { ...agent }]))
    this.responder = responder ?? (async ({ prompt }) => `MOCK_CODEX: ${prompt}`)
    this.online = ready
    this.runs = new Map()
    this.calls = []
  }

  isReady() {
    return this.online
  }

  setReady(value) {
    this.online = Boolean(value)
  }

  manifestAgents() {
    return [...this.agents.values()].map((agent) => ({ ...agent }))
  }

  listRuns({ state = null, agentId = null, limit = 100 } = {}) {
    return [...this.runs.values()]
      .map(({ result }) => ({
        model: this.agents.get(result.agentId)?.model ?? null,
        reasoningEffort: this.agents.get(result.agentId)?.reasoningEffort ?? null,
        idempotencyKey: result.idempotencyKey,
        runId: result.runId,
        agentId: result.agentId,
        state: 'succeeded',
        threadId: null,
        turnId: null,
        response: result.response,
        errorCode: null,
        errorMessage: null,
        createdAtMs: result.createdAtMs,
        updatedAtMs: result.createdAtMs,
        finishedAtMs: result.createdAtMs,
      }))
      .filter((run) => state === null || run.state === state)
      .filter((run) => agentId === null || run.agentId === agentId)
      .slice(0, Math.min(Math.max(limit, 1), 500))
  }

  listApprovals() {
    return []
  }

  listArtifacts() {
    return []
  }

  capabilities() {
    return {
      toolContractRevision: 2,
      imageGeneration: { available: true, model: 'gpt-image-2' },
    }
  }

  async run({ agentId, prompt, context, idempotencyKey }) {
    if (!this.online) throw Object.assign(new Error('runtime unavailable'), {
      code: 'runtime_unavailable',
    })
    if (!this.agents.has(agentId)) throw Object.assign(new Error('unknown runtime agent'), {
      code: 'agent_not_found',
    })
    const hash = payloadHash({ agentId, prompt, context })
    const existing = this.runs.get(idempotencyKey)
    if (existing) {
      if (existing.hash !== hash) throw Object.assign(new Error('runtime idempotency conflict'), {
        code: 'runtime_idempotency_conflict',
      })
      return { ...existing.result, duplicate: true }
    }
    const runId = randomUUID()
    this.calls.push({ runId, agentId, prompt, context, idempotencyKey })
    const response = await this.responder({
      runId,
      agentId,
      prompt,
      context,
      idempotencyKey,
    })
    if (typeof response !== 'string' || response.trim().length === 0) {
      throw Object.assign(new Error('runtime returned an empty response'), {
        code: 'runtime_invalid_response',
      })
    }
    const result = {
      runId,
      agentId,
      idempotencyKey,
      response,
      createdAtMs: Date.now(),
    }
    this.runs.set(idempotencyKey, { hash, result })
    return { ...result, duplicate: false }
  }
}
