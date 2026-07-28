import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalBroker } from '../../src/runs/approval-broker.js'
import { BridgeDatabase } from '../../src/db/database.js'
import { RepositorySet } from '../../src/db/repositories.js'
import { Logger } from '../../src/logging.js'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-approval-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const database = new BridgeDatabase(join(root, 'bridge.sqlite3'))
  database.migrate()
  const repos = new RepositorySet(database.raw)
  repos.agents.upsert({
    agentId: 'codex-dev',
    displayName: 'Codex Dev',
    model: 'gpt-5.6-terra',
    workspacePath: workspace,
    workspaceMode: 'directory',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'bela',
    networkEnabled: false,
    instructions: '',
  })
  repos.agents.setState('codex-dev', 'running', 'idle')
  const run = repos.runs.create({
    agentId: 'codex-dev',
    idempotencyKey: 'approval-run',
    prompt: 'approval',
    context: {},
    priority: 0,
  }).run
  repos.runs.updateState(run.runId, 'running', {
    threadId: 'thread-approval',
    turnId: 'turn-approval',
  })
  const broker = new ApprovalBroker(
    database.raw,
    new Logger('error'),
    () => run.runId,
    () => 7,
    5000,
  )
  return { broker, database, repos, runId: run.runId }
}

test('decline resolves fail-closed and records the approval result', async () => {
  const { broker, database, repos, runId } = setup()
  try {
    const decision = broker.handle({
      id: 'provider-request-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-approval', turnId: 'turn-approval' },
    })
    const [pending] = broker.list(runId)
    assert.ok(pending)
    assert.equal(pending.state, 'pending')
    assert.equal(pending.appServerGeneration, 7)
    assert.equal(pending.providerRequestId, 'provider-request-1')
    broker.decide(String(pending.approvalId), 'decline')
    assert.deepEqual(await decision, { decision: 'decline' })
    assert.equal(broker.list(runId)[0]?.state, 'declined')
    assert.ok(repos.events.list(runId).some(
      (event) => event.type === 'approval_result' && event.payload.decision === 'decline',
    ))
  } finally {
    broker.shutdown()
    database.close()
  }
})

test('provider request ids may be reused after a decision without a database collision', async () => {
  const { broker, database, runId } = setup()
  const request = {
    id: 'provider-request-reused',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 'thread-approval', turnId: 'turn-approval' },
  }
  try {
    const firstDecision = broker.handle(request)
    const first = broker.list(runId)[0]!
    broker.decide(String(first.approvalId), 'decline')
    assert.deepEqual(await firstDecision, { decision: 'decline' })

    const secondDecision = broker.handle(request)
    const second = broker.list(runId).find((item) => item.state === 'pending')!
    assert.notEqual(second.approvalId, first.approvalId)
    broker.decide(String(second.approvalId), 'approve')
    assert.deepEqual(await secondDecision, { decision: 'accept' })

    const approvals = broker.list(runId)
    assert.equal(approvals.length, 2)
    assert.deepEqual(
      approvals.map((item) => item.state).sort(),
      ['approved', 'declined'],
    )
  } finally {
    broker.shutdown()
    database.close()
  }
})

test('a duplicate in-flight provider request shares one pending decision', async () => {
  const { broker, database, runId } = setup()
  const request = {
    id: 'provider-request-in-flight',
    method: 'item/fileChange/requestApproval',
    params: { threadId: 'thread-approval', turnId: 'turn-approval' },
  }
  try {
    const firstDecision = broker.handle(request)
    const duplicateDecision = broker.handle(request)
    const approvals = broker.list(runId)
    assert.equal(approvals.length, 1)
    broker.decide(String(approvals[0]!.approvalId), 'approve')
    assert.deepEqual(await firstDecision, { decision: 'accept' })
    assert.deepEqual(await duplicateDecision, { decision: 'accept' })
  } finally {
    broker.shutdown()
    database.close()
  }
})
