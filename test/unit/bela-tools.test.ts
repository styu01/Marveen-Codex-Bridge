import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'
import {
  BELA_DYNAMIC_TOOLS,
  BELA_TOOL_SPECS,
  callBelaFacadeTool,
} from '../../src/tools/bela-tools.js'

test('dynamic tool definitions cover the same four tools as MCP', () => {
  assert.deepEqual(
    BELA_DYNAMIC_TOOLS.map((tool) => tool.name).sort(),
    BELA_TOOL_SPECS.map((tool) => tool.name).sort(),
  )
  assert.equal(BELA_DYNAMIC_TOOLS.length, 4)
  assert.ok(BELA_DYNAMIC_TOOLS.every((tool) => tool.deferLoading === false))
})

test('all Béla tools map to the scoped facade routes with bearer identity', async () => {
  const requests: Array<{
    method: string
    url: string
    authorization: string
    body: Record<string, unknown> | null
  }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: String(req.headers.authorization ?? ''),
        body: raw ? JSON.parse(raw) as Record<string, unknown> : null,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const common = {
    origin: `http://127.0.0.1:${address.port}`,
    token: 'bcm1.codex-dev.signature',
  }
  try {
    await callBelaFacadeTool({
      ...common,
      name: 'bela_agent_message_send',
      args: { to: 'bela', content: 'hello', ref: 'r1' },
    })
    await callBelaFacadeTool({
      ...common,
      name: 'bela_agent_message_status',
      args: { id: 42 },
    })
    await callBelaFacadeTool({
      ...common,
      name: 'bela_memory_search',
      args: { query: 'needle', limit: 3 },
    })
    await callBelaFacadeTool({
      ...common,
      name: 'bela_memory_get',
      args: { id: 'opaque-memory-id-1234' },
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  assert.deepEqual(requests, [
    {
      method: 'POST',
      url: '/api/codex-facade/messages',
      authorization: 'Bearer bcm1.codex-dev.signature',
      body: { to: 'bela', content: 'hello', ref: 'r1' },
    },
    {
      method: 'GET',
      url: '/api/codex-facade/messages/42',
      authorization: 'Bearer bcm1.codex-dev.signature',
      body: null,
    },
    {
      method: 'POST',
      url: '/api/codex-facade/memories/search',
      authorization: 'Bearer bcm1.codex-dev.signature',
      body: { query: 'needle', limit: 3 },
    },
    {
      method: 'GET',
      url: '/api/codex-facade/memories/opaque-memory-id-1234',
      authorization: 'Bearer bcm1.codex-dev.signature',
      body: null,
    },
  ])
})

test('Béla tool arguments fail closed before an HTTP request', async () => {
  await assert.rejects(
    callBelaFacadeTool({
      name: 'bela_agent_message_send',
      args: { to: 'bela', content: '', sender: 'forged-agent' },
      origin: 'http://127.0.0.1:1',
      token: 'unused',
    }),
    /Unknown tool argument/,
  )
  await assert.rejects(
    callBelaFacadeTool({
      name: 'bela_memory_search',
      args: { query: 'x', limit: 21 },
      origin: 'http://127.0.0.1:1',
      token: 'unused',
    }),
    /limit must be an integer between 1 and 20/,
  )
})
