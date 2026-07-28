import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactForTest } from '../../src/logging.js'

test('structured log redaction removes nested secrets and bearer values', () => {
  const value = redactForTest({
    authorization: 'Bearer abc.def',
    nested: { apiKey: 'secret', message: 'call Bearer another-token now' },
  }) as Record<string, unknown>
  assert.equal(value.authorization, '[REDACTED]')
  assert.deepEqual(value.nested, {
    apiKey: '[REDACTED]',
    message: 'call Bearer [REDACTED] now',
  })
})
