import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { BridgeDatabase } from '../../src/db/database.js'
import { RepositorySet } from '../../src/db/repositories.js'

test('migrations are idempotent and run idempotency detects conflicts', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-db-'))
  mkdirSync(join(root, 'workspace'))
  const database = new BridgeDatabase(join(root, 'bridge.sqlite3'))
  database.migrate()
  database.migrate()
  const repos = new RepositorySet(database.raw)
  repos.agents.upsert({
    agentId: 'codex-dev',
    displayName: 'Codex Dev',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    workspacePath: join(root, 'workspace'),
    workspaceMode: 'directory',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    networkEnabled: false,
    instructions: '',
  })
  repos.agents.setState('codex-dev', 'running', 'idle')
  const first = repos.runs.create({
    agentId: 'codex-dev',
    idempotencyKey: 'same-key-123',
    prompt: 'hello',
    context: {},
    priority: 0,
  })
  const second = repos.runs.create({
    agentId: 'codex-dev',
    idempotencyKey: 'same-key-123',
    prompt: 'hello',
    context: {},
    priority: 0,
  })
  assert.equal(second.duplicate, true)
  assert.equal(second.run.runId, first.run.runId)
  assert.throws(() => repos.runs.create({
    agentId: 'codex-dev',
    idempotencyKey: 'same-key-123',
    prompt: 'different',
    context: {},
    priority: 0,
  }), /different payload/)
  const artifactPath = join(root, 'workspace', 'assets', 'final.png')
  const artifact = repos.artifacts.registerFinal({
    runId: first.run.runId,
    agentId: 'codex-dev',
    providerItemId: 'dynamic:first',
    kind: 'image',
    status: 'ready',
    mimeType: 'image/png',
    fileName: 'final.png',
    absolutePath: artifactPath,
    workspaceRelativePath: 'assets/final.png',
    sha256: 'a'.repeat(64),
    byteSize: 10,
    revisedPrompt: 'first',
  })
  const repeated = repos.artifacts.registerFinal({
    runId: first.run.runId,
    agentId: 'codex-dev',
    providerItemId: 'dynamic:retry',
    kind: 'image',
    status: 'ready',
    mimeType: 'image/png',
    fileName: 'final.png',
    absolutePath: artifactPath,
    workspaceRelativePath: 'assets/final.png',
    sha256: 'b'.repeat(64),
    byteSize: 11,
    revisedPrompt: 'final',
  })
  assert.equal(repeated.artifactId, artifact.artifactId)
  assert.equal(repeated.sha256, 'b'.repeat(64))
  assert.equal(repeated.byteSize, 11)
  assert.equal(repos.artifacts.listForRun(first.run.runId).length, 1)
  const migrations = database.raw.prepare(
    'SELECT version FROM schema_migrations ORDER BY version',
  ).all() as Array<{ version: number }>
  assert.deepEqual(migrations.map((row) => row.version), [1, 2, 3, 4, 5])
  const artifactColumns = database.raw.prepare(
    'PRAGMA table_info(bridge_artifacts)',
  ).all() as Array<{ name: string }>
  assert.ok(artifactColumns.some((column) => column.name === 'workspace_relative_path'))
  assert.ok(artifactColumns.some((column) => column.name === 'sha256'))
  database.close()
})

test('reasoning effort migration preserves legacy agents and increments config revision on change', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-db-effort-migration-'))
  const path = join(root, 'bridge.sqlite3')
  const legacy = new Database(path)
  legacy.exec(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'))
  legacy.exec(readFileSync(resolve('migrations/002_dynamic_tool_contract.sql'), 'utf8'))
  legacy.exec(readFileSync(resolve('migrations/003_approval_request_identity.sql'), 'utf8'))
  legacy.prepare(`
    INSERT INTO bridge_agents(
      agent_id, display_name, model, workspace_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('legacy-effort', 'Legacy effort', 'gpt-5.6-terra', root, '2026-01-01', '2026-01-01')
  legacy.prepare(`
    INSERT INTO codex_threads(
      agent_id, thread_id, app_server_generation, model, config_revision,
      tool_contract_revision, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('legacy-effort', 'legacy-thread', 1, 'gpt-5.6-terra', 1, 1, '2026-01-01')
  for (const version of [1, 2, 3]) {
    legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString())
  }
  legacy.close()

  const database = new BridgeDatabase(path)
  database.migrate()
  const repos = new RepositorySet(database.raw)
  const migrated = repos.agents.get('legacy-effort')
  assert.equal(migrated?.reasoningEffort, 'medium')
  assert.equal(repos.threads.get('legacy-effort')?.reasoningEffort, 'medium')

  const updated = repos.agents.upsert({
    agentId: 'legacy-effort',
    displayName: 'Legacy effort',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high',
    workspacePath: root,
    workspaceMode: 'directory',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'bela',
    networkEnabled: false,
    instructions: '',
  })
  assert.equal(updated.reasoningEffort, 'high')
  assert.equal(updated.configRevision, 2)
  database.close()
})

test('approval migration removes the invalid global provider request id uniqueness', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-db-approval-migration-'))
  const path = join(root, 'bridge.sqlite3')
  const legacy = new Database(path)
  legacy.exec(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'))
  legacy.exec(readFileSync(resolve('migrations/002_dynamic_tool_contract.sql'), 'utf8'))
  legacy.prepare(`
    INSERT INTO bridge_agents(
      agent_id, display_name, model, workspace_path, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run('legacy-agent', 'Legacy agent', 'gpt-5.6-terra', root, '2026-01-01', '2026-01-01')
  legacy.prepare(`
    INSERT INTO bridge_runs(
      run_id, agent_id, idempotency_key, payload_hash, state, prompt,
      context_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-run',
    'legacy-agent',
    'legacy-key',
    'legacy-hash',
    'succeeded',
    'legacy prompt',
    '{}',
    '2026-01-01',
    '2026-01-01',
  )
  legacy.prepare(`
    INSERT INTO bridge_approvals(
      approval_id, run_id, provider_request_id, category, request_json,
      state, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'legacy-approval',
    'legacy-run',
    'legacy-provider-request',
    'command',
    '{}',
    'declined',
    '2026-01-02',
    '2026-01-01',
  )
  legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString())
  legacy.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString())
  legacy.close()

  const database = new BridgeDatabase(path)
  database.migrate()
  const columns = database.raw.prepare('PRAGMA table_info(bridge_approvals)').all() as Array<{ name: string }>
  assert.ok(columns.some((column) => column.name === 'app_server_generation'))
  const indexes = database.raw.prepare('PRAGMA index_list(bridge_approvals)').all() as Array<{
    name: string
    unique: number
  }>
  assert.equal(
    indexes.some((index) => index.unique === 1 && index.name.includes('provider')),
    false,
  )
  const migration = database.raw
    .prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 3')
    .get() as { count: number }
  assert.equal(migration.count, 1)
  const preserved = database.raw.prepare(`
    SELECT approval_id, provider_request_id, app_server_generation, state
    FROM bridge_approvals
    WHERE approval_id = ?
  `).get('legacy-approval')
  assert.deepEqual(preserved, {
    approval_id: 'legacy-approval',
    provider_request_id: 'legacy-provider-request',
    app_server_generation: 0,
    state: 'declined',
  })
  database.close()
})
