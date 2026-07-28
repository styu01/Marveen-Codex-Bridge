import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeService } from '../../src/service.js'
import { testConfig } from '../helpers.js'

function call(
  endpoint: string | number,
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined
    const req = request({
      ...(typeof endpoint === 'string'
        ? { socketPath: endpoint }
        : { host: '127.0.0.1', port: endpoint }),
      method,
      path,
      headers: {
        authorization: `Bearer ${token}`,
        ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

test('full API run succeeds, persists events, and enforces bearer auth', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-service-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'
  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    const unauth = await call(endpoint, 'wrong', 'GET', '/v1/meta')
    assert.equal(unauth.status, 401)
    const meta = await call(endpoint, config.auth.token, 'GET', '/v1/meta')
    assert.equal(meta.body.bridgeVersion, '0.2.1')
    assert.deepEqual((meta.body.codex as Record<string, unknown>).reasoningEfforts, [
      'medium',
      'high',
      'xhigh',
    ])
    assert.deepEqual(
      ((meta.body.codex as Record<string, unknown>).imageGeneration),
      {
        available: true,
        model: 'gpt-image-2',
        effort: null,
        transport: 'codex-app-server',
        billing: 'chatgpt-subscription',
      },
    )
    assert.deepEqual(meta.body.toolContract, {
      revision: 2,
      exposure: ['dynamicTools', 'mcpInventory'],
      tools: [
        'bela_agent_message_send',
        'bela_agent_message_status',
        'bela_memory_search',
        'bela_memory_get',
        'bela_image_artifact_register',
      ],
      mcpTools: [
        'bela_agent_message_send',
        'bela_agent_message_status',
        'bela_memory_search',
        'bela_memory_get',
      ],
    })

    const upsert = await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      reasoningEffort: 'high',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Return concise results.',
    })
    assert.equal(upsert.status, 200)
    assert.equal((upsert.body.data as { reasoningEffort: string }).reasoningEffort, 'high')
    const start = await call(endpoint, config.auth.token, 'POST', '/v1/agents/codex-dev/start')
    assert.equal(start.status, 200)
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: 'Say hello', context: { source: 'test' } },
      { 'idempotency-key': 'integration-run-0001' },
    )
    assert.equal(accepted.status, 202)
    const runId = (accepted.body.data as { runId: string }).runId

    let run: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.state, 'succeeded')
    assert.match(String(run.finalResponse), /^FAKE_CODEX_OK:/)

    const events = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}/events`)
    const eventData = events.body.data as Array<{ type: string }>
    assert.ok(eventData.some((event) => event.type === 'assistant_text'))
    assert.ok(eventData.some((event) => event.type === 'turn_completed'))

    const duplicate = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: 'Say hello', context: { source: 'test' } },
      { 'idempotency-key': 'integration-run-0001' },
    )
    assert.equal(duplicate.status, 200)
    assert.equal(duplicate.body.duplicate, true)

    const invalidEffort = await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      reasoningEffort: 'max',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Return concise results.',
    })
    assert.equal(invalidEffort.status, 400)

    const changedEffort = await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      reasoningEffort: 'xhigh',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Return concise results.',
    })
    assert.equal(changedEffort.status, 200)
    assert.equal((changedEffort.body.data as { reasoningEffort: string }).reasoningEffort, 'xhigh')
    assert.equal((changedEffort.body.data as { configRevision: number }).configRevision, 2)
    const invalidatedAgent = await call(endpoint, config.auth.token, 'GET', '/v1/agents/codex-dev')
    assert.ok(
      (invalidatedAgent.body.data as { thread: { invalidatedAt: string } }).thread.invalidatedAt,
    )

    const effortRunAccepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: 'Verify effort change', context: { source: 'effort-test' } },
      { 'idempotency-key': 'integration-run-effort-0002' },
    )
    const effortRunId = (effortRunAccepted.body.data as { runId: string }).runId
    let effortRun: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${effortRunId}`)
      effortRun = result.body.data as Record<string, unknown>
      if (effortRun.state === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(effortRun.state, 'succeeded')
    assert.notEqual(effortRun.threadId, run.threadId)
    const effortAgent = await call(endpoint, config.auth.token, 'GET', '/v1/agents/codex-dev')
    assert.equal(
      ((effortAgent.body.data as { thread: { reasoningEffort: string } }).thread).reasoningEffort,
      'xhigh',
    )

    const deleted = await call(endpoint, config.auth.token, 'DELETE', '/v1/agents/codex-dev')
    assert.equal(deleted.status, 200)
    assert.match(String((deleted.body.data as { archivedRuntime: string }).archivedRuntime), /\.deleted/)
    assert.equal((await call(endpoint, config.auth.token, 'GET', '/v1/agents/codex-dev')).status, 404)
  } finally {
    await service.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('agent desired state and Codex thread survive a Bridge service restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-restart-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'

  const runOnce = async (
    endpoint: number,
    key: string,
  ): Promise<Record<string, unknown>> => {
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: `restart test ${key}`, context: { source: 'restart-test' } },
      { 'idempotency-key': key },
    )
    assert.equal(accepted.status, 202)
    const runId = (accepted.body.data as { runId: string }).runId
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      const run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded') return run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('run did not finish')
  }

  const first = new BridgeService(config)
  await first.start()
  let firstRun: Record<string, unknown>
  try {
    const endpoint = first.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Persistent test.',
    })).status, 200)
    assert.equal((await call(endpoint, config.auth.token, 'POST', '/v1/agents/codex-dev/start')).status, 200)
    firstRun = await runOnce(endpoint, 'restart-run-0001')
  } finally {
    await first.stop()
  }

  const second = new BridgeService(config)
  await second.start()
  try {
    const endpoint = second.api.testPort
    assert.ok(endpoint)
    const agent = await call(endpoint, config.auth.token, 'GET', '/v1/agents/codex-dev')
    assert.equal((agent.body.data as { desiredState: string }).desiredState, 'running')
    const secondRun = await runOnce(endpoint, 'restart-run-0002')
    assert.equal(secondRun.threadId, firstRun!.threadId)
  } finally {
    await second.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('image generation registers a workspace-confined artifact and exposes it through the API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-image-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  let callbackPayload: Record<string, unknown> | null = null
  const callbackServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      callbackPayload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => callbackServer.listen(0, '127.0.0.1', resolve))
  const callbackAddress = callbackServer.address()
  assert.ok(callbackAddress && typeof callbackAddress === 'object')
  const config = testConfig(root)
  config.callbacks.enabled = true
  config.callbacks.baseUrl = `http://127.0.0.1:${callbackAddress.port}`
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'
  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    const upsert = await call(endpoint, config.auth.token, 'PUT', '/v1/agents/image-dev', {
      displayName: 'Image Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Generate test images.',
    })
    assert.equal(upsert.status, 200)
    assert.equal((await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/start',
    )).status, 200)
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/runs',
      {
        prompt: 'IMAGE_GENERATION_TEST',
        context: { kind: 'image-test', belaMessageId: 77 },
      },
      { 'idempotency-key': 'image-generation-run-0001' },
    )
    const runId = (accepted.body.data as { runId: string }).runId
    let run: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.state, 'succeeded')
    const artifacts = run.artifacts as Array<Record<string, unknown>>
    assert.equal(artifacts.length, 1)
    const artifact = artifacts[0]!
    assert.equal(artifact.kind, 'image')
    assert.equal(artifact.status, 'ready')
    assert.equal(artifact.mimeType, 'image/png')
    assert.match(String(artifact.workspaceRelativePath), /^\.bela\/generated-images\//)
    assert.match(String(artifact.sha256), /^[0-9a-f]{64}$/)
    assert.ok(Number(artifact.byteSize) > 0)

    const artifactResponse = await call(
      endpoint,
      config.auth.token,
      'GET',
      `/v1/artifacts/${encodeURIComponent(String(artifact.artifactId))}`,
    )
    assert.equal(artifactResponse.status, 200)
    assert.equal(
      (artifactResponse.body.data as Record<string, unknown>).runId,
      runId,
    )
    const artifactList = await call(
      endpoint,
      config.auth.token,
      'GET',
      `/v1/runs/${runId}/artifacts`,
    )
    assert.equal((artifactList.body.data as unknown[]).length, 1)

    const events = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}/events`)
    assert.ok((events.body.data as Array<{ type: string }>).some(
      (event) => event.type === 'image_artifact_ready',
    ))
    for (let attempt = 0; attempt < 100 && !callbackPayload; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(callbackPayload)
    const callbackRun = (callbackPayload as Record<string, unknown>).run as Record<string, unknown>
    assert.equal(callbackRun.runId, runId)
    assert.equal((callbackRun.artifacts as unknown[]).length, 1)
    assert.equal(
      ((callbackRun.artifacts as Array<Record<string, unknown>>)[0]!).artifactId,
      artifact.artifactId,
    )
  } finally {
    await service.stop()
    await new Promise<void>((resolve, reject) => callbackServer.close(
      (error) => error ? reject(error) : resolve(),
    ))
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('image generation fails closed when Codex reports a path outside the agent workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-image-escape-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'
  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/image-dev', {
      displayName: 'Image Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Generate test images.',
    })).status, 200)
    assert.equal((await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/start',
    )).status, 200)
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/runs',
      { prompt: 'IMAGE_ESCAPE_TEST', context: {} },
      { 'idempotency-key': 'image-escape-run-0001' },
    )
    const runId = (accepted.body.data as { runId: string }).runId
    let run: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      run = result.body.data as Record<string, unknown>
      if (run.state === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.state, 'failed')
    assert.equal(run.errorCode, 'image_artifact_missing')
    assert.match(String(run.errorMessage), /without a registered final image/)
    assert.deepEqual(run.artifacts, [])
  } finally {
    await service.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('provider image staging is accepted only after the final workspace image is registered', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-image-register-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'
  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/image-dev', {
      displayName: 'Image Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Generate test images.',
    })).status, 200)
    assert.equal((await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/start',
    )).status, 200)
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/image-dev/runs',
      { prompt: 'IMAGE_STAGING_REGISTRATION_TEST', context: {} },
      { 'idempotency-key': 'image-staging-register-run-0001' },
    )
    const runId = (accepted.body.data as { runId: string }).runId
    let run: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded' || run.state === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.state, 'succeeded')
    assert.equal(run.finalResponse, 'FAKE_IMAGE_STAGING_REGISTRATION_OK')
    const artifacts = run.artifacts as Array<Record<string, unknown>>
    assert.equal(artifacts.length, 1)
    assert.equal(artifacts[0]?.workspaceRelativePath, 'assets/final-image.png')
    assert.equal(artifacts[0]?.mimeType, 'image/png')
    assert.match(String(artifacts[0]?.sha256), /^[0-9a-f]{64}$/)

    const events = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}/events`)
    const eventData = events.body.data as Array<{
      type: string
      payload: Record<string, unknown>
    }>
    assert.ok(eventData.some((event) => event.type === 'image_provider_staging_observed'))
    assert.ok(eventData.some(
      (event) => event.type === 'image_artifact_ready'
        && event.payload.source === 'dynamic-tool',
    ))
    assert.ok(eventData.some(
      (event) => event.type === 'dynamic_tool_completed'
        && event.payload.tool === 'bela_image_artifact_register'
        && event.payload.success === true,
    ))
  } finally {
    await service.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('dynamic Béla tool is exposed to the model path and dispatched with agent identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-dynamic-tool-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  let receivedAuthorization = ''
  let receivedBody: Record<string, unknown> = {}
  const facade = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      receivedAuthorization = String(req.headers.authorization ?? '')
      receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        data: {
          id: 321,
          status: 'delivered',
        },
      }))
    })
  })
  await new Promise<void>((resolve) => facade.listen(0, '127.0.0.1', resolve))
  const address = facade.address()
  assert.ok(address && typeof address === 'object')

  const config = testConfig(root)
  config.callbacks.baseUrl = `http://127.0.0.1:${address.port}`
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'
  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Use the requested Béla tool.',
    })).status, 200)
    assert.equal((await call(endpoint, config.auth.token, 'POST', '/v1/agents/codex-dev/start')).status, 200)
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: 'DYNAMIC_TOOL_TEST', context: {} },
      { 'idempotency-key': 'dynamic-tool-run-0001' },
    )
    assert.equal(accepted.status, 202)
    const runId = (accepted.body.data as { runId: string }).runId

    let run: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded') break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.equal(run.state, 'succeeded')
    assert.match(String(run.finalResponse), /^FAKE_DYNAMIC_TOOL_OK:true:/)
    assert.match(receivedAuthorization, /^Bearer bcm1\.codex-dev\./)
    assert.deepEqual(receivedBody, {
      to: 'bela',
      content: 'DYNAMIC_TOOL_DELIVERY_OK',
      ref: 'dynamic-tool-test',
    })

    const events = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}/events`)
    const eventData = events.body.data as Array<{ type: string; payload: Record<string, unknown> }>
    assert.ok(eventData.some((event) => event.type === 'dynamic_tool_started'))
    assert.ok(eventData.some(
      (event) => event.type === 'dynamic_tool_completed' && event.payload.success === true,
    ))
  } finally {
    await service.stop()
    await new Promise<void>((resolve, reject) => facade.close((error) => error ? reject(error) : resolve()))
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('legacy MCP-only thread is replaced once for the dynamic tool contract', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-tool-contract-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'

  const waitForRun = async (
    endpoint: number,
    key: string,
  ): Promise<Record<string, unknown>> => {
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: `tool contract ${key}`, context: {} },
      { 'idempotency-key': key },
    )
    const runId = (accepted.body.data as { runId: string }).runId
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      const run = result.body.data as Record<string, unknown>
      if (run.state === 'succeeded') return run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('run did not finish')
  }

  const first = new BridgeService(config)
  await first.start()
  let legacyThreadId = ''
  try {
    const endpoint = first.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      instructions: 'Tool contract migration test.',
    })).status, 200)
    assert.equal((await call(endpoint, config.auth.token, 'POST', '/v1/agents/codex-dev/start')).status, 200)
    const run = await waitForRun(endpoint, 'tool-contract-run-0001')
    legacyThreadId = String(run.threadId)
    first.database.raw.prepare(
      'UPDATE codex_threads SET tool_contract_revision = 0 WHERE agent_id = ?',
    ).run('codex-dev')
  } finally {
    await first.stop()
  }

  const second = new BridgeService(config)
  await second.start()
  try {
    const endpoint = second.api.testPort
    assert.ok(endpoint)
    const replacement = await waitForRun(endpoint, 'tool-contract-run-0002')
    assert.notEqual(replacement.threadId, legacyThreadId)
    assert.equal(second.repos.threads.get('codex-dev')?.toolContractRevision, 2)
  } finally {
    await second.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})

test('approval decline and approve survive provider request id reuse', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-approval-e2e-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  const service = new BridgeService(config)
  process.env.BELA_CODEX_BRIDGE_TEST_TCP = '1'

  const submit = async (endpoint: number, key: string): Promise<string> => {
    const accepted = await call(
      endpoint,
      config.auth.token,
      'POST',
      '/v1/agents/codex-dev/runs',
      { prompt: `APPROVAL_TEST ${key}`, context: { source: 'approval-regression' } },
      { 'idempotency-key': key },
    )
    assert.equal(accepted.status, 202)
    return (accepted.body.data as { runId: string }).runId
  }

  const waitForApproval = async (
    endpoint: number,
    runId: string,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await call(
        endpoint,
        config.auth.token,
        'GET',
        `/v1/approvals?runId=${encodeURIComponent(runId)}`,
      )
      const approval = (response.body.data as Array<Record<string, unknown>>)
        .find((item) => item.state === 'pending')
      if (approval) return approval
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`approval did not become pending for ${runId}`)
  }

  const waitForRun = async (
    endpoint: number,
    runId: string,
  ): Promise<Record<string, unknown>> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await call(endpoint, config.auth.token, 'GET', `/v1/runs/${runId}`)
      const run = response.body.data as Record<string, unknown>
      if (run.state === 'succeeded' || run.state === 'failed') return run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`run did not finish: ${runId}`)
  }

  await service.start()
  try {
    const endpoint = service.api.testPort
    assert.ok(endpoint)
    assert.equal((await call(endpoint, config.auth.token, 'PUT', '/v1/agents/codex-dev', {
      displayName: 'Codex Dev',
      workspacePath: workspace,
      workspaceMode: 'directory',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'bela',
      instructions: 'Deterministic approval test.',
    })).status, 200)
    assert.equal((await call(endpoint, config.auth.token, 'POST', '/v1/agents/codex-dev/start')).status, 200)

    const declinedRunId = await submit(endpoint, 'approval-decline-run')
    const declinedApproval = await waitForApproval(endpoint, declinedRunId)
    assert.equal(declinedApproval.providerRequestId, 'reusable-approval-request-id')
    const busyEffortChange = await call(
      endpoint,
      config.auth.token,
      'PUT',
      '/v1/agents/codex-dev',
      {
        displayName: 'Codex Dev',
        workspacePath: workspace,
        workspaceMode: 'directory',
        reasoningEffort: 'high',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'bela',
        instructions: 'Deterministic approval test.',
      },
    )
    assert.equal(busyEffortChange.status, 409)
    assert.equal(
      (busyEffortChange.body.error as { code: string }).code,
      'agent_busy',
    )
    const decline = await call(
      endpoint,
      config.auth.token,
      'POST',
      `/v1/approvals/${encodeURIComponent(String(declinedApproval.approvalId))}/decision`,
      { decision: 'decline' },
    )
    assert.equal(decline.status, 200)
    const declinedRun = await waitForRun(endpoint, declinedRunId)
    assert.equal(declinedRun.state, 'succeeded')
    assert.equal(declinedRun.finalResponse, 'FAKE_APPROVAL_RESULT:decline')

    const approvedRunId = await submit(endpoint, 'approval-approve-run')
    const approvedApproval = await waitForApproval(endpoint, approvedRunId)
    assert.equal(approvedApproval.providerRequestId, 'reusable-approval-request-id')
    assert.notEqual(approvedApproval.approvalId, declinedApproval.approvalId)
    const approve = await call(
      endpoint,
      config.auth.token,
      'POST',
      `/v1/approvals/${encodeURIComponent(String(approvedApproval.approvalId))}/decision`,
      { decision: 'approve' },
    )
    assert.equal(approve.status, 200)
    const approvedRun = await waitForRun(endpoint, approvedRunId)
    assert.equal(approvedRun.state, 'succeeded')
    assert.equal(approvedRun.finalResponse, 'FAKE_APPROVAL_RESULT:accept')

    const rows = service.database.raw.prepare(`
      SELECT state, provider_request_id, app_server_generation
      FROM bridge_approvals
      WHERE provider_request_id = ?
      ORDER BY created_at ASC
    `).all('reusable-approval-request-id') as Array<{
      state: string
      provider_request_id: string
      app_server_generation: number
    }>
    assert.deepEqual(rows.map((row) => row.state), ['declined', 'approved'])
    assert.ok(rows.every((row) => row.app_server_generation === service.supervisor.generation))
  } finally {
    await service.stop()
    delete process.env.BELA_CODEX_BRIDGE_TEST_TCP
  }
})
