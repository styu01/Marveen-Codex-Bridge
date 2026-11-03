import { requiredPeerConfiguration } from './peer-config.mjs'

function boundedError(value, max = 500) {
  return String(value).replaceAll(/\s+/g, ' ').slice(0, max)
}

const MAX_ACK_BODY_BYTES = 64 * 1024

async function responseBody(response) {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > MAX_ACK_BODY_BYTES) {
    await response.body?.cancel()
    return { text: '', json: null, tooLarge: true }
  }
  const chunks = []
  let size = 0
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength
      if (size > MAX_ACK_BODY_BYTES) {
        await response.body.cancel().catch(() => {})
        return { text: '', json: null, tooLarge: true }
      }
      chunks.push(Buffer.from(chunk))
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return { text, json: null, tooLarge: false }
  try {
    return { text, json: JSON.parse(text), tooLarge: false }
  } catch {
    return { text, json: null, tooLarge: false }
  }
}

export class FederationOutboxWorker {
  constructor({
    store,
    peerResolver,
    fetchImpl = fetch,
    workerId,
    timeoutMs = 5_000,
    leaseMs = 30_000,
    maxAttempts = 8,
    initialDelayMs = 1_000,
    maxDelayMs = 300_000,
    jitterRatio = 0.2,
    random = Math.random,
  }) {
    if (!store) throw new TypeError('store is required')
    if (typeof peerResolver !== 'function') throw new TypeError('peerResolver is required')
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required')
    if (typeof workerId !== 'string' || workerId.length === 0) {
      throw new TypeError('workerId is required')
    }
    this.store = store
    this.peerResolver = peerResolver
    this.fetchImpl = fetchImpl
    this.workerId = workerId
    this.timeoutMs = timeoutMs
    this.leaseMs = leaseMs
    this.maxAttempts = maxAttempts
    this.initialDelayMs = initialDelayMs
    this.maxDelayMs = maxDelayMs
    this.jitterRatio = jitterRatio
    this.random = random
    this.running = false
  }

  async tick(limit = 20) {
    if (this.running) return { skipped: true, claimed: 0, delivered: 0, retried: 0, dead: 0 }
    this.running = true
    const summary = { skipped: false, claimed: 0, delivered: 0, retried: 0, dead: 0 }
    try {
      const claimed = this.store.claimOutbox({
        workerId: this.workerId,
        limit,
        leaseMs: this.leaseMs,
        maxAttempts: this.maxAttempts,
      })
      summary.claimed = claimed.length
      const outcomes = await Promise.all(claimed.map((item) => this.deliver(item)))
      for (const outcome of outcomes) {
        if (outcome === 'lost') summary.lost = (summary.lost ?? 0) + 1
        else summary[outcome] += 1
      }
      return summary
    } finally {
      this.running = false
    }
  }

  async deliver(item) {
    let peer
    try {
      peer = requiredPeerConfiguration(this.peerResolver(item.peerId), item.peerId)
    } catch (error) {
      return this.fail(item, {
        error: boundedError(error.message),
        networkError: true,
      })
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    timeout.unref?.()
    try {
      const response = await this.fetchImpl(
        new URL('/api/federation/inbox', peer.baseUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${peer.outboundToken}`,
            'content-type': 'application/json',
            'idempotency-key': item.messageKey,
          },
          body: JSON.stringify({
            federationVersion: 1,
            from: item.from,
            to: item.to,
            content: item.content,
            ref: item.ref,
          }),
          signal: controller.signal,
        },
      )
      const body = await responseBody(response)
      if (!response.ok) {
        return this.fail(item, {
          error: `Federation HTTP ${response.status}`,
          httpStatus: response.status,
        })
      }
      if (
        body.tooLarge
        ||
        !body.json
        || (typeof body.json.id !== 'number' && typeof body.json.id !== 'string')
        || body.json.ref !== item.ref
      ) {
        return this.fail(item, {
          error: 'Federation peer returned an invalid acknowledgement',
          networkError: true,
        })
      }
      this.store.markOutboxDelivered({
        outboxId: item.outboxId,
        workerId: this.workerId,
        remoteId: body.json.id,
        httpStatus: response.status,
      })
      return 'delivered'
    } catch (error) {
      if (error?.code === 'lease_lost') return 'lost'
      const message = error?.name === 'AbortError'
        ? `Federation request timed out after ${this.timeoutMs}ms`
        : `Federation request failed: ${boundedError(error?.message ?? error)}`
      return this.fail(item, { error: message, networkError: true })
    } finally {
      clearTimeout(timeout)
    }
  }

  fail(item, failure) {
    let row
    try {
      row = this.store.markOutboxFailed({
      outboxId: item.outboxId,
      workerId: this.workerId,
      ...failure,
      maxAttempts: this.maxAttempts,
      initialDelayMs: this.initialDelayMs,
      maxDelayMs: this.maxDelayMs,
      jitterRatio: this.jitterRatio,
      random: this.random,
      })
    } catch (error) {
      if (error?.code === 'lease_lost') return 'lost'
      throw error
    }
    return row.state === 'dead' ? 'dead' : 'retried'
  }
}
