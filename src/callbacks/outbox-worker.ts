import type { BridgeConfig } from '../config.js'
import type { OutboxRepository } from '../db/repositories.js'
import type { Logger } from '../logging.js'

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly config: BridgeConfig,
    private readonly outbox: OutboxRepository,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (!this.config.callbacks.enabled || this.timer) return
    this.timer = setInterval(() => void this.tick(), 1000)
    this.timer.unref()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async drain(timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && this.outbox.next(1).length > 0) {
      await this.tick()
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const item of this.outbox.next()) {
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), this.config.callbacks.timeoutMs)
          const response = await fetch(`${this.config.callbacks.baseUrl}/api/provider-callbacks/codex`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.config.auth.token}`,
              'content-type': 'application/json',
              'idempotency-key': `${item.runId}:${item.eventType}`,
            },
            body: JSON.stringify(item.payload),
            signal: controller.signal,
          })
          clearTimeout(timer)
          if (!response.ok) throw new Error(`Callback HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
          this.outbox.delivered(item.outboxId)
        } catch (error) {
          const attempts = item.attempts + 1
          const dead = attempts >= this.config.callbacks.maxAttempts
          const delay = Math.min(
            this.config.callbacks.maxDelayMs,
            this.config.callbacks.initialDelayMs * 2 ** Math.min(attempts - 1, 20),
          )
          const jitter = Math.floor(Math.random() * Math.max(1, delay * 0.2))
          this.outbox.retry(
            item.outboxId,
            attempts,
            new Date(Date.now() + delay + jitter).toISOString(),
            (error as Error).message,
            dead,
          )
          this.logger.warn('Bridge callback delivery failed', {
            outboxId: item.outboxId,
            runId: item.runId,
            attempts,
            dead,
            error: (error as Error).message,
          })
        }
      }
    } finally {
      this.running = false
    }
  }
}
