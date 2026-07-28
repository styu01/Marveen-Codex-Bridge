import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'

test('MCP server announces only the scoped Béla facade tools', async () => {
  const child = spawn(process.execPath, [
    resolve('dist/src/mcp/server.js'),
    '--agent',
    'codex-dev',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BELA_MCP_TOKEN_FILE: '/does/not/need/to/exist/for-inventory',
      BELA_API_ORIGIN: 'http://127.0.0.1:3420',
    },
  })
  const lines = createInterface({ input: child.stdout })
  const responses: Array<Record<string, unknown>> = []
  lines.on('line', (line) => responses.push(JSON.parse(line) as Record<string, unknown>))
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  })}\n`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`)

  await new Promise<void>((resolvePromise, reject) => {
    const deadline = setTimeout(() => reject(new Error('MCP inventory timed out')), 3000)
    const poll = setInterval(() => {
      if (responses.length >= 2) {
        clearInterval(poll)
        clearTimeout(deadline)
        resolvePromise()
      }
    }, 10)
  })
  child.kill('SIGTERM')
  const inventory = responses.find((row) => row.id === 2)?.result as {
    tools: Array<{ name: string }>
  }
  assert.deepEqual(
    inventory.tools.map((tool) => tool.name).sort(),
    [
      'bela_agent_message_send',
      'bela_agent_message_status',
      'bela_memory_get',
      'bela_memory_search',
    ],
  )
})
