import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isValidSegment, parseQualifiedId } from './federation-contract.mjs'
import { openSqliteDatabase } from './sqlite-driver.mjs'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION_RX = /^(\d+)_.*\.sql$/
const TERMINAL_OUTBOX_STATES = new Set(['delivered', 'dead'])
const RETRYABLE_HTTP_STATUS = new Set([401, 408, 425, 429])
const MAX_CONTENT_BYTES = 60 * 1024
const MAX_REF_LENGTH = 128
const MAX_MESSAGE_KEY_LENGTH = 256

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function nowInteger(clock) {
  const value = clock()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('clock must return a non-negative safe integer')
  }
  return value
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function normalizePeer(value) {
  const peerId = requiredString(value, 'peerId')
  if (!isValidSegment(peerId)) throw new TypeError('peerId is invalid')
  return peerId.toLowerCase()
}

function localAgent(value, name) {
  const agent = requiredString(value, name)
  if (!isValidSegment(agent)) throw new TypeError(`${name} must be a local agent id`)
  return agent
}

function qualifiedAddress(value, name) {
  const address = requiredString(value, name)
  const parsed = parseQualifiedId(address)
  if (!parsed) throw new TypeError(`${name} must be a qualified Federation address`)
  return { address, parsed }
}

function contentString(value) {
  const content = requiredString(value, 'content')
  if (content.trim().length === 0) throw new TypeError('content must not be blank')
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    throw new TypeError(`content exceeds ${MAX_CONTENT_BYTES} bytes`)
  }
  return content
}

function referenceString(value, name = 'ref') {
  const reference = requiredString(value, name)
  if (reference.length > MAX_REF_LENGTH) {
    throw new TypeError(`${name} exceeds ${MAX_REF_LENGTH} characters`)
  }
  return reference
}

function parseJson(value) {
  return value === null ? null : JSON.parse(value)
}

function inboxHash(input) {
  return sha256(JSON.stringify({
    from: input.from,
    to: input.to,
    content: input.content,
    ref: input.ref ?? null,
  }))
}

function outboxHash(input, peerRef) {
  return sha256(JSON.stringify({
    from: input.from,
    to: input.to,
    content: input.content,
    ref: peerRef,
  }))
}

export class DurabilityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DurabilityError'
    this.code = code
  }
}

export function isRetryableDeliveryFailure({ httpStatus = null, networkError = false }) {
  if (networkError) return true
  if (!Number.isInteger(httpStatus)) return true
  return RETRYABLE_HTTP_STATUS.has(httpStatus) || httpStatus >= 500
}

export function computeBackoffMs({
  attempt,
  initialDelayMs,
  maxDelayMs,
  jitterRatio = 0.2,
  random = Math.random,
}) {
  if (!Number.isInteger(attempt) || attempt < 1) throw new TypeError('attempt must be >= 1')
  if (!Number.isSafeInteger(initialDelayMs) || initialDelayMs < 1) {
    throw new TypeError('initialDelayMs must be >= 1')
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < initialDelayMs) {
    throw new TypeError('maxDelayMs must be >= initialDelayMs')
  }
  if (typeof jitterRatio !== 'number' || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError('jitterRatio must be between 0 and 1')
  }
  const base = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.min(attempt - 1, 30))
  const sample = random()
  if (typeof sample !== 'number' || sample < 0 || sample >= 1) {
    throw new TypeError('random must return a number in [0, 1)')
  }
  return base + Math.floor(base * jitterRatio * sample)
}

export class FederationDurabilityStore {
  constructor(path, {
    clock = Date.now,
    migrationRoot = join(PROJECT_ROOT, 'migrations'),
    driver = 'builtin',
    betterSqlite3Path,
  } = {}) {
    requiredString(path, 'path')
    const absolutePath = resolve(path)
    const parent = dirname(absolutePath)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (realpathSync(parent) !== parent) {
      throw new DurabilityError(
        'unsafe_database_path',
        'Database parent directory must not traverse a symbolic link',
      )
    }
    if (existsSync(absolutePath)) {
      const target = lstatSync(absolutePath)
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new DurabilityError(
          'unsafe_database_path',
          'Database path must be a regular file and not a symbolic link',
        )
      }
    }
    this.path = absolutePath
    this.clock = clock
    this.migrationRoot = migrationRoot
    this.db = openSqliteDatabase(absolutePath, { driver, betterSqlite3Path })
    chmodSync(absolutePath, 0o600)
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `)
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Preserve the original error.
      }
      throw error
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )
    `)
    const files = readdirSync(this.migrationRoot)
      .filter((name) => MIGRATION_RX.test(name))
      .sort()
    for (const name of files) {
      const version = Number.parseInt(name.match(MIGRATION_RX)[1], 10)
      const sql = readFileSync(join(this.migrationRoot, name), 'utf8')
      const checksum = sha256(sql)
      const applied = this.db.prepare(`
        SELECT name, checksum FROM schema_migrations WHERE version = ?
      `).get(version)
      if (applied) {
        if (applied.name !== name || applied.checksum !== checksum) {
          throw new DurabilityError(
            'migration_checksum_mismatch',
            `Migration ${version} differs from the applied migration`,
          )
        }
        continue
      }
      this.transaction(() => {
        this.db.exec(sql)
        this.db.prepare(`
          INSERT INTO schema_migrations(version, name, checksum, applied_at_ms)
          VALUES (?, ?, ?, ?)
        `).run(version, name, checksum, nowInteger(this.clock))
      })
    }
  }

  acceptInbox(input) {
    const peerId = normalizePeer(input.peerId)
    const { address: from, parsed: fromParts } = qualifiedAddress(input.from, 'from')
    if (fromParts.system.toLowerCase() !== peerId) {
      throw new TypeError('from system does not match peerId')
    }
    const to = localAgent(input.to, 'to')
    const content = contentString(input.content)
    const peerRef = input.ref === undefined || input.ref === null
      ? null
      : referenceString(input.ref)
    const payloadHash = inboxHash({ from, to, content, ref: peerRef })
    const timestamp = nowInteger(this.clock)

    return this.transaction(() => {
      if (peerRef !== null) {
        const existing = this.db.prepare(`
          SELECT * FROM federation_inbox WHERE peer_id = ? AND peer_ref = ?
        `).get(peerId, peerRef)
        if (existing) {
          if (existing.payload_hash !== payloadHash) {
            throw new DurabilityError(
              'idempotency_conflict',
              `Inbox ref '${peerRef}' was already used with a different payload`,
            )
          }
          return { record: this.mapInbox(existing), duplicate: true }
        }
      }

      const result = this.db.prepare(`
        INSERT INTO federation_inbox(
          peer_id, peer_ref, payload_hash, from_address, to_agent, content,
          created_at_ms, updated_at_ms, available_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        peerId,
        peerRef,
        payloadHash,
        from,
        to,
        content,
        timestamp,
        timestamp,
        timestamp,
      )
      const row = this.db.prepare(`
        SELECT * FROM federation_inbox WHERE inbox_id = ?
      `).get(Number(result.lastInsertRowid))
      return { record: this.mapInbox(row), duplicate: false }
    })
  }

  markInboxDispatched(inboxId, runId) {
    requiredString(runId, 'runId')
    return this.updateInboxTerminalAware(inboxId, 'dispatched', {
      runId,
      result: null,
      errorCode: null,
      completedAtMs: null,
    })
  }

  completeInbox(inboxId, result = {}) {
    return this.updateInboxTerminalAware(inboxId, 'completed', {
      result,
      errorCode: null,
      completedAtMs: nowInteger(this.clock),
    })
  }

  failInbox(inboxId, errorCode, result = {}) {
    requiredString(errorCode, 'errorCode')
    return this.updateInboxTerminalAware(inboxId, 'failed', {
      result,
      errorCode,
      completedAtMs: nowInteger(this.clock),
    })
  }

  updateInboxTerminalAware(inboxId, nextState, changes) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM federation_inbox WHERE inbox_id = ?
      `).get(inboxId)
      if (!row) throw new DurabilityError('inbox_not_found', `Inbox ${inboxId} was not found`)
      if (row.state === 'completed' || row.state === 'failed') {
        throw new DurabilityError('invalid_state', `Inbox ${inboxId} is terminal`)
      }
      const updatedAt = nowInteger(this.clock)
      this.db.prepare(`
        UPDATE federation_inbox
        SET state = ?,
            run_id = COALESCE(?, run_id),
            result_json = ?,
            error_code = ?,
            completed_at_ms = ?,
            updated_at_ms = ?
        WHERE inbox_id = ?
      `).run(
        nextState,
        changes.runId ?? null,
        changes.result === undefined || changes.result === null
          ? null
          : JSON.stringify(changes.result),
        changes.errorCode ?? null,
        changes.completedAtMs ?? null,
        updatedAt,
        inboxId,
      )
      return this.getInbox(inboxId)
    })
  }

  getInbox(inboxId) {
    const row = this.db.prepare(`
      SELECT * FROM federation_inbox WHERE inbox_id = ?
    `).get(inboxId)
    return row ? this.mapInbox(row) : null
  }

  listInbox({ state = null } = {}) {
    const rows = state === null
      ? this.db.prepare('SELECT * FROM federation_inbox ORDER BY inbox_id').all()
      : this.db.prepare(`
          SELECT * FROM federation_inbox WHERE state = ? ORDER BY inbox_id
        `).all(state)
    return rows.map((row) => this.mapInbox(row))
  }

  claimInbox({
    workerId,
    limit = 10,
    leaseMs = 60_000,
    maxAttempts = 3,
  }) {
    requiredString(workerId, 'workerId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('limit must be between 1 and 100')
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('leaseMs must be >= 1')
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be >= 1')
    }
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const expired = this.db.prepare(`
        SELECT * FROM federation_inbox
        WHERE state = 'dispatched' AND lease_expires_at_ms <= ?
        ORDER BY inbox_id
      `).all(timestamp)
      for (const row of expired) {
        if (row.attempts >= maxAttempts) {
          this.db.prepare(`
            UPDATE federation_inbox
            SET state = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
                error_code = 'runtime_lease_expired_max_attempts',
                completed_at_ms = ?, updated_at_ms = ?
            WHERE inbox_id = ? AND state = 'dispatched'
          `).run(timestamp, timestamp, row.inbox_id)
        } else {
          this.db.prepare(`
            UPDATE federation_inbox
            SET state = 'accepted', lease_owner = NULL, lease_expires_at_ms = NULL,
                available_at_ms = ?, error_code = 'runtime_lease_expired',
                updated_at_ms = ?
            WHERE inbox_id = ? AND state = 'dispatched'
          `).run(timestamp, timestamp, row.inbox_id)
        }
      }

      const ready = this.db.prepare(`
        SELECT inbox_id FROM federation_inbox
        WHERE state = 'accepted' AND available_at_ms <= ?
        ORDER BY available_at_ms ASC, inbox_id ASC
        LIMIT ?
      `).all(timestamp, limit)
      const claimed = []
      for (const candidate of ready) {
        const update = this.db.prepare(`
          UPDATE federation_inbox
          SET state = 'dispatched', attempts = attempts + 1,
              lease_owner = ?, lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE inbox_id = ? AND state = 'accepted' AND available_at_ms <= ?
        `).run(
          workerId,
          timestamp + leaseMs,
          timestamp,
          candidate.inbox_id,
          timestamp,
        )
        if (update.changes !== 1) continue
        claimed.push(this.getInbox(candidate.inbox_id))
      }
      return claimed
    })
  }

  // Renew only the lease currently owned by this exact worker. Never resurrect
  // an expired or reclaimed inbox; expiry is a strict ownership boundary.
  renewClaimedInbox({ inboxId, workerId, leaseMs }) {
    requiredString(workerId, 'workerId')
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('leaseMs must be >= 1')
    }
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const changed = this.db.prepare(`
        UPDATE federation_inbox
        SET lease_expires_at_ms = CASE
              WHEN lease_expires_at_ms > ? THEN lease_expires_at_ms
              ELSE ? END,
            updated_at_ms = ?
        WHERE inbox_id = ? AND state = 'dispatched'
          AND lease_owner = ? AND lease_expires_at_ms > ?
      `).run(timestamp + leaseMs, timestamp + leaseMs, timestamp,
        inboxId, workerId, timestamp).changes
      if (changed !== 1) {
        throw new DurabilityError('lease_lost', `Worker '${workerId}' does not own the inbox lease`)
      }
      return this.getInbox(inboxId)
    })
  }

  failClaimedInbox({
    inboxId,
    workerId,
    errorCode = 'runtime_failed',
    forceTerminal = false,
    maxAttempts = 3,
    initialDelayMs = 1_000,
    maxDelayMs = 60_000,
    jitterRatio = 0.2,
    random = Math.random,
  }) {
    requiredString(workerId, 'workerId')
    requiredString(errorCode, 'errorCode')
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const row = this.requireInboxLease(inboxId, workerId, timestamp)
      if (forceTerminal || row.attempts >= maxAttempts) {
        this.db.prepare(`
          UPDATE federation_inbox
          SET state = 'failed', lease_owner = NULL, lease_expires_at_ms = NULL,
              error_code = ?, completed_at_ms = ?, updated_at_ms = ?
          WHERE inbox_id = ?
        `).run(errorCode, timestamp, timestamp, inboxId)
      } else {
        const delayMs = computeBackoffMs({
          attempt: row.attempts,
          initialDelayMs,
          maxDelayMs,
          jitterRatio,
          random,
        })
        this.db.prepare(`
          UPDATE federation_inbox
          SET state = 'accepted', lease_owner = NULL, lease_expires_at_ms = NULL,
              error_code = ?, available_at_ms = ?, updated_at_ms = ?
          WHERE inbox_id = ?
        `).run(errorCode, timestamp + delayMs, timestamp, inboxId)
      }
      return this.getInbox(inboxId)
    })
  }

  completeClaimedInboxWithReply({
    inboxId,
    workerId,
    systemId,
    response,
    runId,
    artifacts = [],
  }) {
    requiredString(workerId, 'workerId')
    if (!isValidSegment(systemId)) throw new TypeError('systemId is invalid')
    const content = contentString(response)
    requiredString(runId, 'runId')
    if (!Array.isArray(artifacts) || artifacts.length > 100) {
      throw new TypeError('artifacts must be an array with at most 100 entries')
    }
    const artifactReceipt = artifacts.map((artifact) => {
      if (
        !artifact
        || typeof artifact !== 'object'
        || typeof artifact.artifactId !== 'string'
        || typeof artifact.workspaceRelativePath !== 'string'
        || typeof artifact.mimeType !== 'string'
        || typeof artifact.sha256 !== 'string'
      ) {
        throw new TypeError('artifact receipt is invalid')
      }
      return {
        artifactId: artifact.artifactId,
        workspaceRelativePath: artifact.workspaceRelativePath,
        mimeType: artifact.mimeType,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        width: artifact.width,
        height: artifact.height,
      }
    })
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const inboxRow = this.requireInboxLease(inboxId, workerId, timestamp)
      const source = parseQualifiedId(inboxRow.from_address)
      if (!source) throw new DurabilityError('invalid_state', 'Stored inbox sender is invalid')
      const messageKey = `inbox:${inboxId}:reply:v1`
      const peerRef = messageKey
      const from = `${systemId}/${inboxRow.to_agent}`
      const to = source.agent
      const payloadHash = outboxHash({ from, to, content }, peerRef)
      let outboxRow = this.db.prepare(`
        SELECT * FROM federation_outbox WHERE peer_id = ? AND message_key = ?
      `).get(inboxRow.peer_id, messageKey)
      if (outboxRow && outboxRow.payload_hash !== payloadHash) {
        throw new DurabilityError(
          'idempotency_conflict',
          `Reply for inbox ${inboxId} already exists with a different payload`,
        )
      }
      if (!outboxRow) {
        const inserted = this.db.prepare(`
          INSERT INTO federation_outbox(
            peer_id, message_key, payload_hash, from_address, to_agent, content,
            peer_ref, available_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          inboxRow.peer_id,
          messageKey,
          payloadHash,
          from,
          to,
          content,
          peerRef,
          timestamp,
          timestamp,
          timestamp,
        )
        const outboxId = Number(inserted.lastInsertRowid)
        this.insertEvent(outboxId, 'enqueued', 0, { inboxId })
        outboxRow = this.db.prepare(`
          SELECT * FROM federation_outbox WHERE outbox_id = ?
        `).get(outboxId)
      }
      this.db.prepare(`
        UPDATE federation_inbox
        SET state = 'completed', run_id = ?, result_json = ?,
            error_code = NULL, lease_owner = NULL, lease_expires_at_ms = NULL,
            completed_at_ms = ?, updated_at_ms = ?
        WHERE inbox_id = ?
      `).run(
        runId,
        JSON.stringify({
          response: content,
          outboxId: outboxRow.outbox_id,
          artifacts: artifactReceipt,
        }),
        timestamp,
        timestamp,
        inboxId,
      )
      return {
        inbox: this.getInbox(inboxId),
        outbox: this.getOutbox(outboxRow.outbox_id),
      }
    })
  }

  requireInboxLease(inboxId, workerId, timestamp) {
    const row = this.db.prepare(`
      SELECT * FROM federation_inbox WHERE inbox_id = ?
    `).get(inboxId)
    if (!row) throw new DurabilityError('inbox_not_found', `Inbox ${inboxId} was not found`)
    if (
      row.state !== 'dispatched'
      || row.lease_owner !== workerId
      || row.lease_expires_at_ms <= timestamp
    ) {
      throw new DurabilityError('lease_lost', `Worker '${workerId}' does not own the inbox lease`)
    }
    return row
  }

  enqueueOutbox(input) {
    const peerId = normalizePeer(input.peerId)
    const messageKey = requiredString(input.messageKey, 'messageKey')
    if (messageKey.length > MAX_MESSAGE_KEY_LENGTH) {
      throw new TypeError(`messageKey exceeds ${MAX_MESSAGE_KEY_LENGTH} characters`)
    }
    const { address: from, parsed: fromParts } = qualifiedAddress(input.from, 'from')
    if (fromParts.system.toLowerCase() === peerId) {
      throw new TypeError('outbox from system must not impersonate the destination peer')
    }
    const to = localAgent(input.to, 'to')
    const content = contentString(input.content)
    const peerRef = input.ref === undefined || input.ref === null
      ? referenceString(messageKey, 'messageKey')
      : referenceString(input.ref)
    const payloadHash = outboxHash({ from, to, content }, peerRef)
    const timestamp = nowInteger(this.clock)

    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM federation_outbox WHERE peer_id = ? AND message_key = ?
      `).get(peerId, messageKey)
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw new DurabilityError(
            'idempotency_conflict',
            `Outbox messageKey '${messageKey}' was already used with a different payload`,
          )
        }
        return { record: this.mapOutbox(existing), duplicate: true }
      }
      const result = this.db.prepare(`
        INSERT INTO federation_outbox(
          peer_id, message_key, payload_hash, from_address, to_agent, content,
          peer_ref, available_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        peerId,
        messageKey,
        payloadHash,
        from,
        to,
        content,
        peerRef,
        timestamp,
        timestamp,
        timestamp,
      )
      const outboxId = Number(result.lastInsertRowid)
      this.insertEvent(outboxId, 'enqueued', 0, {})
      return { record: this.getOutbox(outboxId), duplicate: false }
    })
  }

  claimOutbox({
    workerId,
    limit = 20,
    leaseMs = 30_000,
    maxAttempts = 8,
  }) {
    requiredString(workerId, 'workerId')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('limit must be between 1 and 100')
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new TypeError('leaseMs must be >= 1')
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be >= 1')
    }
    const timestamp = nowInteger(this.clock)

    return this.transaction(() => {
      const expired = this.db.prepare(`
        SELECT * FROM federation_outbox
        WHERE state = 'leased' AND lease_expires_at_ms <= ?
        ORDER BY outbox_id
      `).all(timestamp)
      for (const row of expired) {
        if (row.attempts >= maxAttempts) {
          this.db.prepare(`
            UPDATE federation_outbox
            SET state = 'dead', lease_owner = NULL, lease_expires_at_ms = NULL,
                last_error = 'delivery lease expired at maximum attempts',
                dead_at_ms = ?, updated_at_ms = ?
            WHERE outbox_id = ? AND state = 'leased'
          `).run(timestamp, timestamp, row.outbox_id)
          this.insertEvent(row.outbox_id, 'dead', row.attempts, {
            reason: 'lease_expired_max_attempts',
          })
        } else {
          this.db.prepare(`
            UPDATE federation_outbox
            SET state = 'pending', lease_owner = NULL, lease_expires_at_ms = NULL,
                available_at_ms = ?, last_error = 'delivery lease expired',
                updated_at_ms = ?
            WHERE outbox_id = ? AND state = 'leased'
          `).run(timestamp, timestamp, row.outbox_id)
          this.insertEvent(row.outbox_id, 'lease_recovered', row.attempts, {
            previousWorker: row.lease_owner,
          })
        }
      }

      const ready = this.db.prepare(`
        SELECT outbox_id FROM federation_outbox
        WHERE state = 'pending' AND available_at_ms <= ?
        ORDER BY available_at_ms ASC, outbox_id ASC
        LIMIT ?
      `).all(timestamp, limit)
      const claimed = []
      for (const candidate of ready) {
        const leaseExpiresAt = timestamp + leaseMs
        const update = this.db.prepare(`
          UPDATE federation_outbox
          SET state = 'leased', attempts = attempts + 1,
              lease_owner = ?, lease_expires_at_ms = ?, updated_at_ms = ?
          WHERE outbox_id = ? AND state = 'pending' AND available_at_ms <= ?
        `).run(workerId, leaseExpiresAt, timestamp, candidate.outbox_id, timestamp)
        if (update.changes !== 1) continue
        const row = this.db.prepare(`
          SELECT * FROM federation_outbox WHERE outbox_id = ?
        `).get(candidate.outbox_id)
        this.insertEvent(row.outbox_id, 'claimed', row.attempts, {
          workerId,
          leaseExpiresAt,
        })
        claimed.push(this.mapOutbox(row))
      }
      return claimed
    })
  }

  markOutboxDelivered({ outboxId, workerId, remoteId = null, httpStatus = 202 }) {
    requiredString(workerId, 'workerId')
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const row = this.requireLease(outboxId, workerId, timestamp)
      this.db.prepare(`
        UPDATE federation_outbox
        SET state = 'delivered', lease_owner = NULL, lease_expires_at_ms = NULL,
            last_error = NULL, last_http_status = ?, remote_id = ?,
            delivered_at_ms = ?, updated_at_ms = ?
        WHERE outbox_id = ?
      `).run(httpStatus, remoteId === null ? null : String(remoteId), timestamp, timestamp, outboxId)
      this.insertEvent(outboxId, 'delivered', row.attempts, {
        httpStatus,
        remoteId,
      })
      return this.getOutbox(outboxId)
    })
  }

  markOutboxFailed({
    outboxId,
    workerId,
    error,
    httpStatus = null,
    networkError = false,
    maxAttempts = 8,
    initialDelayMs = 1_000,
    maxDelayMs = 300_000,
    jitterRatio = 0.2,
    random = Math.random,
  }) {
    requiredString(workerId, 'workerId')
    requiredString(error, 'error')
    const timestamp = nowInteger(this.clock)
    return this.transaction(() => {
      const row = this.requireLease(outboxId, workerId, timestamp)
      const retryable = isRetryableDeliveryFailure({ httpStatus, networkError })
      const dead = !retryable || row.attempts >= maxAttempts
      if (dead) {
        const reason = retryable ? 'max_attempts' : 'terminal_http_status'
        this.db.prepare(`
          UPDATE federation_outbox
          SET state = 'dead', lease_owner = NULL, lease_expires_at_ms = NULL,
              last_error = ?, last_http_status = ?, dead_at_ms = ?, updated_at_ms = ?
          WHERE outbox_id = ?
        `).run(error.slice(0, 2000), httpStatus, timestamp, timestamp, outboxId)
        this.insertEvent(outboxId, 'dead', row.attempts, {
          reason,
          httpStatus,
          error: error.slice(0, 500),
        })
      } else {
        const delayMs = computeBackoffMs({
          attempt: row.attempts,
          initialDelayMs,
          maxDelayMs,
          jitterRatio,
          random,
        })
        this.db.prepare(`
          UPDATE federation_outbox
          SET state = 'pending', lease_owner = NULL, lease_expires_at_ms = NULL,
              available_at_ms = ?, last_error = ?, last_http_status = ?,
              updated_at_ms = ?
          WHERE outbox_id = ?
        `).run(
          timestamp + delayMs,
          error.slice(0, 2000),
          httpStatus,
          timestamp,
          outboxId,
        )
        this.insertEvent(outboxId, 'retry_scheduled', row.attempts, {
          delayMs,
          httpStatus,
          networkError,
          error: error.slice(0, 500),
        })
      }
      return this.getOutbox(outboxId)
    })
  }

  requireLease(outboxId, workerId, timestamp) {
    const row = this.db.prepare(`
      SELECT * FROM federation_outbox WHERE outbox_id = ?
    `).get(outboxId)
    if (!row) throw new DurabilityError('outbox_not_found', `Outbox ${outboxId} was not found`)
    if (TERMINAL_OUTBOX_STATES.has(row.state)) {
      throw new DurabilityError('invalid_state', `Outbox ${outboxId} is terminal`)
    }
    if (
      row.state !== 'leased'
      || row.lease_owner !== workerId
      || row.lease_expires_at_ms <= timestamp
    ) {
      throw new DurabilityError('lease_lost', `Worker '${workerId}' does not own an active lease`)
    }
    return row
  }

  getOutbox(outboxId) {
    const row = this.db.prepare(`
      SELECT * FROM federation_outbox WHERE outbox_id = ?
    `).get(outboxId)
    return row ? this.mapOutbox(row) : null
  }

  listOutbox({ state = null } = {}) {
    const rows = state === null
      ? this.db.prepare('SELECT * FROM federation_outbox ORDER BY outbox_id').all()
      : this.db.prepare(`
          SELECT * FROM federation_outbox WHERE state = ? ORDER BY outbox_id
        `).all(state)
    return rows.map((row) => this.mapOutbox(row))
  }

  listEvents(outboxId) {
    return this.db.prepare(`
      SELECT * FROM federation_delivery_events
      WHERE outbox_id = ? ORDER BY event_id
    `).all(outboxId).map((row) => ({
      eventId: row.event_id,
      outboxId: row.outbox_id,
      type: row.event_type,
      attempt: row.attempt,
      detail: parseJson(row.detail_json),
      createdAtMs: row.created_at_ms,
    }))
  }

  insertEvent(outboxId, type, attempt, detail) {
    this.db.prepare(`
      INSERT INTO federation_delivery_events(
        outbox_id, event_type, attempt, detail_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(outboxId, type, attempt, JSON.stringify(detail), nowInteger(this.clock))
  }

  integrityCheck() {
    const result = this.db.prepare('PRAGMA integrity_check').get()
    const foreignKeyErrors = this.db.prepare('PRAGMA foreign_key_check').all()
    return {
      ok: result.integrity_check === 'ok' && foreignKeyErrors.length === 0,
      integrity: result.integrity_check,
      foreignKeyErrors,
    }
  }

  checkpoint() {
    return this.db.prepare('PRAGMA wal_checkpoint(FULL)').get()
  }

  close() {
    this.db.close()
  }

  mapInbox(row) {
    return {
      inboxId: row.inbox_id,
      peerId: row.peer_id,
      ref: row.peer_ref,
      payloadHash: row.payload_hash,
      from: row.from_address,
      to: row.to_agent,
      content: row.content,
      state: row.state,
      runId: row.run_id,
      result: parseJson(row.result_json),
      errorCode: row.error_code,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      completedAtMs: row.completed_at_ms,
      attempts: row.attempts ?? 0,
      availableAtMs: row.available_at_ms ?? row.created_at_ms,
      leaseOwner: row.lease_owner ?? null,
      leaseExpiresAtMs: row.lease_expires_at_ms ?? null,
    }
  }

  mapOutbox(row) {
    return {
      outboxId: row.outbox_id,
      peerId: row.peer_id,
      messageKey: row.message_key,
      payloadHash: row.payload_hash,
      from: row.from_address,
      to: row.to_agent,
      content: row.content,
      ref: row.peer_ref,
      state: row.state,
      attempts: row.attempts,
      availableAtMs: row.available_at_ms,
      leaseOwner: row.lease_owner,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      lastError: row.last_error,
      lastHttpStatus: row.last_http_status,
      remoteId: row.remote_id,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      deliveredAtMs: row.delivered_at_ms,
      deadAtMs: row.dead_at_ms,
    }
  }
}
