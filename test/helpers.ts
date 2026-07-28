import { chmodSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BridgeConfig } from '../src/config.js'

export function testConfig(root: string): BridgeConfig {
  const fixture = resolve('test/fixtures/fake-codex.mjs')
  chmodSync(fixture, 0o755)
  mkdirSync(join(root, 'runtime'), { recursive: true })
  return {
    api: {
      unixSocket: join(root, 'bridge.sock'),
      socketMode: 0o600,
      maxBodyBytes: 1024 * 1024,
    },
    codex: {
      binary: fixture,
      expectedVersion: '0.145.0',
      model: 'gpt-5.6-terra',
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      turnTimeoutMs: 10000,
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 100,
      maxRestartsInWindow: 20,
      restartWindowMs: 60000,
    },
    storage: {
      database: join(root, 'bridge.sqlite3'),
      runtimeRoot: join(root, 'runtime'),
      lockFile: join(root, 'bridge.lock'),
    },
    runs: {
      globalConcurrency: 2,
      perAgentConcurrency: 1,
      maxQueuedPerAgent: 20,
      eventRetentionDays: 30,
      maxPromptBytes: 262144,
    },
    artifacts: {
      maxImageBytes: 50 * 1024 * 1024,
    },
    callbacks: {
      enabled: false,
      baseUrl: 'http://127.0.0.1:3420',
      timeoutMs: 1000,
      maxAttempts: 3,
      initialDelayMs: 10,
      maxDelayMs: 100,
    },
    logging: { level: 'error' },
    auth: { token: 'test-token-that-is-at-least-32-bytes-long' },
  }
}
