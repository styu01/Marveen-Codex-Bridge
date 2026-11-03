import { lstatSync, readFileSync } from 'node:fs'

export class CutoverApiError extends Error {
  constructor(message, { code = 'cutover_api_error', status = null } = {}) {
    super(message)
    this.name = 'CutoverApiError'
    this.code = code
    this.status = status
  }
}

export function readCutoverToken(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CutoverApiError('Dashboard token must be a regular non-symlink file', {
      code: 'unsafe_token_file',
    })
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new CutoverApiError('Dashboard token permissions must be 0600 or stricter', {
      code: 'unsafe_token_mode',
    })
  }
  const token = readFileSync(path, 'utf8').trim()
  if (token.length < 32 || /[\r\n]/.test(token)) {
    throw new CutoverApiError('Dashboard token is invalid', { code: 'invalid_token' })
  }
  return token
}

export function normalizeLoopbackOrigin(raw) {
  const url = new URL(raw)
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new CutoverApiError('Cutover API origin must be plain HTTP loopback', {
      code: 'invalid_origin',
    })
  }
  return url.toString().replace(/\/+$/, '')
}

async function jsonResponse(response, path) {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    throw new CutoverApiError(`${path} response is too large`, {
      code: 'response_too_large',
      status: response.status,
    })
  }
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new CutoverApiError(`${path} returned non-JSON`, {
      code: 'invalid_response',
      status: response.status,
    })
  }
  if (!response.ok) {
    throw new CutoverApiError(`${path} failed with HTTP ${response.status}`, {
      code: 'http_error',
      status: response.status,
    })
  }
  return body
}

export function createMarveenAdminClient({
  origin,
  token,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const normalizedOrigin = normalizeLoopbackOrigin(origin)
  if (typeof token !== 'string' || token.length < 32) {
    throw new CutoverApiError('Dashboard token is invalid', { code: 'invalid_token' })
  }
  return async (path, { method = 'GET', body } = {}) => {
    let response
    try {
      response = await fetchImpl(`${normalizedOrigin}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new CutoverApiError(`${path} is unreachable`, { code: 'unreachable' })
    }
    return jsonResponse(response, path)
  }
}

export async function preflightFederation({
  request,
  peerId = 'codex',
  requirePeer = false,
}) {
  const inventory = await request('/api/federation/peers')
  if (!inventory || !Array.isArray(inventory.peers)) {
    throw new CutoverApiError('Invalid Federation peer inventory', {
      code: 'invalid_inventory',
    })
  }
  if (inventory.enabled === true) {
    throw new CutoverApiError('Federation must be disabled before cutover', {
      code: 'already_enabled',
    })
  }
  const peers = inventory.peers.filter((peer) => peer?.id === peerId)
  if (peers.length > 1) {
    throw new CutoverApiError(`Duplicate '${peerId}' peers exist`, {
      code: 'duplicate_peer',
    })
  }
  if (requirePeer && peers.length !== 1) {
    throw new CutoverApiError(`Required '${peerId}' peer is missing`, {
      code: 'peer_missing',
    })
  }
  return {
    enabled: false,
    systemId: String(inventory.systemId ?? ''),
    routingMode: String(inventory.routingMode ?? ''),
    peerPresent: peers.length === 1,
  }
}

export async function enableFederation({
  request,
  peerId = 'codex',
  routingMode = 'advisory',
}) {
  if (!['strong', 'catalog-first', 'advisory'].includes(routingMode)) {
    throw new CutoverApiError('Invalid Federation routing mode', {
      code: 'invalid_routing_mode',
    })
  }
  await preflightFederation({ request, peerId, requirePeer: true })
  await request('/api/federation/routing-mode', {
    method: 'POST',
    body: { mode: routingMode },
  })
  await request('/api/federation/enabled', {
    method: 'POST',
    body: { enabled: true },
  })
  await request('/api/federation/apply', { method: 'POST', body: {} })
  const after = await request('/api/federation/peers')
  if (
    after?.enabled !== true
    || after?.routingMode !== routingMode
    || !after?.peers?.some((peer) => peer?.id === peerId)
  ) {
    throw new CutoverApiError('Federation activation did not persist', {
      code: 'activation_not_persisted',
    })
  }
  return { enabled: true, routingMode }
}

export async function disableFederation({ request }) {
  await request('/api/federation/enabled', {
    method: 'POST',
    body: { enabled: false },
  })
  try {
    await request('/api/federation/apply', { method: 'POST', body: {} })
  } catch {
    // The master switch is the safety boundary. A failed session restart is
    // reported by the caller's service health checks, but must not undo it.
  }
  const after = await request('/api/federation/peers')
  if (after?.enabled !== false) {
    throw new CutoverApiError('Federation disable did not persist', {
      code: 'disable_not_persisted',
    })
  }
  return { enabled: false }
}

export async function runFederationCanary({
  request,
  mainAgentId,
  peerId = 'codex',
  remoteAgentId = 'programozo',
  marker,
  pollIntervalMs = 1_000,
  timeoutMs = 180_000,
}) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(mainAgentId)) {
    throw new CutoverApiError('Invalid main agent id', { code: 'invalid_main_agent' })
  }
  if (!/^[A-Z0-9_]{8,120}$/.test(marker)) {
    throw new CutoverApiError('Invalid canary marker', { code: 'invalid_marker' })
  }
  const target = `${peerId}/${remoteAgentId}`
  const created = await request('/api/messages', {
    method: 'POST',
    body: {
      from: mainAgentId,
      to: target,
      content: `Éles Federation canary. Ne módosíts semmit. A teljes válaszod pontosan egy sor legyen: ${marker}`,
    },
  })
  if (!Number.isInteger(created?.id)) {
    throw new CutoverApiError('Canary message id is missing', {
      code: 'invalid_message_response',
    })
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const messages = await request(
      `/api/messages?agent=${encodeURIComponent(target)}&limit=200`,
    )
    if (!Array.isArray(messages)) {
      throw new CutoverApiError('Canary conversation has an invalid shape', {
        code: 'invalid_conversation',
      })
    }
    const original = messages.filter((message) => message?.id === created.id)
    const replies = messages.filter((message) => (
      message?.from_agent === target
      && message?.to_agent === mainAgentId
      && String(message?.content ?? '').trim() === marker
    ))
    if (original.length === 1 && original[0]?.status === 'failed') {
      throw new CutoverApiError('Canary delivery failed', {
        code: 'canary_failed',
      })
    }
    if (
      original.length === 1
      && original[0]?.status === 'delivered'
      && replies.length === 1
    ) {
      return { messageId: created.id, replyId: replies[0].id, marker }
    }
    if (replies.length > 1) {
      throw new CutoverApiError('Canary produced duplicate replies', {
        code: 'duplicate_canary_reply',
      })
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new CutoverApiError('Federation canary timed out', {
    code: 'canary_timeout',
  })
}
