import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { FederationDurabilityStore, DurabilityError } from './durability-store.mjs'
import {
  INBOX_MAX_BODY_BYTES,
  validateInbox,
  validateManifest,
} from './federation-contract.mjs'
import { FederationInboxOrchestrator } from './inbox-orchestrator.mjs'
import { FederationOutboxWorker } from './outbox-delivery.mjs'
import { publicConfig } from './config.mjs'

const BRIDGE_VERSION = '0.3.4'
const DASHBOARD_FILES = new Map([
  ['/dashboard', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
  ['/dashboard/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
  ['/dashboard/app.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/app.js', import.meta.url))]],
  ['/dashboard/styles.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/styles.css', import.meta.url))]],
])

function tokenDigest(token) {
  return createHash('sha256').update(token).digest()
}

function bearerToken(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  return header.slice(7)
}

function sameToken(candidate, expected) {
  if (candidate === null) return false
  return timingSafeEqual(tokenDigest(candidate), tokenDigest(expected))
}

function send(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sendBinary(response, status, value, contentType, filename) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': value.length,
    'content-disposition': `inline; filename="${filename}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  })
  response.end(value)
}

function sendDashboard(response, contentType, body) {
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; '),
  })
  response.end(body)
}

async function readJson(request) {
  const declared = Number.parseInt(request.headers['content-length'] ?? '', 10)
  if (Number.isFinite(declared) && declared > INBOX_MAX_BODY_BYTES) {
    throw Object.assign(new Error('request body too large'), { status: 413 })
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > INBOX_MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body too large'), { status: 413 })
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 })
  }
}

function safeInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}

export class FederationBridgeService {
  constructor({
    config,
    runtime,
    driver = 'better-sqlite3',
    betterSqlite3Path,
    fetchImpl = fetch,
    clock = Date.now,
    autoWorkers = true,
    settingsManager = null,
  }) {
    if (!config) throw new TypeError('config is required')
    if (!runtime) throw new TypeError('runtime is required')
    this.config = config
    this.runtime = runtime
    this.settingsManager = settingsManager
    this.autoWorkers = autoWorkers
    this.store = new FederationDurabilityStore(config.storage.database, {
      clock,
      driver,
      betterSqlite3Path,
    })
    this.store.migrate()
    if (typeof runtime.attachFederationStore === 'function') {
      runtime.attachFederationStore(this.store)
    }
    this.inboxWorker = new FederationInboxOrchestrator({
      store: this.store,
      runtime,
      systemId: config.systemId,
      workerId: `runtime-${process.pid}-${randomUUID()}`,
      leaseMs: config.workers.runtimeLeaseMs,
      maxAttempts: config.workers.runtimeMaxAttempts,
    })
    this.outboxWorker = new FederationOutboxWorker({
      store: this.store,
      workerId: `delivery-${process.pid}-${randomUUID()}`,
      peerResolver: (peerId) => config.peers.find((peer) => peer.id === peerId),
      fetchImpl,
      timeoutMs: config.workers.deliveryTimeoutMs,
      leaseMs: config.workers.deliveryLeaseMs,
      maxAttempts: config.workers.deliveryMaxAttempts,
    })
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        if (response.headersSent) {
          response.destroy()
          return
        }
        const status = Number.isInteger(error?.status) ? error.status : 500
        send(response, status, {
          error: status === 500 ? 'internal_error' : error.message,
        })
      })
    })
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 5_000
    this.server.maxHeadersCount = 100
    this.interval = null
    this.activeTicks = new Set()
  }

  manifest() {
    const manifest = {
      system: this.config.systemId,
      marveenVersion: `bridge-${BRIDGE_VERSION}`,
      federationVersion: 1,
      agents: this.runtime.manifestAgents(),
      skills: [],
    }
    const verdict = validateManifest(manifest, this.config.systemId)
    if (!verdict.ok) throw new Error(`invalid local manifest: ${verdict.error}`)
    return manifest
  }

  peerFromRequest(request) {
    const candidate = bearerToken(request.headers.authorization)
    return this.config.peers.find((peer) => sameToken(candidate, peer.inboundToken)) ?? null
  }

  isAdmin(request) {
    return sameToken(bearerToken(request.headers.authorization), this.config.admin.token)
  }

  readiness() {
    const database = this.store.integrityCheck()
    const runtimeReady = this.runtime.isReady()
    return {
      ready: database.ok && runtimeReady,
      database,
      runtimeReady,
    }
  }

  async route(request, response) {
    const method = request.method ?? 'GET'
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (method === 'GET' && DASHBOARD_FILES.has(url.pathname)) {
      const [contentType, body] = DASHBOARD_FILES.get(url.pathname)
      sendDashboard(response, contentType, body)
      return
    }
    if (method === 'GET' && url.pathname === '/healthz') {
      send(response, 200, { status: 'ok', bridgeVersion: BRIDGE_VERSION })
      return
    }
    if (method === 'GET' && url.pathname === '/readyz') {
      const state = this.readiness()
      send(response, state.ready ? 200 : 503, {
        status: state.ready ? 'ready' : 'not_ready',
        bridgeVersion: BRIDGE_VERSION,
        database: state.database.ok,
        runtime: state.runtimeReady,
      })
      return
    }

    if (url.pathname.startsWith('/api/federation/')) {
      const peer = this.peerFromRequest(request)
      if (!peer) {
        send(response, 401, { error: 'Unauthorized' })
        return
      }
      if (method === 'GET' && url.pathname === '/api/federation/manifest') {
        send(response, 200, this.manifest())
        return
      }
      if (method === 'POST' && url.pathname === '/api/federation/inbox') {
        const payload = await readJson(request)
        const verdict = validateInbox(payload, {
          peerId: peer.id,
          ownSystemId: this.config.systemId,
          agents: new Set(this.config.agents.map((agent) => agent.id)),
        })
        if (verdict.status !== 202) {
          send(response, verdict.status, { error: verdict.error })
          return
        }
        try {
          const accepted = this.store.acceptInbox({
            peerId: peer.id,
            from: verdict.value.from,
            to: verdict.value.to,
            content: verdict.value.content,
            ref: verdict.value.ref,
          })
          send(response, 202, {
            id: accepted.record.inboxId,
            ref: accepted.record.ref,
            ...(accepted.duplicate ? { duplicate: true } : {}),
          })
        } catch (error) {
          if (error instanceof DurabilityError && error.code === 'idempotency_conflict') {
            send(response, 409, { error: error.code })
            return
          }
          throw error
        }
        return
      }
      send(response, 404, { error: 'Not found' })
      return
    }

    if (url.pathname.startsWith('/v1/')) {
      if (!this.isAdmin(request)) {
        send(response, 401, { error: 'Unauthorized' })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/meta') {
        const ready = this.readiness()
        send(response, 200, {
          data: {
            bridgeVersion: BRIDGE_VERSION,
            federationVersion: 1,
            systemId: this.config.systemId,
            ready: ready.ready,
            runtimeReady: ready.runtimeReady,
            agents: this.runtime.manifestAgents(),
            capabilities: typeof this.runtime.capabilities === 'function'
              ? this.runtime.capabilities()
              : null,
            config: publicConfig(this.config),
          },
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/dashboard/summary') {
        const inbox = this.store.listInbox()
        const outbox = this.store.listOutbox()
        const inventoryErrors = []
        const inventory = (name, operation) => {
          try {
            return operation()
          } catch (error) {
            inventoryErrors.push({
              name,
              code: typeof error?.code === 'string' ? error.code : 'unavailable',
            })
            return []
          }
        }
        const approvals = typeof this.runtime.listApprovals === 'function'
          ? inventory('approvals', () => this.runtime.listApprovals({ state: 'pending' }))
          : []
        const runs = typeof this.runtime.listRuns === 'function'
          ? inventory('runs', () => this.runtime.listRuns({ limit: 100 }))
          : []
        send(response, 200, {
          data: {
            bridgeVersion: BRIDGE_VERSION,
            readiness: this.readiness(),
            agents: this.runtime.manifestAgents(),
            counts: {
              inbox: inbox.length,
              inboxFailed: inbox.filter((row) => row.state === 'failed').length,
              outbox: outbox.length,
              outboxDead: outbox.filter((row) => row.state === 'dead').length,
              pendingApprovals: approvals.length,
              runs: runs.length,
              runsFailed: runs.filter((row) => (
                row.state === 'failed' || row.state === 'interrupted_unknown'
              )).length,
            },
            inventoryErrors,
          },
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/dashboard/agent-settings') {
        if (!this.settingsManager) {
          send(response, 501, { error: 'agent_settings_unavailable' })
          return
        }
        send(response, 200, { data: this.settingsManager.current() })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/dashboard/agent-settings/audit') {
        if (!this.settingsManager) {
          send(response, 501, { error: 'agent_settings_unavailable' })
          return
        }
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
        send(response, 200, {
          data: this.settingsManager.audit(Number.isSafeInteger(limit) ? limit : 100),
        })
        return
      }
      if (method === 'PUT' && url.pathname === '/v1/dashboard/agent-settings') {
        if (!this.settingsManager) {
          send(response, 501, { error: 'agent_settings_unavailable' })
          return
        }
        try {
          const result = await this.settingsManager.update(await readJson(request))
          send(response, 200, { data: result })
        } catch (error) {
          send(response, Number.isInteger(error?.status) ? error.status : 500, {
            error: error?.code ?? 'agent_settings_failed',
            message: error?.message ?? 'Agent settings update failed',
          })
        }
        return
      }
      if (method === 'POST' && url.pathname === '/v1/dashboard/agent-settings/restore') {
        if (!this.settingsManager) {
          send(response, 501, { error: 'agent_settings_unavailable' })
          return
        }
        try {
          const result = await this.settingsManager.restore(await readJson(request))
          send(response, 200, { data: result })
        } catch (error) {
          send(response, Number.isInteger(error?.status) ? error.status : 500, {
            error: error?.code ?? 'agent_settings_restore_failed',
            message: error?.message ?? 'Agent settings restore failed',
          })
        }
        return
      }
      if (method === 'GET' && url.pathname === '/v1/runs') {
        if (typeof this.runtime.listRuns !== 'function') {
          send(response, 501, { error: 'run_inventory_unavailable' })
          return
        }
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
        send(response, 200, {
          data: this.runtime.listRuns({
            state: url.searchParams.get('state'),
            agentId: url.searchParams.get('agentId'),
            limit: Number.isSafeInteger(limit) ? limit : 100,
          }),
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/inbox') {
        send(response, 200, {
          data: this.store.listInbox({ state: url.searchParams.get('state') }),
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/outbox') {
        send(response, 200, {
          data: this.store.listOutbox({ state: url.searchParams.get('state') }),
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/approvals') {
        send(response, 200, {
          data: this.runtime.listApprovals({
            state: url.searchParams.has('state')
              ? url.searchParams.get('state') || null
              : 'pending',
            runId: url.searchParams.get('runId'),
          }),
        })
        return
      }
      if (method === 'GET' && url.pathname === '/v1/artifacts') {
        if (typeof this.runtime.listArtifacts !== 'function') {
          send(response, 501, { error: 'artifact_pipeline_unavailable' })
          return
        }
        send(response, 200, {
          data: this.runtime.listArtifacts({
            runId: url.searchParams.get('runId'),
            agentId: url.searchParams.get('agentId'),
          }),
        })
        return
      }
      const artifactContentMatch = url.pathname.match(
        /^\/v1\/artifacts\/([0-9a-f-]+)\/content$/,
      )
      if (method === 'GET' && artifactContentMatch) {
        if (typeof this.runtime.readArtifact !== 'function') {
          send(response, 501, { error: 'artifact_pipeline_unavailable' })
          return
        }
        const artifact = this.runtime.readArtifact(artifactContentMatch[1])
        if (!artifact) {
          send(response, 404, { error: 'artifact_not_found' })
          return
        }
        sendBinary(
          response,
          200,
          artifact.bytes,
          artifact.record.mimeType,
          `${artifact.record.artifactId}.png`,
        )
        return
      }
      const artifactGetMatch = url.pathname.match(/^\/v1\/artifacts\/([0-9a-f-]+)$/)
      if (method === 'GET' && artifactGetMatch) {
        if (typeof this.runtime.getArtifact !== 'function') {
          send(response, 501, { error: 'artifact_pipeline_unavailable' })
          return
        }
        const artifact = this.runtime.getArtifact(artifactGetMatch[1])
        send(
          response,
          artifact ? 200 : 404,
          artifact ? { data: artifact } : { error: 'artifact_not_found' },
        )
        return
      }
      const approvalGetMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)$/)
      if (method === 'GET' && approvalGetMatch) {
        const approval = this.runtime.getApproval(decodeURIComponent(approvalGetMatch[1]))
        send(
          response,
          approval ? 200 : 404,
          approval ? { data: approval } : { error: 'approval_not_found' },
        )
        return
      }
      const approvalDecisionMatch = url.pathname.match(
        /^\/v1\/approvals\/([^/]+)\/decision$/,
      )
      if (method === 'POST' && approvalDecisionMatch) {
        const payload = await readJson(request)
        if (
          !payload
          || typeof payload !== 'object'
          || (payload.decision !== 'approve' && payload.decision !== 'decline')
        ) {
          send(response, 400, { error: 'invalid_approval_decision' })
          return
        }
        const result = this.runtime.decideApproval(
          decodeURIComponent(approvalDecisionMatch[1]),
          payload.decision,
        )
        send(response, 200, { data: result })
        return
      }
      const inboxMatch = url.pathname.match(/^\/v1\/inbox\/(\d+)$/)
      if (method === 'GET' && inboxMatch) {
        const row = this.store.getInbox(safeInteger(inboxMatch[1]))
        send(response, row ? 200 : 404, row ? { data: row } : { error: 'not_found' })
        return
      }
      const outboxMatch = url.pathname.match(/^\/v1\/outbox\/(\d+)$/)
      if (method === 'GET' && outboxMatch) {
        const row = this.store.getOutbox(safeInteger(outboxMatch[1]))
        send(response, row ? 200 : 404, row ? { data: row } : { error: 'not_found' })
        return
      }
      const eventMatch = url.pathname.match(/^\/v1\/outbox\/(\d+)\/events$/)
      if (method === 'GET' && eventMatch) {
        send(response, 200, {
          data: this.store.listEvents(safeInteger(eventMatch[1])),
        })
        return
      }
      if (method === 'POST' && url.pathname === '/v1/workers/tick') {
        send(response, 200, { data: await this.tick() })
        return
      }
      send(response, 404, { error: 'Not found' })
      return
    }
    send(response, 404, { error: 'Not found' })
  }

  async tick() {
    const inbox = await this.inboxWorker.tick()
    const outbox = await this.outboxWorker.tick()
    return { inbox, outbox }
  }

  scheduleTick() {
    const operation = this.tick()
    this.activeTicks.add(operation)
    // finally() creates another rejected promise on failure. Use then() with
    // BOTH branches so the cleanup promise never leaks an unhandled rejection.
    void operation.then(
      () => this.activeTicks.delete(operation),
      () => this.activeTicks.delete(operation),
    )
    return operation
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.config.listen.port, this.config.listen.host, resolve)
    })
    if (this.autoWorkers) {
      this.interval = setInterval(() => {
        void this.scheduleTick().catch(() => ({
          inbox: { failed: 1 },
          outbox: { dead: 0 },
        }))
      }, this.config.workers.intervalMs)
      this.interval.unref()
      void this.scheduleTick().catch(() => {})
    }
    const address = this.server.address()
    return {
      host: this.config.listen.host,
      port: address.port,
      baseUrl: `http://${this.config.listen.host}:${address.port}`,
    }
  }

  async stop() {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve())
    })
    await Promise.allSettled([...this.activeTicks])
    this.store.checkpoint()
    this.store.close()
  }
}
