import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProcessLock } from '../../src/process-lock.js'

test('process lock rejects a second owner and can be released', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'bridge-lock-')), 'bridge.lock')
  const first = new ProcessLock(path)
  const second = new ProcessLock(path)
  first.acquire()
  assert.throws(() => second.acquire(), /Another Bridge process/)
  first.release()
  second.acquire()
  second.release()
})
