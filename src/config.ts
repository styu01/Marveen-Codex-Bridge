import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface BridgeConfig {
  api: {
    unixSocket: string
    socketMode: number
    maxBodyBytes: number
  }
  codex: {
    binary: string
    expectedVersion: string
    model: string
    startupTimeoutMs: number
    requestTimeoutMs: number
    turnTimeoutMs: number
    restartBaseDelayMs: number
    restartMaxDelayMs: number
    maxRestartsInWindow: number
    restartWindowMs: number
  }
  storage: {
    database: string
    runtimeRoot: string
    lockFile: string
  }
  runs: {
    globalConcurrency: number
    perAgentConcurrency: number
    maxQueuedPerAgent: number
    eventRetentionDays: number
    maxPromptBytes: number
  }
  artifacts: {
    maxImageBytes: number
  }
  callbacks: {
    enabled: boolean
    baseUrl: string
    timeoutMs: number
    maxAttempts: number
    initialDelayMs: number
    maxDelayMs: number
  }
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error'
  }
  auth: {
    token: string
  }
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const MODULE_PARENT = resolve(HERE, '..')
const PROJECT_ROOT = basename(MODULE_PARENT) === 'dist'
  ? resolve(MODULE_PARENT, '..')
  : MODULE_PARENT
const DEFAULT_CONFIG_PATH = resolve(PROJECT_ROOT, 'config/default.json')

const SCHEMA = {
  api: ['unixSocket', 'socketMode', 'maxBodyBytes'],
  codex: [
    'binary',
    'expectedVersion',
    'model',
    'startupTimeoutMs',
    'requestTimeoutMs',
    'turnTimeoutMs',
    'restartBaseDelayMs',
    'restartMaxDelayMs',
    'maxRestartsInWindow',
    'restartWindowMs',
  ],
  storage: ['database', 'runtimeRoot', 'lockFile'],
  runs: [
    'globalConcurrency',
    'perAgentConcurrency',
    'maxQueuedPerAgent',
    'eventRetentionDays',
    'maxPromptBytes',
  ],
  artifacts: ['maxImageBytes'],
  callbacks: [
    'enabled',
    'baseUrl',
    'timeoutMs',
    'maxAttempts',
    'initialDelayMs',
    'maxDelayMs',
  ],
  logging: ['level'],
} as const

function parseJsonFile(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('top-level configuration must be an object')
    }
    return value as Record<string, unknown>
  } catch (error) {
    throw new Error(`Cannot read Bridge config ${path}: ${(error as Error).message}`)
  }
}

function assertKnownKeys(value: Record<string, unknown>, source: string): void {
  const allowedSections = new Set(Object.keys(SCHEMA))
  for (const key of Object.keys(value)) {
    if (!allowedSections.has(key)) throw new Error(`Unknown config key: ${source}.${key}`)
  }
  for (const [section, keys] of Object.entries(SCHEMA)) {
    const raw = value[section]
    if (raw === undefined) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Config section must be an object: ${source}.${section}`)
    }
    const allowed = new Set<string>(keys)
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) throw new Error(`Unknown config key: ${source}.${section}.${key}`)
    }
  }
}

function mergeConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(base)
  for (const [section, value] of Object.entries(override)) {
    result[section] = {
      ...((result[section] as Record<string, unknown> | undefined) ?? {}),
      ...(value as Record<string, unknown>),
    }
  }
  return result
}

function readToken(): string {
  const direct = process.env.BELA_CODEX_BRIDGE_TOKEN?.trim()
  if (direct) return direct
  const file = process.env.BELA_CODEX_BRIDGE_TOKEN_FILE?.trim()
  if (!file) throw new Error('BELA_CODEX_BRIDGE_TOKEN or BELA_CODEX_BRIDGE_TOKEN_FILE is required')
  let token: string
  try {
    token = readFileSync(file, 'utf8').trim()
  } catch (error) {
    throw new Error(`Cannot read Bridge API token file ${file}: ${(error as Error).message}`)
  }
  if (!token) throw new Error(`Bridge API token file is empty: ${file}`)
  return token
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}`)
  }
  return value as number
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be a non-empty string`)
  return value.trim()
}

function absolutePath(value: unknown, path: string): string {
  const result = string(value, path)
  if (!isAbsolute(result)) throw new Error(`${path} must be an absolute path`)
  return result
}

function validate(raw: Record<string, unknown>): Omit<BridgeConfig, 'auth'> {
  const api = raw.api as Record<string, unknown>
  const codex = raw.codex as Record<string, unknown>
  const storage = raw.storage as Record<string, unknown>
  const runs = raw.runs as Record<string, unknown>
  const artifacts = raw.artifacts as Record<string, unknown>
  const callbacks = raw.callbacks as Record<string, unknown>
  const logging = raw.logging as Record<string, unknown>
  const level = string(logging.level, 'logging.level')
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new Error('logging.level must be debug, info, warn, or error')
  }

  return {
    api: {
      unixSocket: absolutePath(api.unixSocket, 'api.unixSocket'),
      socketMode: integer(api.socketMode, 'api.socketMode', 0o600, 0o660),
      maxBodyBytes: integer(api.maxBodyBytes, 'api.maxBodyBytes', 1024, 16 * 1024 * 1024),
    },
    codex: {
      binary: absolutePath(codex.binary, 'codex.binary'),
      expectedVersion: string(codex.expectedVersion, 'codex.expectedVersion'),
      model: string(codex.model, 'codex.model'),
      startupTimeoutMs: integer(codex.startupTimeoutMs, 'codex.startupTimeoutMs', 1000, 300000),
      requestTimeoutMs: integer(codex.requestTimeoutMs, 'codex.requestTimeoutMs', 1000, 600000),
      turnTimeoutMs: integer(codex.turnTimeoutMs, 'codex.turnTimeoutMs', 10000, 24 * 60 * 60 * 1000),
      restartBaseDelayMs: integer(codex.restartBaseDelayMs, 'codex.restartBaseDelayMs', 100, 60000),
      restartMaxDelayMs: integer(codex.restartMaxDelayMs, 'codex.restartMaxDelayMs', 1000, 600000),
      maxRestartsInWindow: integer(codex.maxRestartsInWindow, 'codex.maxRestartsInWindow', 1, 100),
      restartWindowMs: integer(codex.restartWindowMs, 'codex.restartWindowMs', 10000, 24 * 60 * 60 * 1000),
    },
    storage: {
      database: absolutePath(storage.database, 'storage.database'),
      runtimeRoot: absolutePath(storage.runtimeRoot, 'storage.runtimeRoot'),
      lockFile: absolutePath(storage.lockFile, 'storage.lockFile'),
    },
    runs: {
      globalConcurrency: integer(runs.globalConcurrency, 'runs.globalConcurrency', 1, 32),
      perAgentConcurrency: integer(runs.perAgentConcurrency, 'runs.perAgentConcurrency', 1, 4),
      maxQueuedPerAgent: integer(runs.maxQueuedPerAgent, 'runs.maxQueuedPerAgent', 1, 1000),
      eventRetentionDays: integer(runs.eventRetentionDays, 'runs.eventRetentionDays', 1, 3650),
      maxPromptBytes: integer(runs.maxPromptBytes, 'runs.maxPromptBytes', 1024, 4 * 1024 * 1024),
    },
    artifacts: {
      maxImageBytes: integer(
        artifacts.maxImageBytes,
        'artifacts.maxImageBytes',
        1024,
        100 * 1024 * 1024,
      ),
    },
    callbacks: {
      enabled: Boolean(callbacks.enabled),
      baseUrl: string(callbacks.baseUrl, 'callbacks.baseUrl').replace(/\/+$/, ''),
      timeoutMs: integer(callbacks.timeoutMs, 'callbacks.timeoutMs', 500, 300000),
      maxAttempts: integer(callbacks.maxAttempts, 'callbacks.maxAttempts', 1, 100),
      initialDelayMs: integer(callbacks.initialDelayMs, 'callbacks.initialDelayMs', 100, 60000),
      maxDelayMs: integer(callbacks.maxDelayMs, 'callbacks.maxDelayMs', 1000, 24 * 60 * 60 * 1000),
    },
    logging: { level: level as BridgeConfig['logging']['level'] },
  }
}

export function loadConfig(configPath = process.env.BELA_CODEX_BRIDGE_CONFIG): BridgeConfig {
  const defaults = parseJsonFile(DEFAULT_CONFIG_PATH)
  assertKnownKeys(defaults, 'defaults')
  let merged = defaults
  if (configPath) {
    if (!existsSync(configPath)) throw new Error(`Bridge config file does not exist: ${configPath}`)
    const override = parseJsonFile(configPath)
    assertKnownKeys(override, 'config')
    merged = mergeConfig(defaults, override)
  }

  if (process.env.BELA_CODEX_BRIDGE_LOG_LEVEL) {
    merged = mergeConfig(merged, { logging: { level: process.env.BELA_CODEX_BRIDGE_LOG_LEVEL } })
  }
  const validated = validate(merged)
  const token = readToken()
  if (Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('Bridge API token must contain at least 32 bytes')
  }
  return { ...validated, auth: { token } }
}

export { DEFAULT_CONFIG_PATH, PROJECT_ROOT }
