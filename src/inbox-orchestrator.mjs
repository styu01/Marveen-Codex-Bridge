// A submitted Codex turn must not be retried by a new provider turn. The
// runtime's persistent idempotency state also blocks unsafe replays.
const NON_REPLAYABLE_ERRORS = new Set([
  'runtime_indeterminate', 'runtime_run_not_replayable',
  'turn_timeout', 'turn_interrupt_unconfirmed', 'app_server_exit',
  'provider_turn_failed', 'runtime_invalid_response', 'rpc_timeout',
])

export class FederationInboxOrchestrator {
  constructor({
    store,
    runtime,
    systemId,
    workerId,
    leaseMs = 1_800_000,
    heartbeatIntervalMs = null,
    maxAttempts = 3,
    initialDelayMs = 1_000,
    maxDelayMs = 60_000,
    jitterRatio = 0.2,
    random = Math.random,
  }) {
    if (!store) throw new TypeError('store is required')
    if (!runtime || typeof runtime.run !== 'function') throw new TypeError('runtime is required')
    if (typeof systemId !== 'string' || systemId.length === 0) {
      throw new TypeError('systemId is required')
    }
    if (typeof workerId !== 'string' || workerId.length === 0) {
      throw new TypeError('workerId is required')
    }
    this.store = store
    this.runtime = runtime
    this.systemId = systemId
    this.workerId = workerId
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('leaseMs must be a positive safe integer')
    }
    const interval = heartbeatIntervalMs ?? Math.max(25, Math.min(30_000, Math.floor(leaseMs / 3)))
    if (!Number.isSafeInteger(interval) || interval < 1 || interval >= leaseMs) {
      throw new TypeError('heartbeatIntervalMs must be positive and shorter than leaseMs')
    }
    this.leaseMs = leaseMs
    this.heartbeatIntervalMs = interval
    this.maxAttempts = maxAttempts
    this.initialDelayMs = initialDelayMs
    this.maxDelayMs = maxDelayMs
    this.jitterRatio = jitterRatio
    this.random = random
    this.running = false
  }

  async tick(limit = 1) {
    if (this.running) return { skipped: true, claimed: 0, completed: 0, retried: 0, failed: 0 }
    this.running = true
    const summary = { skipped: false, claimed: 0, completed: 0, retried: 0, failed: 0 }
    try {
      const claimed = this.store.claimInbox({
        workerId: this.workerId,
        limit,
        leaseMs: this.leaseMs,
        maxAttempts: this.maxAttempts,
      })
      summary.claimed = claimed.length
      const outcomes = await Promise.all(claimed.map((item) => this.execute(item)))
      for (const outcome of outcomes) {
        if (outcome === 'lost') summary.lost = (summary.lost ?? 0) + 1
        else summary[outcome] += 1
      }
      return summary
    } finally {
      this.running = false
    }
  }

  async execute(item) {
    // A synchronous, owner-fenced renewal cannot overlap the synchronous
    // completion transaction in this process. Fail closed if storage rejects it.
    let leaseError = null
    const heartbeat = setInterval(() => {
      if (leaseError) return
      try {
        this.store.renewClaimedInbox({
          inboxId: item.inboxId,
          workerId: this.workerId,
          leaseMs: this.leaseMs,
        })
      } catch (error) {
        leaseError = error
        clearInterval(heartbeat)
      }
    }, this.heartbeatIntervalMs)
    heartbeat.unref?.()
    try {
      const result = await this.runtime.run({
        agentId: item.to,
        prompt: item.content,
        context: {
          federation: {
            inboxId: item.inboxId,
            peerId: item.peerId,
            from: item.from,
            ref: item.ref,
          },
        },
        idempotencyKey: `federation-inbox-${item.inboxId}`,
      })
      // Do not commit a stale result after the worker has lost its lease.
      if (leaseError) throw leaseError
      this.store.completeClaimedInboxWithReply({
        inboxId: item.inboxId,
        workerId: this.workerId,
        systemId: this.systemId,
        response: result.response,
        runId: result.runId,
        artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      })
      return 'completed'
    } catch (error) {
      // Losing ownership is NOT an ordinary retryable runtime failure.
      // Another worker may already own the item; never mutate its state.
      if (leaseError || error?.code === 'lease_lost') return 'lost'
      let row
      try {
        row = this.store.failClaimedInbox({
        inboxId: item.inboxId,
        workerId: this.workerId,
        errorCode: typeof error?.code === 'string' ? error.code : 'runtime_failed',
        forceTerminal: NON_REPLAYABLE_ERRORS.has(error?.code),
        maxAttempts: this.maxAttempts,
        initialDelayMs: this.initialDelayMs,
        maxDelayMs: this.maxDelayMs,
        jitterRatio: this.jitterRatio,
        random: this.random,
        })
      } catch (failure) {
        if (failure?.code === 'lease_lost') return 'lost'
        throw failure
      }
      return row.state === 'failed' ? 'failed' : 'retried'
    } finally {
      clearInterval(heartbeat)
    }
  }
}
