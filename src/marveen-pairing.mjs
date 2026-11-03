import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const TOKEN_MIN_LENGTH = 32

export class PairingError extends Error {
  constructor(message, { code = 'pairing_error', status = null } = {}) {
    super(message)
    this.name = 'PairingError'
    this.code = code
    this.status = status
  }
}

export function assertLoopbackOrigin(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new PairingError('Marveen origin is not a valid URL', { code: 'invalid_origin' })
  }
  if (url.protocol !== 'http:') {
    throw new PairingError('Local Marveen pairing requires an http loopback origin', { code: 'invalid_origin' })
  }
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new PairingError('Marveen pairing is restricted to a loopback origin', { code: 'invalid_origin' })
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PairingError('Marveen origin must not contain credentials, query or fragment', { code: 'invalid_origin' })
  }
  return url.toString().replace(/\/+$/, '')
}

export function readPrivateToken(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new PairingError(`${label} file is missing`, { code: 'token_missing' })
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new PairingError(`${label} must be a regular non-symlink file`, { code: 'unsafe_token_file' })
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new PairingError(`${label} permissions must be 0600 or stricter`, { code: 'unsafe_token_mode' })
  }
  const token = readFileSync(path, 'utf8').trim()
  if (token.length < TOKEN_MIN_LENGTH || /[\r\n]/.test(token)) {
    throw new PairingError(`${label} is invalid`, { code: 'invalid_token' })
  }
  return token
}

async function responseJson(response, label) {
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    throw new PairingError(`${label} response is too large`, {
      code: 'response_too_large',
      status: response.status,
    })
  }
  let body
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new PairingError(`${label} returned non-JSON`, {
      code: 'invalid_response',
      status: response.status,
    })
  }
  if (!response.ok) {
    throw new PairingError(`${label} failed with HTTP ${response.status}`, {
      code: 'marveen_http_error',
      status: response.status,
    })
  }
  return body
}

async function marveenRequest(fetchImpl, origin, dashboardToken, path, init = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${dashboardToken}`,
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    ...(init.headers ?? {}),
  }
  let response
  try {
    response = await fetchImpl(`${origin}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new PairingError('Marveen dashboard API is unreachable', { code: 'marveen_unreachable' })
  }
  return responseJson(response, path)
}

function atomicPrivateWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.phase62-${process.pid}`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temp) } catch {}
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readPairingState(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new PairingError(
      'Existing Marveen peer has no private pairing state; explicit reconciliation is required',
      { code: 'pairing_state_missing' },
    )
  }
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new PairingError('Private pairing state is unsafe', {
      code: 'unsafe_pairing_state',
    })
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new PairingError('Private pairing state is invalid', {
      code: 'invalid_pairing_state',
    })
  }
}

function assertExistingPairMatches({
  peer,
  state,
  peerId,
  origin,
  bridgeOrigin,
  marveenSystemId,
  bridgeInboundToken,
  bridgeOutboundToken,
}) {
  const valid = (
    state?.version === 1
    && state?.peerCreatedByPhase62 === true
    && state?.peerId === peerId
    && state?.marveenOrigin === origin
    && state?.bridgeOrigin === bridgeOrigin
    && state?.marveenSystemId === marveenSystemId
    && state?.bridgeInboundTokenSha256 === digest(bridgeInboundToken)
    && state?.bridgeOutboundTokenSha256 === digest(bridgeOutboundToken)
    && peer?.id === peerId
    && peer?.baseUrl === bridgeOrigin
    && peer?.hasInboundToken === true
    && peer?.hasOutboundToken === true
  )
  if (!valid) {
    throw new PairingError(
      `Existing Marveen peer '${peerId}' does not match the private pairing state`,
      { code: 'pairing_state_mismatch' },
    )
  }
}

export async function stageMarveenPairing({
  marveenOrigin,
  dashboardTokenFile,
  bridgeInboundTokenFile,
  bridgeOutboundTokenFile,
  stateFile,
  peerId = 'codex',
  bridgeOrigin = 'http://127.0.0.1:3431',
  execute = false,
  fetchImpl = fetch,
}) {
  const origin = assertLoopbackOrigin(marveenOrigin)
  const normalizedBridgeOrigin = assertLoopbackOrigin(bridgeOrigin)
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(peerId)) {
    throw new PairingError('Peer id is invalid', { code: 'invalid_peer_id' })
  }
  const dashboardToken = readPrivateToken(dashboardTokenFile, 'Marveen dashboard token')
  const bridgeInboundToken = readPrivateToken(bridgeInboundTokenFile, 'Bridge inbound token')

  const current = await marveenRequest(
    fetchImpl,
    origin,
    dashboardToken,
    '/api/federation/peers',
  )
  if (!current || typeof current !== 'object' || !Array.isArray(current.peers)) {
    throw new PairingError('Marveen peer inventory has an invalid shape', { code: 'invalid_peer_inventory' })
  }
  if (current.enabled === true) {
    throw new PairingError(
      'Marveen Federation is already enabled; refusing a live peer mutation',
      { code: 'federation_already_enabled' },
    )
  }
  const matchingPeers = current.peers.filter((peer) => peer?.id === peerId)
  if (matchingPeers.length > 1) {
    throw new PairingError(`Duplicate Marveen peers exist for '${peerId}'`, {
      code: 'duplicate_peer',
    })
  }

  const plan = {
    peerId,
    marveenOrigin: origin,
    bridgeOrigin: normalizedBridgeOrigin,
    marveenSystemId: String(current.systemId ?? ''),
    existingPeerCount: current.peers.length,
    execute,
  }
  if (matchingPeers.length === 1) {
    const state = readPairingState(stateFile)
    const bridgeOutboundToken = readPrivateToken(
      bridgeOutboundTokenFile,
      'Bridge outbound token',
    )
    assertExistingPairMatches({
      peer: matchingPeers[0],
      state,
      peerId,
      origin,
      bridgeOrigin: normalizedBridgeOrigin,
      marveenSystemId: String(current.systemId ?? ''),
      bridgeInboundToken,
      bridgeOutboundToken,
    })
    return {
      status: execute ? 'already-paired-disabled' : 'reconciled-preflight',
      plan,
      state,
      createdNow: false,
    }
  }
  if (!execute) return { status: 'preflight', plan }

  let peerCreated = false
  try {
    const created = await marveenRequest(
      fetchImpl,
      origin,
      dashboardToken,
      '/api/federation/peers',
      {
        method: 'POST',
        body: JSON.stringify({
          id: peerId,
          baseUrl: normalizedBridgeOrigin,
          outboundToken: bridgeInboundToken,
          trust: 'untrusted',
          shareCapabilitySummaries: true,
          abandonWindowMinutes: 1440,
        }),
      },
    )
    peerCreated = true
    const inboundToken = created?.inboundToken
    if (typeof inboundToken !== 'string' || inboundToken.length < TOKEN_MIN_LENGTH || /[\r\n]/.test(inboundToken)) {
      throw new PairingError('Marveen did not return a valid peer inbound token', {
        code: 'invalid_created_token',
      })
    }
    atomicPrivateWrite(bridgeOutboundTokenFile, `${inboundToken}\n`)
    const stored = readPrivateToken(bridgeOutboundTokenFile, 'Bridge outbound token')
    if (stored !== inboundToken) {
      throw new PairingError('Bridge outbound token verification failed', { code: 'token_write_failed' })
    }

    const after = await marveenRequest(
      fetchImpl,
      origin,
      dashboardToken,
      '/api/federation/peers',
    )
    const peer = after?.peers?.find((item) => item?.id === peerId)
    if (!peer || peer.hasInboundToken !== true || peer.hasOutboundToken !== true) {
      throw new PairingError('Marveen did not persist the complete peer pairing', {
        code: 'pairing_not_persisted',
      })
    }
    if (after.enabled === true) {
      throw new PairingError('Pairing unexpectedly enabled Marveen Federation', {
        code: 'unexpected_enable',
      })
    }

    const state = {
      version: 1,
      phase: '0.3.0-phase6.3',
      createdAt: new Date().toISOString(),
      peerId,
      marveenOrigin: origin,
      bridgeOrigin: normalizedBridgeOrigin,
      marveenSystemId: String(after.systemId ?? ''),
      peerCreatedByPhase62: true,
      bridgeInboundTokenSha256: digest(bridgeInboundToken),
      bridgeOutboundTokenSha256: digest(inboundToken),
      federationEnabled: false,
    }
    atomicPrivateWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`)
    return {
      status: 'paired-disabled',
      plan,
      state,
      createdNow: true,
    }
  } catch (error) {
    if (peerCreated) {
      try {
        await marveenRequest(
          fetchImpl,
          origin,
          dashboardToken,
          `/api/federation/peers/${encodeURIComponent(peerId)}`,
          { method: 'DELETE' },
        )
      } catch {
        throw new PairingError(
          'Pairing failed and automatic peer rollback also failed; Federation remains disabled',
          { code: 'rollback_failed' },
        )
      }
    }
    throw error
  }
}

export function summarizeMarveenPairing(result) {
  const peerId = result?.state?.peerId ?? result?.peerId ?? result?.plan?.peerId
  if (result?.status === 'pairing-rolled-back') {
    return {
      status: result.status,
      createdNow: false,
      peerId,
    }
  }
  const stateSystemId = result?.state?.marveenSystemId
  const planSystemId = result?.plan?.marveenSystemId
  if (
    stateSystemId !== undefined
    && planSystemId !== undefined
    && String(stateSystemId).toLowerCase() !== String(planSystemId).toLowerCase()
  ) {
    throw new PairingError('Pairing result contains conflicting Marveen system ids', {
      code: 'pairing_system_id_mismatch',
    })
  }
  const marveenSystemId = stateSystemId ?? planSystemId
  if (typeof marveenSystemId !== 'string' || marveenSystemId.length === 0) {
    throw new PairingError('Pairing result is missing the Marveen system id', {
      code: 'pairing_system_id_missing',
    })
  }
  return {
    status: result.status,
    createdNow: result.createdNow === true,
    peerId,
    marveenSystemId,
  }
}

export async function rollbackMarveenPairing({
  marveenOrigin,
  dashboardTokenFile,
  bridgeInboundTokenFile,
  bridgeOutboundTokenFile,
  stateFile,
  peerId = 'codex',
  bridgeOrigin = 'http://127.0.0.1:3431',
  fetchImpl = fetch,
}) {
  const origin = assertLoopbackOrigin(marveenOrigin)
  const normalizedBridgeOrigin = assertLoopbackOrigin(bridgeOrigin)
  const dashboardToken = readPrivateToken(
    dashboardTokenFile,
    'Marveen dashboard token',
  )
  const bridgeInboundToken = readPrivateToken(
    bridgeInboundTokenFile,
    'Bridge inbound token',
  )
  const bridgeOutboundToken = readPrivateToken(
    bridgeOutboundTokenFile,
    'Bridge outbound token',
  )
  const state = readPairingState(stateFile)
  const current = await marveenRequest(
    fetchImpl,
    origin,
    dashboardToken,
    '/api/federation/peers',
  )
  if (current?.enabled === true) {
    throw new PairingError('Federation must be disabled before pairing rollback', {
      code: 'federation_enabled',
    })
  }
  const matchingPeers = current?.peers?.filter((peer) => peer?.id === peerId)
  if (!Array.isArray(matchingPeers) || matchingPeers.length !== 1) {
    throw new PairingError('Pairing rollback requires exactly one matching peer', {
      code: 'peer_inventory_mismatch',
    })
  }
  assertExistingPairMatches({
    peer: matchingPeers[0],
    state,
    peerId,
    origin,
    bridgeOrigin: normalizedBridgeOrigin,
    marveenSystemId: String(current.systemId ?? ''),
    bridgeInboundToken,
    bridgeOutboundToken,
  })
  await marveenRequest(
    fetchImpl,
    origin,
    dashboardToken,
    `/api/federation/peers/${encodeURIComponent(peerId)}`,
    { method: 'DELETE' },
  )
  const after = await marveenRequest(
    fetchImpl,
    origin,
    dashboardToken,
    '/api/federation/peers',
  )
  if (after?.peers?.some((peer) => peer?.id === peerId)) {
    throw new PairingError('Marveen peer deletion did not persist', {
      code: 'peer_delete_not_persisted',
    })
  }
  unlinkSync(stateFile)
  return { status: 'pairing-rolled-back', peerId }
}
