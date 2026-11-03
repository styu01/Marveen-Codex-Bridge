import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

export const FEDERATION_VERSION = 1
export const INBOX_MAX_BODY_BYTES = 64 * 1024
export const MANIFEST_MAX_BODY_BYTES = 512 * 1024
export const MANIFEST_MAX_AGENTS = 100
export const MANIFEST_MAX_SKILLS = 300
export const MANIFEST_MAX_SUMMARY = 600
export const MANIFEST_MAX_SHORT_FIELD = 120
export const MANIFEST_MAX_DESCRIPTION = 300
export const INBOX_MAX_REF_LENGTH = 128
export const MIN_TOKEN_LENGTH = 32

const SEGMENT_RX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/

export function isValidSegment(value) {
  return typeof value === 'string' && SEGMENT_RX.test(value)
}

export function parseQualifiedId(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('/')
  if (parts.length !== 2) return null
  const [system, agent] = parts
  if (!isValidSegment(system) || !isValidSegment(agent)) return null
  return { system, agent }
}

function boundedString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function validateManifest(manifest, expectedSystem = 'codex') {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, error: 'manifest is not an object' }
  }
  if (
    !isValidSegment(manifest.system)
    || manifest.system.toLowerCase() !== expectedSystem.toLowerCase()
  ) {
    return { ok: false, error: 'system mismatch' }
  }
  if (
    typeof manifest.marveenVersion !== 'string'
    || manifest.marveenVersion.length === 0
    || manifest.marveenVersion.length > MANIFEST_MAX_SHORT_FIELD
  ) {
    return { ok: false, error: 'invalid marveenVersion' }
  }
  if (manifest.federationVersion !== FEDERATION_VERSION) {
    return { ok: false, error: 'unsupported federation version' }
  }
  if (!Array.isArray(manifest.agents) || manifest.agents.length > MANIFEST_MAX_AGENTS) {
    return { ok: false, error: 'invalid agents collection' }
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length > MANIFEST_MAX_SKILLS) {
    return { ok: false, error: 'invalid skills collection' }
  }
  for (const agent of manifest.agents) {
    if (!agent || typeof agent !== 'object' || !isValidSegment(agent.id)) {
      return { ok: false, error: 'invalid agent id' }
    }
    if (
      typeof agent.displayName !== 'string'
      || agent.displayName.length === 0
      || agent.displayName.length > MANIFEST_MAX_SHORT_FIELD
      || typeof agent.model !== 'string'
      || agent.model.length === 0
      || agent.model.length > MANIFEST_MAX_SHORT_FIELD
    ) {
      return { ok: false, error: 'invalid agent presentation' }
    }
    if (
      agent.capabilitySummary !== undefined
      && (
        typeof agent.capabilitySummary !== 'string'
        || agent.capabilitySummary.length > MANIFEST_MAX_SUMMARY
      )
    ) {
      return { ok: false, error: 'invalid capability summary' }
    }
  }
  for (const skill of manifest.skills) {
    if (
      !skill
      || typeof skill !== 'object'
      || !isValidSegment(skill.agent)
      || !isValidSegment(skill.name)
      || typeof skill.description !== 'string'
      || skill.description.length > MANIFEST_MAX_DESCRIPTION
    ) {
      return { ok: false, error: 'invalid skill' }
    }
  }
  const encoded = Buffer.from(JSON.stringify(manifest))
  if (encoded.length > MANIFEST_MAX_BODY_BYTES) {
    return { ok: false, error: 'manifest too large' }
  }
  return { ok: true }
}

export function validateInbox(payload, { peerId, ownSystemId, agents }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, error: 'Body must be a JSON object' }
  }
  if (payload.federationVersion !== FEDERATION_VERSION) {
    return { status: 400, error: 'Unsupported federationVersion' }
  }
  const from = parseQualifiedId(payload.from)
  if (!from) {
    return { status: 400, error: 'from must be a valid "<system>/<agent>" id' }
  }
  const fromSystem = from.system.toLowerCase()
  if (fromSystem === ownSystemId.toLowerCase()) {
    return { status: 403, error: 'from system equals this system' }
  }
  if (fromSystem !== peerId.toLowerCase()) {
    return { status: 403, error: 'from system does not match the authenticated peer' }
  }
  if (typeof payload.to !== 'string' || payload.to.includes('/')) {
    return { status: 403, error: 'to must be a local (unqualified) agent id' }
  }
  if (!isValidSegment(payload.to)) {
    return { status: 400, error: 'invalid to' }
  }
  if (!agents.has(payload.to)) {
    return { status: 404, error: `Unknown recipient agent '${payload.to}'` }
  }
  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
    return { status: 400, error: 'content is required' }
  }
  let ref = null
  if (payload.ref !== undefined && payload.ref !== null) {
    if (
      typeof payload.ref !== 'string'
      || payload.ref.length === 0
      || payload.ref.length > INBOX_MAX_REF_LENGTH
    ) {
      return { status: 400, error: 'invalid ref' }
    }
    ref = payload.ref
  }
  return {
    status: 202,
    value: {
      from: `${fromSystem}/${from.agent}`,
      to: payload.to,
      content: payload.content,
      ref,
    },
  }
}

function authorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const candidate = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

async function readBody(request) {
  const declared = Number.parseInt(String(request.headers['content-length'] ?? ''), 10)
  if (Number.isFinite(declared) && declared > INBOX_MAX_BODY_BYTES) {
    const error = new Error('body_too_large')
    error.code = 'body_too_large'
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > INBOX_MAX_BODY_BYTES) {
      const error = new Error('body_too_large')
      error.code = 'body_too_large'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function startContractPeer({
  manifest,
  token,
  peerId = 'marveen',
  host = '127.0.0.1',
  port = 0,
}) {
  if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`token must contain at least ${MIN_TOKEN_LENGTH} characters`)
  }
  const manifestVerdict = validateManifest(manifest, manifest.system)
  if (!manifestVerdict.ok) throw new Error(manifestVerdict.error)

  const agents = new Set(manifest.agents.map((agent) => agent.id))
  const dedup = new Map()
  const accepted = []
  let nextId = 1

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request.headers.authorization, token)) {
        sendJson(response, 401, { error: 'Unauthorized' })
        return
      }

      const url = new URL(request.url ?? '/', `http://${host}`)
      if (request.method === 'GET' && url.pathname === '/api/federation/manifest') {
        sendJson(response, 200, manifest)
        return
      }

      if (request.method === 'POST' && url.pathname === '/api/federation/inbox') {
        let raw
        try {
          raw = await readBody(request)
        } catch (error) {
          if (error.code === 'body_too_large') {
            sendJson(response, 413, { error: `Request body too large (max ${INBOX_MAX_BODY_BYTES} bytes)` })
            return
          }
          throw error
        }

        let payload
        try {
          payload = JSON.parse(raw)
        } catch {
          sendJson(response, 400, { error: 'Invalid JSON' })
          return
        }

        const verdict = validateInbox(payload, {
          peerId,
          ownSystemId: manifest.system,
          agents,
        })
        if (verdict.status !== 202) {
          sendJson(response, verdict.status, { error: verdict.error })
          return
        }

        const key = verdict.value.ref === null ? null : `${peerId}:${verdict.value.ref}`
        if (key !== null && dedup.has(key)) {
          sendJson(response, 202, {
            id: dedup.get(key),
            ref: verdict.value.ref,
            duplicate: true,
          })
          return
        }

        const id = nextId++
        accepted.push({ id, ...verdict.value })
        if (key !== null) dedup.set(key, id)
        sendJson(response, 202, { id, ref: verdict.value.ref })
        return
      }

      sendJson(response, 404, { error: 'Not found' })
    } catch {
      sendJson(response, 500, { error: 'Internal error' })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('unexpected server address')

  return {
    baseUrl: `http://${host}:${address.port}`,
    accepted,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

export function normalizeManifestForMarveen(manifest) {
  return {
    system: boundedString(manifest.system, 120),
    marveenVersion: boundedString(manifest.marveenVersion, 120) || 'unknown',
    federationVersion: Number.isFinite(manifest.federationVersion)
      ? manifest.federationVersion
      : 0,
    agents: manifest.agents.slice(0, MANIFEST_MAX_AGENTS),
    skills: manifest.skills.slice(0, MANIFEST_MAX_SKILLS),
  }
}
