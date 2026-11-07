import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { loadServiceConfig } from './config.mjs'
import { effortsForModel, isValidModelEffort } from './model-policy.mjs'

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
const MAX_INSTRUCTIONS_BYTES = 100 * 1024
const MAX_ACTOR_LENGTH = 80
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

function fail(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function ensurePrivateRegularFile(path, label) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw fail('unsafe_path', `${label} must be a regular file`, 500)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw fail('unsafe_permissions', `${label} must be private`, 500)
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail('unsafe_owner', `${label} must be owned by the service user`, 500)
  }
  return stat
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    throw fail('unsafe_path', 'settings backup path must be a real directory', 500)
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700)
}

function atomicPrivateWrite(path, bytes) {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    const directoryDescriptor = openSync(directory, 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function validatedActor(value) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.trim().length > MAX_ACTOR_LENGTH
    || /[\r\n\0]/.test(value)
  ) {
    throw fail('invalid_actor', 'actor must be a non-empty single-line name')
  }
  return value.trim()
}

function validatedInstructions(value) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || Buffer.byteLength(value) > MAX_INSTRUCTIONS_BYTES
    || value.includes('\0')
  ) {
    throw fail('invalid_developer_instructions', 'developerInstructions must not be empty')
  }
  return value
}

function validatedEffort(value) {
  if (!EFFORTS.has(value)) {
    throw fail('invalid_reasoning_effort', 'reasoningEffort must be none, low, medium, high, xhigh or max')
  }
  return value
}

function validatedModel(value) {
  if (typeof value !== 'string' || !MODEL_NAME.test(value)) {
    throw fail('invalid_model', 'model is invalid')
  }
  return value
}

function auditChanges(beforeAgent, afterAgent) {
  return {
    model: {
      before: beforeAgent.model,
      after: afterAgent.model,
    },
    developerInstructions: {
      beforeSha256: sha256(beforeAgent.developerInstructions),
      afterSha256: sha256(afterAgent.developerInstructions),
      beforeBytes: Buffer.byteLength(beforeAgent.developerInstructions),
      afterBytes: Buffer.byteLength(afterAgent.developerInstructions),
    },
    reasoningEffort: {
      before: beforeAgent.reasoningEffort,
      after: afterAgent.reasoningEffort,
    },
  }
}

function parseRoot(bytes) {
  let value
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw fail('invalid_config', 'configuration is not valid JSON', 500)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('invalid_config', 'configuration root is invalid', 500)
  }
  return value
}

export class AgentSettingsManager {
  constructor({ configPath, config, runtime, clock = Date.now }) {
    this.configPath = resolve(configPath)
    this.config = config
    this.runtime = runtime
    this.clock = clock
    this.directory = join(dirname(this.configPath), 'agent-settings-history')
    this.auditPath = join(this.directory, 'audit.jsonl')
    this.operation = null
    this.lastTimestampMs = 0
    ensurePrivateRegularFile(this.configPath, 'config file')
    ensurePrivateDirectory(this.directory)
  }

  current() {
    if (this.config.agents.length !== 1) {
      throw fail('single_agent_required', '0.3.4.1 settings require exactly one agent', 409)
    }
    const agent = this.config.agents[0]
    return {
      agentId: agent.id,
      displayName: agent.displayName,
      model: agent.model,
      selectableModels: this.runtime.selectableModels(),
      developerInstructions: agent.developerInstructions,
      reasoningEffort: agent.reasoningEffort,
      effortsByModel: Object.fromEntries(this.runtime.selectableModels().map((model) => [model, effortsForModel(model)])),
      canRestore: this.backups().length > 0,
    }
  }

  backups() {
    return readdirSync(this.directory)
      .filter((name) => /^config-\d+-[0-9a-f-]+\.json$/.test(name))
      .sort()
      .reverse()
  }

  audit(limit = 100) {
    if (!existsSync(this.auditPath)) return []
    ensurePrivateRegularFile(this.auditPath, 'audit log')
    return readFileSync(this.auditPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 500)))
      .reverse()
      .map((line) => JSON.parse(line))
  }

  appendAudit(record) {
    if (existsSync(this.auditPath)) ensurePrivateRegularFile(this.auditPath, 'audit log')
    const descriptor = openSync(this.auditPath, 'a', 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(this.auditPath, 0o600)
  }

  async exclusive(operation) {
    if (this.operation) throw fail('settings_busy', 'another settings change is running', 409)
    const pending = Promise.resolve().then(operation)
    this.operation = pending
    try {
      return await pending
    } finally {
      if (this.operation === pending) this.operation = null
    }
  }

  async update(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw fail('invalid_request', 'request body must be an object')
    }
    if (payload.confirm !== true) {
      throw fail('confirmation_required', 'confirm must be true', 409)
    }
    const actor = validatedActor(payload.actor)
    const model = validatedModel(payload.model)
    const developerInstructions = validatedInstructions(payload.developerInstructions)
    const reasoningEffort = validatedEffort(payload.reasoningEffort)
    if (!isValidModelEffort(model, reasoningEffort)) {
      throw fail('unsupported_model_effort', `reasoningEffort ${reasoningEffort} is unsupported for model ${model}`)
    }
    const current = this.current()
    if (
      current.model === model
      && current.developerInstructions === developerInstructions
      && current.reasoningEffort === reasoningEffort
    ) {
      throw fail('no_change', 'settings are unchanged', 409)
    }
    return this.exclusive(() => {
      this.runtime.assertModelSelectable(model)
      return this.apply({
        actor,
        action: 'update',
        transform(root) {
          if (!Array.isArray(root.agents) || root.agents.length !== 1) {
            throw fail('single_agent_required', '0.3.4.1 settings require exactly one agent', 409)
          }
          root.agents[0].model = model
          root.agents[0].developerInstructions = developerInstructions
          root.agents[0].reasoningEffort = reasoningEffort
          return root
        },
      })
    })
  }

  async restore(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw fail('invalid_request', 'request body must be an object')
    }
    if (payload.confirm !== true) {
      throw fail('confirmation_required', 'confirm must be true', 409)
    }
    const actor = validatedActor(payload.actor)
    return this.exclusive(async () => {
      const [backupName] = this.backups()
      if (!backupName) throw fail('backup_not_found', 'no previous settings are available', 404)
      const backupPath = join(this.directory, backupName)
      ensurePrivateRegularFile(backupPath, 'settings backup')
      const backup = readFileSync(backupPath)
      const root = parseRoot(backup)
      if (!Array.isArray(root.agents) || root.agents.length !== 1) {
        throw fail('invalid_backup', 'settings backup does not contain exactly one agent', 409)
      }
      const model = validatedModel(root.agents[0].model)
      validatedInstructions(root.agents[0].developerInstructions)
      const effort = root.agents[0].reasoningEffort
      if (!isValidModelEffort(model, effort, { existingConfig: true })) {
        throw fail('unsupported_model_effort', 'backup reasoningEffort is unsupported for this model')
      }
      this.runtime.assertModelSelectable(model)
      return this.apply({ actor, action: 'restore', root, sourceBackup: backupName })
    })
  }

  async apply({ actor, action, transform = null, root = null, sourceBackup = null }) {
    ensurePrivateRegularFile(this.configPath, 'config file')
    const beforeBytes = readFileSync(this.configPath)
    const beforeRoot = parseRoot(beforeBytes)
    const beforeAgent = this.config.agents[0]
    const nextRoot = root ?? transform(structuredClone(beforeRoot))
    const afterBytes = Buffer.from(`${JSON.stringify(nextRoot, null, 2)}\n`)
    if (afterBytes.equals(beforeBytes)) throw fail('no_change', 'settings are unchanged', 409)

    const timestampMs = Math.max(this.clock(), this.lastTimestampMs + 1)
    this.lastTimestampMs = timestampMs
    const backupName = `config-${String(timestampMs).padStart(16, '0')}-${randomUUID()}.json`
    const backupPath = join(this.directory, backupName)
    atomicPrivateWrite(backupPath, beforeBytes)
    atomicPrivateWrite(this.configPath, afterBytes)

    let nextConfig
    try {
      nextConfig = loadServiceConfig(this.configPath)
      if (nextConfig.agents.length !== 1 || nextConfig.agents[0].id !== beforeAgent.id) {
        throw fail('agent_identity_change_forbidden', 'agent identity cannot change in 0.3.4.1', 409)
      }
      await this.runtime.reconfigureAgent(nextConfig.agents[0])
      this.config.agents = nextConfig.agents
    } catch (error) {
      atomicPrivateWrite(this.configPath, beforeBytes)
      try { unlinkSync(backupPath) } catch {}
      this.appendAudit({
        timestamp: new Date(timestampMs).toISOString(),
        timestampMs,
        actor,
        authenticatedAs: 'admin-token',
        action,
        outcome: 'failed_rolled_back',
        agentId: beforeAgent.id,
        errorCode: error?.code ?? 'runtime_restart_failed',
        ...(error?.rollbackError?.code
          ? { rollbackErrorCode: error.rollbackError.code }
          : {}),
        ...(nextConfig?.agents?.[0]
          ? { changes: auditChanges(beforeAgent, nextConfig.agents[0]) }
          : {}),
        rollbackRuntimeReady: typeof this.runtime.isReady === 'function'
          ? this.runtime.isReady()
          : null,
      })
      throw error
    }

    const afterAgent = nextConfig.agents[0]
    const record = {
      timestamp: new Date(timestampMs).toISOString(),
      timestampMs,
      actor,
      authenticatedAs: 'admin-token',
      action,
      outcome: 'succeeded',
      agentId: beforeAgent.id,
      changes: auditChanges(beforeAgent, afterAgent),
      backup: backupName,
      ...(sourceBackup ? { sourceBackup } : {}),
    }
    this.appendAudit(record)
    return { settings: this.current(), audit: record }
  }
}

export const AGENT_SETTINGS_EFFORTS = Object.freeze([...EFFORTS])
