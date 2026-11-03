import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const MAX_CONFIG_BYTES = 1024 * 1024
const ID_RX = /^[a-z0-9][a-z0-9_-]{0,63}$/

export class BridgePeerReconciliationError extends Error {
  constructor(message, code = 'bridge_peer_reconciliation_error') {
    super(message)
    this.name = 'BridgePeerReconciliationError'
    this.code = code
  }
}

function readPrivateConfig(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    throw new BridgePeerReconciliationError(
      'Bridge configuration is missing',
      'config_missing',
    )
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BridgePeerReconciliationError(
      'Bridge configuration must be a regular non-symlink file',
      'unsafe_config_file',
    )
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new BridgePeerReconciliationError(
      'Bridge configuration permissions must be 0600 or stricter',
      'unsafe_config_mode',
    )
  }
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new BridgePeerReconciliationError(
      'Bridge configuration is too large',
      'config_too_large',
    )
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new BridgePeerReconciliationError(
      'Bridge configuration is not valid JSON',
      'invalid_config_json',
    )
  }
}

function atomicPrivateWrite(path, content) {
  const temp = `${path}.peer-reconcile-${process.pid}`
  let fd
  try {
    fd = openSync(temp, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(temp, 0o600)
    renameSync(temp, path)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { unlinkSync(temp) } catch {}
  }
}

export function marveenSystemIdFromPairingResult(pairing) {
  const candidates = [
    pairing?.marveenSystemId,
    pairing?.state?.marveenSystemId,
    pairing?.plan?.marveenSystemId,
  ].filter((value) => value !== undefined)
  if (candidates.length === 0) {
    throw new Error('Pairing result is missing the Marveen system id')
  }
  const normalized = candidates.map((value) => String(value).toLowerCase())
  if (normalized.some((value) => value !== normalized[0])) {
    throw new Error('Pairing result contains conflicting Marveen system ids')
  }
  return candidates[0]
}

export function reconcileBridgePeerIdentity({
  configPath,
  marveenSystemId,
  expectedBridgeSystemId = 'codex',
  execute = false,
}) {
  const desiredPeerId = String(marveenSystemId ?? '').toLowerCase()
  if (!ID_RX.test(desiredPeerId)) {
    throw new BridgePeerReconciliationError(
      'Marveen systemId is invalid',
      'invalid_marveen_system_id',
    )
  }
  const expectedOwnId = String(expectedBridgeSystemId ?? '').toLowerCase()
  if (!ID_RX.test(expectedOwnId)) {
    throw new BridgePeerReconciliationError(
      'Expected Bridge systemId is invalid',
      'invalid_expected_bridge_system_id',
    )
  }
  if (desiredPeerId === expectedOwnId) {
    throw new BridgePeerReconciliationError(
      'Marveen systemId collides with the Bridge systemId',
      'system_id_collision',
    )
  }

  const config = readPrivateConfig(configPath)
  if (
    config === null
    || typeof config !== 'object'
    || Array.isArray(config)
    || config.version !== 1
  ) {
    throw new BridgePeerReconciliationError(
      'Bridge configuration root is invalid',
      'invalid_config',
    )
  }
  const ownId = String(config.systemId ?? '').toLowerCase()
  if (ownId !== expectedOwnId) {
    throw new BridgePeerReconciliationError(
      'Bridge systemId does not match the expected identity',
      'bridge_system_id_mismatch',
    )
  }
  if (!Array.isArray(config.peers) || config.peers.length !== 1) {
    throw new BridgePeerReconciliationError(
      'Exactly one Bridge Federation peer is required for cutover',
      'peer_inventory_mismatch',
    )
  }
  if (!Array.isArray(config.agents) || config.agents.length === 0) {
    throw new BridgePeerReconciliationError(
      'At least one Bridge agent is required',
      'agent_inventory_mismatch',
    )
  }

  const peer = config.peers[0]
  if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) {
    throw new BridgePeerReconciliationError(
      'Bridge peer configuration is invalid',
      'invalid_peer',
    )
  }
  const previousPeerId = String(peer.id ?? '').toLowerCase()
  if (!ID_RX.test(previousPeerId)) {
    throw new BridgePeerReconciliationError(
      'Existing Bridge peer id is invalid',
      'invalid_existing_peer_id',
    )
  }
  for (const agent of config.agents) {
    if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
      throw new BridgePeerReconciliationError(
        'Bridge agent configuration is invalid',
        'invalid_agent',
      )
    }
    if (String(agent.federationPeer ?? '').toLowerCase() !== previousPeerId) {
      throw new BridgePeerReconciliationError(
        'Bridge agent does not reference the sole configured peer',
        'agent_peer_mismatch',
      )
    }
  }

  const changed = previousPeerId !== desiredPeerId
  if (changed && execute) {
    peer.id = desiredPeerId
    for (const agent of config.agents) agent.federationPeer = desiredPeerId
    atomicPrivateWrite(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }

  return {
    changed,
    executed: execute,
    bridgeSystemId: ownId,
    previousPeerId,
    marveenSystemId: desiredPeerId,
    configDirectory: dirname(configPath),
  }
}
