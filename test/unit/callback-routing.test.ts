import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shouldEnqueueProviderCallback } from '../../src/runs/run-engine.js'

test('provider callbacks are emitted only for Béla message-backed runs', () => {
  assert.equal(shouldEnqueueProviderCallback(true, {
    context: { belaMessageId: 123, fromAgent: 'bela', toAgent: 'codex-dev' },
  }), true)
  assert.equal(shouldEnqueueProviderCallback(true, {
    context: { source: 'direct-admin-api' },
  }), false)
  assert.equal(shouldEnqueueProviderCallback(true, {
    context: { belaMessageId: 0 },
  }), false)
  assert.equal(shouldEnqueueProviderCallback(true, {
    context: { belaMessageId: '123' },
  }), false)
  assert.equal(shouldEnqueueProviderCallback(false, {
    context: { belaMessageId: 123 },
  }), false)
})
