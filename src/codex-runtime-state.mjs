import { createHash, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { openSqliteDatabase } from './sqlite-driver.mjs'

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function mapRun(row) {
  if (!row) return null
  return {
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    runId: row.run_id,
    agentId: row.agent_id,
    state: row.state,
    threadId: row.thread_id,
    turnId: row.turn_id,
    response: row.response,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    finishedAtMs: row.finished_at_ms,
  }
}

function mapArtifact(row) {
  if (!row) return null
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    agentId: row.agent_id,
    workspaceRelativePath: row.workspace_relative_path,
    storedRelativePath: row.stored_relative_path,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    createdAtMs: row.created_at_ms,
  }
}

export class CodexRuntimeState {
  constructor(path, {
    betterSqlite3Path,
    clock = Date.now,
  } = {}) {
    this.clock = clock
    this.db = openSqliteDatabase(path, {
      driver: 'better-sqlite3',
      betterSqlite3Path,
    })
    chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `)
    const tables = this.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'codex_runtime_threads', 'codex_runtime_runs', 'codex_image_artifacts'
      )
    `).all()
    if (tables.length !== 3) {
      this.db.close()
      throw new Error('Codex runtime migrations 003 and 005 are not applied')
    }
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
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

  reconcileAfterProcessRestart() {
    const now = this.clock()
    return this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'interrupted_unknown',
          error_code = 'runtime_restart_during_turn',
          error_message = 'Bridge restarted after Codex turn submission; automatic replay is blocked',
          updated_at_ms = ?,
          finished_at_ms = ?
      WHERE state = 'running'
    `).run(now, now).changes
  }

  nextAppServerGeneration() {
    return this.transaction(() => {
      this.db.prepare(`
        UPDATE codex_runtime_meta
        SET app_server_generation = app_server_generation + 1
        WHERE singleton = 1
      `).run()
      return this.db.prepare(`
        SELECT app_server_generation AS generation
        FROM codex_runtime_meta WHERE singleton = 1
      `).get().generation
    })
  }

  beginRun({ idempotencyKey, agentId, prompt, context }) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new TypeError('idempotencyKey is required')
    }
    const payloadHash = sha256({ agentId, prompt, context })
    const now = this.clock()
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT * FROM codex_runtime_runs WHERE idempotency_key = ?
      `).get(idempotencyKey)
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          const error = new Error('runtime idempotency key was reused with a different payload')
          error.code = 'runtime_idempotency_conflict'
          throw error
        }
        const record = mapRun(existing)
        if (record.state === 'succeeded') return { mode: 'completed', record }
        if (record.state === 'starting' && record.turnId === null) {
          return { mode: 'execute', record }
        }
        if (record.state === 'failed' && record.turnId === null) {
          this.db.prepare(`
            UPDATE codex_runtime_runs
            SET state = 'starting', error_code = NULL, error_message = NULL,
                finished_at_ms = NULL, updated_at_ms = ?
            WHERE idempotency_key = ?
          `).run(now, idempotencyKey)
          return {
            mode: 'execute',
            record: mapRun(this.db.prepare(`
              SELECT * FROM codex_runtime_runs WHERE idempotency_key = ?
            `).get(idempotencyKey)),
          }
        }
        const error = new Error(
          record.state === 'interrupted_unknown'
            ? 'previous Codex turn has indeterminate outcome; automatic replay is blocked'
            : `runtime run is not replayable from state '${record.state}'`,
        )
        error.code = record.state === 'interrupted_unknown'
          ? 'runtime_indeterminate'
          : 'runtime_run_not_replayable'
        throw error
      }
      const runId = randomUUID()
      this.db.prepare(`
        INSERT INTO codex_runtime_runs(
          idempotency_key, payload_hash, run_id, agent_id, state,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, 'starting', ?, ?)
      `).run(idempotencyKey, payloadHash, runId, agentId, now, now)
      return {
        mode: 'execute',
        record: mapRun(this.db.prepare(`
          SELECT * FROM codex_runtime_runs WHERE idempotency_key = ?
        `).get(idempotencyKey)),
      }
    })
  }

  markSubmitting(idempotencyKey, { threadId }) {
    const now = this.clock()
    const changed = this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'running', thread_id = ?, turn_id = NULL, updated_at_ms = ?
      WHERE idempotency_key = ? AND state = 'starting' AND turn_id IS NULL
    `).run(threadId, now, idempotencyKey).changes
    if (changed !== 1) throw new Error('runtime run lost its starting state')
  }

  setTurnId(idempotencyKey, turnId) {
    const changed = this.db.prepare(`
      UPDATE codex_runtime_runs
      SET turn_id = ?, updated_at_ms = ?
      WHERE idempotency_key = ? AND state = 'running' AND turn_id IS NULL
    `).run(turnId, this.clock(), idempotencyKey).changes
    if (changed !== 1) throw new Error('runtime run cannot store the Codex turn id')
  }

  succeed(idempotencyKey, response) {
    const now = this.clock()
    const changed = this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'succeeded', response = ?, error_code = NULL,
          error_message = NULL, updated_at_ms = ?, finished_at_ms = ?
      WHERE idempotency_key = ? AND state = 'running'
    `).run(response, now, now, idempotencyKey).changes
    if (changed !== 1) throw new Error('runtime run cannot transition to succeeded')
    return this.getRun(idempotencyKey)
  }

  failBeforeSubmission(idempotencyKey, code, message) {
    const now = this.clock()
    this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'failed', error_code = ?, error_message = ?,
          updated_at_ms = ?, finished_at_ms = ?
      WHERE idempotency_key = ? AND state = 'starting' AND turn_id IS NULL
    `).run(code, message, now, now, idempotencyKey)
  }

  failAfterSubmission(idempotencyKey, code, message) {
    const now = this.clock()
    this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'failed', error_code = ?, error_message = ?,
          updated_at_ms = ?, finished_at_ms = ?
      WHERE idempotency_key = ? AND state = 'running'
    `).run(code, message, now, now, idempotencyKey)
  }

  markIndeterminate(idempotencyKey, code, message) {
    const now = this.clock()
    this.db.prepare(`
      UPDATE codex_runtime_runs
      SET state = 'interrupted_unknown', error_code = ?, error_message = ?,
          updated_at_ms = ?, finished_at_ms = ?
      WHERE idempotency_key = ? AND state = 'running'
    `).run(code, message, now, now, idempotencyKey)
  }

  getRun(idempotencyKey) {
    return mapRun(this.db.prepare(`
      SELECT * FROM codex_runtime_runs WHERE idempotency_key = ?
    `).get(idempotencyKey))
  }

  listRuns({ state = null, agentId = null, limit = 100 } = {}) {
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.min(Math.max(limit, 1), 500)
      : 100
    const clauses = []
    const parameters = []
    if (state !== null) {
      clauses.push('state = ?')
      parameters.push(state)
    }
    if (agentId !== null) {
      clauses.push('agent_id = ?')
      parameters.push(agentId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`
      SELECT * FROM codex_runtime_runs
      ${where}
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(...parameters, boundedLimit).map(mapRun)
  }

  insertArtifact(input) {
    const changed = this.db.prepare(`
      INSERT INTO codex_image_artifacts(
        artifact_id, run_id, agent_id, workspace_relative_path,
        stored_relative_path, mime_type, byte_size, sha256,
        width, height, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.artifactId,
      input.runId,
      input.agentId,
      input.workspaceRelativePath,
      input.storedRelativePath,
      input.mimeType,
      input.byteSize,
      input.sha256,
      input.width,
      input.height,
      input.createdAtMs,
    ).changes
    if (changed !== 1) throw new Error('image artifact could not be persisted')
    return this.getArtifact(input.artifactId)
  }

  getArtifact(artifactId) {
    return mapArtifact(this.db.prepare(`
      SELECT * FROM codex_image_artifacts WHERE artifact_id = ?
    `).get(artifactId))
  }

  findArtifact({ runId, workspaceRelativePath, sha256 }) {
    return mapArtifact(this.db.prepare(`
      SELECT * FROM codex_image_artifacts
      WHERE run_id = ? AND workspace_relative_path = ? AND sha256 = ?
    `).get(runId, workspaceRelativePath, sha256))
  }

  listArtifacts({ runId = null, agentId = null } = {}) {
    let sql = 'SELECT * FROM codex_image_artifacts'
    const clauses = []
    const parameters = []
    if (runId !== null) {
      clauses.push('run_id = ?')
      parameters.push(runId)
    }
    if (agentId !== null) {
      clauses.push('agent_id = ?')
      parameters.push(agentId)
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    sql += ' ORDER BY created_at_ms, artifact_id'
    return this.db.prepare(sql).all(...parameters).map(mapArtifact)
  }

  getThread(agentId) {
    const row = this.db.prepare(`
      SELECT * FROM codex_runtime_threads WHERE agent_id = ?
    `).get(agentId)
    if (!row) return null
    return {
      agentId: row.agent_id,
      threadId: row.thread_id,
      generation: row.app_server_generation,
      model: row.model,
      configHash: row.config_hash,
      invalidatedAtMs: row.invalidated_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }
  }

  saveThread({ agentId, threadId, generation, model, configHash }) {
    const now = this.clock()
    this.db.prepare(`
      INSERT INTO codex_runtime_threads(
        agent_id, thread_id, app_server_generation, model, config_hash,
        invalidated_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        app_server_generation = excluded.app_server_generation,
        model = excluded.model,
        config_hash = excluded.config_hash,
        invalidated_at_ms = NULL,
        updated_at_ms = excluded.updated_at_ms
    `).run(agentId, threadId, generation, model, configHash, now, now)
    return this.getThread(agentId)
  }

  touchThread(agentId, generation) {
    this.db.prepare(`
      UPDATE codex_runtime_threads
      SET app_server_generation = ?, updated_at_ms = ?
      WHERE agent_id = ? AND invalidated_at_ms IS NULL
    `).run(generation, this.clock(), agentId)
  }

  invalidateThread(agentId) {
    this.db.prepare(`
      UPDATE codex_runtime_threads
      SET invalidated_at_ms = ?, updated_at_ms = ?
      WHERE agent_id = ? AND invalidated_at_ms IS NULL
    `).run(this.clock(), this.clock(), agentId)
  }

  close() {
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.db.close()
  }
}
