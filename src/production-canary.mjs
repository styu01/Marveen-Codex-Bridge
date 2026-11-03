import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'

const TERRA = 'gpt-5.6-terra'
const SOL = 'gpt-5.6-sol'
const REJECTED_MODEL = 'gpt-5.5'

function fail(code, message, status = null) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function settingsFrom(body) {
  const settings = body?.data
  if (
    !settings
    || typeof settings.developerInstructions !== 'string'
    || typeof settings.reasoningEffort !== 'string'
    || typeof settings.model !== 'string'
    || !Array.isArray(settings.selectableModels)
  ) {
    throw fail('invalid_settings_response', 'Bridge settings response is invalid')
  }
  return settings
}

function assertReady(body) {
  if (
    body?.status !== 'ready'
    || body?.bridgeVersion !== '0.3.4'
    || body?.database !== true
    || body?.runtime !== true
  ) {
    throw fail('bridge_not_ready', 'Bridge 0.3.4 is not fully ready')
  }
}

function assertAuditTransition(records, { actor, before, after }) {
  const record = records.find((entry) => (
    entry?.actor === actor
    && entry?.action === 'update'
    && entry?.outcome === 'succeeded'
    && entry?.changes?.model?.before === before
    && entry?.changes?.model?.after === after
  ))
  if (!record) {
    throw fail('audit_transition_missing', `Audit transition ${before} -> ${after} is missing`)
  }
}

export function createLoopbackAdminClient({
  origin,
  token,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  const url = new URL(origin)
  if (
    url.protocol !== 'http:'
    || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw fail('invalid_origin', 'Admin API origin must be plain HTTP loopback')
  }
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) {
    throw fail('invalid_token', 'Admin API token is invalid')
  }
  const normalized = url.toString().replace(/\/+$/, '')
  return async (path, {
    method = 'GET',
    body,
    allowedStatuses = [200],
  } = {}) => {
    let response
    try {
      response = await fetchImpl(`${normalized}${path}`, {
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
      throw fail('admin_api_unreachable', `${path} is unreachable`)
    }
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
      throw fail('response_too_large', `${path} response is too large`, response.status)
    }
    let parsed
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      throw fail('invalid_response', `${path} returned non-JSON`, response.status)
    }
    if (!allowedStatuses.includes(response.status)) {
      throw fail(
        typeof parsed?.error === 'string' ? parsed.error : 'http_error',
        `${path} failed with HTTP ${response.status}`,
        response.status,
      )
    }
    return { status: response.status, body: parsed }
  }
}

export function readPrivateToken(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw fail('unsafe_token_file', 'Token must be a private regular non-symlink file')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw fail('unsafe_token_owner', 'Token must be owned by the service user')
  }
  const token = readFileSync(path, 'utf8').trim()
  if (token.length < 32 || /[\r\n]/.test(token)) {
    throw fail('invalid_token', 'Token content is invalid')
  }
  return token
}

export function createMutationSnapshot({ configPath, historyPath }) {
  return () => {
    const config = readFileSync(configPath)
    let backups = []
    try {
      backups = readdirSync(historyPath)
        .filter((name) => /^config-\d+-[0-9a-f-]+\.json$/.test(name))
        .sort()
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return {
      configSha256: createHash('sha256').update(config).digest('hex'),
      backups,
    }
  }
}

export async function preflightProductionCanary({
  bridgeRequest,
  marveenRequest,
  peerId = 'codex',
}) {
  const ready = await bridgeRequest('/readyz')
  assertReady(ready.body)
  const settings = settingsFrom((await bridgeRequest('/v1/dashboard/agent-settings')).body)
  if (settings.model !== TERRA) {
    throw fail('terra_required', 'Production canary must start from gpt-5.6-terra')
  }
  if (!settings.selectableModels.includes(TERRA) || !settings.selectableModels.includes(SOL)) {
    throw fail('models_not_selectable', 'Terra and Sol must both be selectable')
  }
  const inventory = await marveenRequest('/api/federation/peers')
  if (
    inventory?.enabled !== true
    || !Array.isArray(inventory.peers)
    || !inventory.peers.some((peer) => peer?.id === peerId)
  ) {
    throw fail('federation_not_ready', 'Enabled Federation and the Codex peer are required')
  }
  return settings
}

export async function runProductionCanary({
  bridgeRequest,
  marveenRequest,
  runFederationCanary,
  snapshot,
  actor,
  markerTimestamp,
  mainAgentId = 'bela',
  peerId = 'codex',
  remoteAgentId = 'programozo',
}) {
  const initial = await preflightProductionCanary({ bridgeRequest, marveenRequest, peerId })
  const before = snapshot()
  const auditBefore = (await bridgeRequest('/v1/dashboard/agent-settings/audit?limit=100')).body?.data
  if (!Array.isArray(auditBefore)) throw fail('invalid_audit_response', 'Audit response is invalid')
  let model = initial.model

  const update = async (target, updateActor = actor) => {
    await bridgeRequest('/v1/dashboard/agent-settings', {
      method: 'PUT',
      body: {
        actor: updateActor,
        model: target,
        developerInstructions: initial.developerInstructions,
        reasoningEffort: initial.reasoningEffort,
        confirm: true,
      },
    })
    model = target
    assertReady((await bridgeRequest('/readyz')).body)
    const current = settingsFrom((await bridgeRequest('/v1/dashboard/agent-settings')).body)
    if (current.model !== target) {
      throw fail('model_switch_not_persisted', `Model switch to ${target} did not persist`)
    }
  }

  try {
    await update(SOL)
    let audit = (await bridgeRequest('/v1/dashboard/agent-settings/audit?limit=100')).body?.data
    if (!Array.isArray(audit)) throw fail('invalid_audit_response', 'Audit response is invalid')
    assertAuditTransition(audit, { actor, before: TERRA, after: SOL })
    const afterSol = snapshot()
    if (afterSol.backups.length !== before.backups.length + 1) {
      throw fail('sol_backup_missing', 'Terra -> Sol did not create exactly one backup')
    }

    const solMarker = `FEDERATION_V033_SOL_${markerTimestamp}_OK`
    const sol = await runFederationCanary({
      request: marveenRequest,
      mainAgentId,
      peerId,
      remoteAgentId,
      marker: solMarker,
    })

    await update(TERRA)
    audit = (await bridgeRequest('/v1/dashboard/agent-settings/audit?limit=100')).body?.data
    if (!Array.isArray(audit)) throw fail('invalid_audit_response', 'Audit response is invalid')
    assertAuditTransition(audit, { actor, before: SOL, after: TERRA })
    const afterTerra = snapshot()
    if (afterTerra.backups.length !== before.backups.length + 2) {
      throw fail('terra_backup_missing', 'Sol -> Terra did not create exactly one backup')
    }

    const terraMarker = `FEDERATION_V033_TERRA_${markerTimestamp}_OK`
    const terra = await runFederationCanary({
      request: marveenRequest,
      mainAgentId,
      peerId,
      remoteAgentId,
      marker: terraMarker,
    })

    const negativeBefore = snapshot()
    const negativeAuditBefore = (await bridgeRequest(
      '/v1/dashboard/agent-settings/audit?limit=100',
    )).body?.data
    const rejected = await bridgeRequest('/v1/dashboard/agent-settings', {
      method: 'PUT',
      body: {
        actor,
        model: REJECTED_MODEL,
        developerInstructions: initial.developerInstructions,
        reasoningEffort: initial.reasoningEffort,
        confirm: true,
      },
      allowedStatuses: [400],
    })
    if (rejected.body?.error !== 'model_not_allowed') {
      throw fail('unexpected_model_rejection', 'Rejected model returned the wrong error')
    }
    const negativeAfter = snapshot()
    const negativeAuditAfter = (await bridgeRequest(
      '/v1/dashboard/agent-settings/audit?limit=100',
    )).body?.data
    if (
      negativeAfter.configSha256 !== negativeBefore.configSha256
      || JSON.stringify(negativeAfter.backups) !== JSON.stringify(negativeBefore.backups)
      || JSON.stringify(negativeAuditAfter) !== JSON.stringify(negativeAuditBefore)
    ) {
      throw fail('rejected_model_mutated_state', 'Rejected model changed protected state')
    }
    if (audit.length !== auditBefore.length + 2) {
      throw fail('unexpected_audit_count', 'Successful model switches did not add two audit records')
    }
    return { sol, terra, backupCountAdded: 2, rejectedModel: REJECTED_MODEL }
  } catch (error) {
    if (model !== initial.model) {
      try {
        await update(initial.model, `${actor}-cleanup`)
      } catch (cleanupError) {
        const combined = fail(
          'production_canary_cleanup_failed',
          'Production canary failed and the initial model could not be restored',
        )
        combined.cause = error
        combined.cleanupError = cleanupError
        throw combined
      }
    }
    throw error
  }
}

export const PRODUCTION_CANARY_MODELS = Object.freeze({ TERRA, SOL, REJECTED_MODEL })
