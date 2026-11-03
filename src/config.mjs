import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { isValidSegment } from './federation-contract.mjs'
import { requiredPeerConfiguration } from './peer-config.mjs'
import { BRIDGE_ALLOWED_MODELS, isValidModelEffort } from './model-policy.mjs'

const MAX_CONFIG_BYTES = 128 * 1024
const MIN_TOKEN_LENGTH = 32
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write'])
const APPROVAL_POLICIES = new Set(['never', 'manual'])
const REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const DEFAULT_ALLOWED_MODELS = BRIDGE_ALLOWED_MODELS
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function privateRegularFile(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions must not grant group/other access`)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the service user`)
  }
}

function resolveFile(configPath, value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return isAbsolute(value) ? resolve(value) : resolve(dirname(configPath), value)
}

function readToken(path, label) {
  privateRegularFile(path, label)
  const token = readFileSync(path, 'utf8').trim()
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`${label} must contain at least ${MIN_TOKEN_LENGTH} characters`)
  }
  if (/[\r\n]/.test(token)) throw new Error(`${label} must contain exactly one line`)
  return token
}

function integer(value, fallback, { min, max }, label) {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < min || selected > max) {
    throw new Error(`${label} must be between ${min} and ${max}`)
  }
  return selected
}

function boolean(value, fallback, label) {
  const selected = value ?? fallback
  if (typeof selected !== 'boolean') throw new Error(`${label} must be a boolean`)
  return selected
}

function boundedNonEmptyString(value, fallback, max, label) {
  const selected = value ?? fallback
  if (
    typeof selected !== 'string'
    || selected.length === 0
    || selected.length > max
  ) {
    throw new Error(`${label} is invalid`)
  }
  return selected
}

function modelAllowlist(value) {
  const selected = value ?? DEFAULT_ALLOWED_MODELS
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 20) {
    throw new Error('codex.allowedModels must contain between 1 and 20 models')
  }
  const models = selected.map((model) => {
    if (typeof model !== 'string' || !MODEL_NAME.test(model)) {
      throw new Error('codex.allowedModels contains an invalid model name')
    }
    return model
  })
  if (new Set(models).size !== models.length) {
    throw new Error('codex.allowedModels must not contain duplicates')
  }
  return models
}

function absoluteExistingDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute directory`)
  }
  const path = resolve(value)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`${label} must be a real directory without symbolic-link traversal`)
  }
  return path
}

function executable(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute executable path`)
  }
  const path = realpathSync(resolve(value))
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`${label} must resolve to an executable regular file`)
  }
  return path
}

export function loadServiceConfig(path) {
  const configPath = resolve(path)
  privateRegularFile(configPath, 'config file')
  const raw = readFileSync(configPath)
  if (raw.length > MAX_CONFIG_BYTES) throw new Error('config file is too large')
  let input
  try {
    input = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('config file is not valid JSON')
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config root must be an object')
  }
  if (input.version !== 1) throw new Error('unsupported config version')
  if (!isValidSegment(input.systemId)) throw new Error('systemId is invalid')
  if (!input.listen || !LOOPBACK.has(input.listen.host)) {
    throw new Error('listen.host must be loopback')
  }
  const port = integer(input.listen.port, 0, { min: 0, max: 65535 }, 'listen.port')
  const database = resolveFile(configPath, input.storage?.database, 'storage.database')
  if (!input.codex || typeof input.codex !== 'object') {
    throw new Error('codex configuration is required')
  }
  const codexBinary = executable(input.codex.binary, 'codex.binary')
  if (
    typeof input.codex.expectedVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(input.codex.expectedVersion)
  ) {
    throw new Error('codex.expectedVersion must be an exact semantic version')
  }
  const runtimeRoot = absoluteExistingDirectory(input.codex.runtimeRoot, 'codex.runtimeRoot')
  const allowedModels = modelAllowlist(input.codex.allowedModels)
  const adminTokenFile = resolveFile(configPath, input.admin?.tokenFile, 'admin.tokenFile')
  const adminToken = readToken(adminTokenFile, 'admin token file')
  if (!Array.isArray(input.agents) || input.agents.length === 0 || input.agents.length > 100) {
    throw new Error('agents must contain between 1 and 100 entries')
  }
  const agentIds = new Set()
  const agents = input.agents.map((agent) => {
    if (!agent || typeof agent !== 'object' || !isValidSegment(agent.id)) {
      throw new Error('agent id is invalid')
    }
    if (agentIds.has(agent.id)) throw new Error(`duplicate agent '${agent.id}'`)
    agentIds.add(agent.id)
    if (typeof agent.displayName !== 'string' || agent.displayName.length > 120) {
      throw new Error(`agent '${agent.id}' displayName is invalid`)
    }
    if (typeof agent.model !== 'string' || !MODEL_NAME.test(agent.model)) {
      throw new Error(`agent '${agent.id}' model is invalid`)
    }
    if (!allowedModels.includes(agent.model)) {
      throw new Error(`agent '${agent.id}' model is not present in codex.allowedModels`)
    }
    const workspacePath = absoluteExistingDirectory(
      agent.workspacePath,
      `agent '${agent.id}' workspacePath`,
    )
    const sandboxMode = agent.sandboxMode ?? 'read-only'
    if (!SANDBOX_MODES.has(sandboxMode)) {
      throw new Error(`agent '${agent.id}' sandboxMode is invalid`)
    }
    const approvalPolicy = agent.approvalPolicy ?? 'never'
    if (!APPROVAL_POLICIES.has(approvalPolicy)) {
      throw new Error(`agent '${agent.id}' approvalPolicy is invalid`)
    }
    const reasoningEffort = agent.reasoningEffort ?? 'high'
    if (!REASONING_EFFORTS.has(reasoningEffort) && reasoningEffort !== 'none') {
      throw new Error(`agent '${agent.id}' reasoningEffort is invalid`)
    }
    if (!isValidModelEffort(agent.model, reasoningEffort, { existingConfig: true })) {
      throw new Error(`agent '${agent.id}' reasoningEffort is unsupported for model '${agent.model}'`)
    }
    if (
      agent.developerInstructions !== undefined
      && (
        typeof agent.developerInstructions !== 'string'
        || Buffer.byteLength(agent.developerInstructions) > 100 * 1024
      )
    ) {
      throw new Error(`agent '${agent.id}' developerInstructions is invalid`)
    }
    return {
      id: agent.id,
      displayName: agent.displayName || agent.id,
      model: agent.model,
      workspacePath,
      sandboxMode,
      approvalPolicy,
      federationPeer: agent.federationPeer,
      reasoningEffort,
      networkEnabled: agent.networkEnabled === true,
      developerInstructions: agent.developerInstructions ?? '',
      capabilitySummary: typeof agent.capabilitySummary === 'string'
        ? agent.capabilitySummary.slice(0, 600)
        : undefined,
    }
  })
  if (!Array.isArray(input.peers) || input.peers.length === 0) {
    throw new Error('at least one Federation peer is required')
  }
  const peerIds = new Set()
  const tokenSet = new Set([adminToken])
  const peers = input.peers.map((peer) => {
    if (!peer || typeof peer !== 'object' || !isValidSegment(peer.id)) {
      throw new Error('peer id is invalid')
    }
    const id = peer.id.toLowerCase()
    if (id === input.systemId.toLowerCase()) throw new Error('peer id equals systemId')
    if (peerIds.has(id)) throw new Error(`duplicate peer '${id}'`)
    peerIds.add(id)
    const inboundTokenFile = resolveFile(
      configPath,
      peer.inboundTokenFile,
      `peer '${id}' inboundTokenFile`,
    )
    const outboundTokenFile = resolveFile(
      configPath,
      peer.outboundTokenFile,
      `peer '${id}' outboundTokenFile`,
    )
    const inboundToken = readToken(inboundTokenFile, `peer '${id}' inbound token file`)
    const outboundToken = readToken(outboundTokenFile, `peer '${id}' outbound token file`)
    for (const token of [inboundToken, outboundToken]) {
      if (tokenSet.has(token)) throw new Error('admin and Federation tokens must all be distinct')
      tokenSet.add(token)
    }
    const validated = requiredPeerConfiguration({
      id,
      baseUrl: peer.baseUrl,
      outboundToken,
    }, id)
    return {
      id,
      baseUrl: validated.baseUrl,
      inboundToken,
      outboundToken,
    }
  })
  const effectiveAgents = agents.map((agent) => {
    const federationPeer = agent.federationPeer ?? (peers.length === 1 ? peers[0].id : null)
    if (
      typeof federationPeer !== 'string'
      || !peers.some((peer) => peer.id === federationPeer.toLowerCase())
    ) {
      throw new Error(
        `agent '${agent.id}' federationPeer must identify a configured peer`,
      )
    }
    return { ...agent, federationPeer: federationPeer.toLowerCase() }
  })

  return {
    version: 1,
    systemId: input.systemId,
    listen: { host: input.listen.host, port },
    storage: { database },
    codex: {
      binary: codexBinary,
      expectedVersion: input.codex.expectedVersion,
      runtimeRoot,
      allowedModels,
      startupTimeoutMs: integer(
        input.codex.startupTimeoutMs,
        60_000,
        { min: 1_000, max: 300_000 },
        'codex.startupTimeoutMs',
      ),
      requestTimeoutMs: integer(
        input.codex.requestTimeoutMs,
        60_000,
        { min: 1_000, max: 600_000 },
        'codex.requestTimeoutMs',
      ),
      turnTimeoutMs: integer(
        input.codex.turnTimeoutMs,
        900_000,
        { min: 10_000, max: 3_600_000 },
        'codex.turnTimeoutMs',
      ),
      approvalTimeoutMs: integer(
        input.codex.approvalTimeoutMs,
        300_000,
        { min: 1_000, max: 3_600_000 },
        'codex.approvalTimeoutMs',
      ),
      imageGenerationRequired: boolean(
        input.codex.imageGenerationRequired,
        true,
        'codex.imageGenerationRequired',
      ),
      imageModel: boundedNonEmptyString(
        input.codex.imageModel,
        'gpt-image-2',
        120,
        'codex.imageModel',
      ),
      artifactMaxBytes: integer(
        input.codex.artifactMaxBytes,
        20 * 1024 * 1024,
        { min: 1024, max: 50 * 1024 * 1024 },
        'codex.artifactMaxBytes',
      ),
      imageMaxPixels: integer(
        input.codex.imageMaxPixels,
        16_777_216,
        { min: 1, max: 100_000_000 },
        'codex.imageMaxPixels',
      ),
    },
    admin: { tokenFile: adminTokenFile, token: adminToken },
    agents: effectiveAgents,
    peers,
    workers: {
      intervalMs: integer(
        input.workers?.intervalMs,
        250,
        { min: 50, max: 60_000 },
        'workers.intervalMs',
      ),
      runtimeLeaseMs: integer(
        input.workers?.runtimeLeaseMs,
        1_800_000,
        { min: 1_000, max: 3_600_000 },
        'workers.runtimeLeaseMs',
      ),
      runtimeMaxAttempts: integer(
        input.workers?.runtimeMaxAttempts,
        3,
        { min: 1, max: 20 },
        'workers.runtimeMaxAttempts',
      ),
      deliveryTimeoutMs: integer(
        input.workers?.deliveryTimeoutMs,
        5_000,
        { min: 100, max: 120_000 },
        'workers.deliveryTimeoutMs',
      ),
      deliveryLeaseMs: integer(
        input.workers?.deliveryLeaseMs,
        30_000,
        { min: 1_000, max: 3_600_000 },
        'workers.deliveryLeaseMs',
      ),
      deliveryMaxAttempts: integer(
        input.workers?.deliveryMaxAttempts,
        8,
        { min: 1, max: 50 },
        'workers.deliveryMaxAttempts',
      ),
    },
  }
}

export function publicConfig(config) {
  return {
    version: config.version,
    systemId: config.systemId,
    listen: config.listen,
    storage: { configured: true },
    codex: {
      expectedVersion: config.codex.expectedVersion,
      allowedModels: config.codex.allowedModels,
      runtimeRootConfigured: true,
      startupTimeoutMs: config.codex.startupTimeoutMs,
      requestTimeoutMs: config.codex.requestTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      approvalTimeoutMs: config.codex.approvalTimeoutMs,
      imageGenerationRequired: config.codex.imageGenerationRequired,
      imageModel: config.codex.imageModel,
      artifactMaxBytes: config.codex.artifactMaxBytes,
      imageMaxPixels: config.codex.imageMaxPixels,
    },
    agents: config.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      model: agent.model,
      capabilitySummary: agent.capabilitySummary,
      sandboxMode: agent.sandboxMode,
      approvalPolicy: agent.approvalPolicy,
      reasoningEffort: agent.reasoningEffort,
      networkEnabled: agent.networkEnabled,
      federationPeer: agent.federationPeer,
      workspaceConfigured: true,
    })),
    peers: config.peers.map((peer) => ({
      id: peer.id,
      baseUrl: peer.baseUrl.toString(),
      hasInboundToken: true,
      hasOutboundToken: true,
    })),
    workers: config.workers,
  }
}
