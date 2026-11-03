#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'
import { FederationBridgeService } from '../src/service.mjs'

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument near '${key ?? ''}'`)
    }
    values[key.slice(2)] = value
  }
  return values
}

async function waitForApproval(baseUrl, token, runId, runtime, idempotencyKey) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/v1/approvals?state=pending&runId=${encodeURIComponent(runId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!response.ok) throw new Error(`approval list returned HTTP ${response.status}`)
    const rows = (await response.json()).data
    if (rows.length === 1) return rows[0]
    if (rows.length > 1) throw new Error('more than one approval belongs to one run')
    const storedRun = runtime.state.getRun(idempotencyKey)
    if (storedRun?.state === 'succeeded') {
      throw new Error(
        `run completed without approval: ${JSON.stringify(storedRun.response)}`,
      )
    }
    if (
      storedRun
      && ['failed', 'interrupted_unknown'].includes(storedRun.state)
    ) {
      throw new Error(
        `run ended before approval: state=${storedRun.state}, `
        + `code=${storedRun.errorCode}, message=${storedRun.errorMessage}`,
      )
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`approval did not appear for run ${runId}`)
}

async function decide(baseUrl, token, approvalId, decision) {
  const response = await fetch(`${baseUrl}/v1/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ decision }),
  })
  if (!response.ok) {
    throw new Error(`approval ${decision} returned HTTP ${response.status}: ${await response.text()}`)
  }
  return (await response.json()).data
}

const args = parseArgs(process.argv.slice(2))
for (const required of ['codex-bin', 'better-sqlite3-path', 'output-root']) {
  if (!args[required]) throw new Error(`--${required} is required`)
}

const outputRoot = resolve(args['output-root'])
const runtimeRoot = resolve(outputRoot, 'runtime')
const workspacePath = resolve(outputRoot, 'workspace')
const database = resolve(outputRoot, 'state', 'federation.sqlite3')
const approvedPath = resolve(outputRoot, 'approved-canary.txt')
const declinedPath = resolve(outputRoot, 'declined-canary.txt')
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
mkdirSync(workspacePath, { recursive: true, mode: 0o700 })

const adminToken = 'phase5-real-admin-token-000000000000000000000000'
const model = args.model ?? 'gpt-5.6-terra'
const expectedVersion = args['expected-version'] ?? '0.164.0'
const config = {
  version: 1,
  systemId: 'codex',
  listen: { host: '127.0.0.1', port: 0 },
  storage: { database },
  codex: {
    binary: realpathSync(resolve(args['codex-bin'])),
    expectedVersion,
    runtimeRoot,
    startupTimeoutMs: 120_000,
    requestTimeoutMs: 120_000,
    turnTimeoutMs: 600_000,
    approvalTimeoutMs: 300_000,
  },
  admin: { token: adminToken },
  agents: [{
    id: 'phase5preflight',
    displayName: 'Phase 5 preflight',
    model,
    workspacePath,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'manual',
    reasoningEffort: 'high',
    networkEnabled: false,
    federationPeer: 'marveen',
    developerInstructions:
      'Controlled local Bridge preflight. Follow the requested tool operation exactly. '
      + 'Do not access the network and do not touch paths other than the named canary.',
  }],
  peers: [{
    id: 'marveen',
    baseUrl: new URL('http://127.0.0.1:9'),
    inboundToken: 'phase5-real-inbound-token-0000000000000000000000',
    outboundToken: 'phase5-real-outbound-token-000000000000000000000',
  }],
  workers: {
    intervalMs: 1_000,
    runtimeLeaseMs: 120_000,
    runtimeMaxAttempts: 3,
    deliveryTimeoutMs: 1_000,
    deliveryLeaseMs: 30_000,
    deliveryMaxAttempts: 3,
  },
}

const events = []
const runtime = new CodexAppServerRuntime({
  config,
  betterSqlite3Path: args['better-sqlite3-path'],
  onEvent: (event, details) => events.push({
    time: new Date().toISOString(),
    event,
    details,
  }),
})
const service = new FederationBridgeService({
  config,
  runtime,
  driver: 'better-sqlite3',
  betterSqlite3Path: args['better-sqlite3-path'],
  autoWorkers: false,
})

let endpoint
try {
  await runtime.start()
  endpoint = await service.start()

  const approvePromise = runtime.run({
    agentId: 'phase5preflight',
    prompt:
      `A shell eszközzel futtasd pontosan ezt az egy parancsot:\n`
      + `printf %s PHASE5_APPROVED_OK > ${JSON.stringify(approvedPath)}\n`
      + 'A célútvonal szándékosan a workspace-en kívül van. '
      + 'Ha a sandbox blokkolja, kötelezően kérj emelt jogosultságú approvalt, '
      + 'majd jóváhagyás után futtasd újra ugyanazt a parancsot. '
      + 'Ne fogadd el végleges eredménynek a read-only vagy permission denied hibát. '
      + 'Ne használj más eszközt. Sikeres végrehajtás után a válaszod utolsó sora legyen: '
      + 'PHASE5_APPROVAL_APPROVE_OK',
    context: { test: 'phase5-real-approval-approve' },
    idempotencyKey: 'phase5-real-approval-approve',
  })
  const approveRun = runtime.state.getRun('phase5-real-approval-approve')
  const approval = await waitForApproval(
    endpoint.baseUrl,
    adminToken,
    approveRun.runId,
    runtime,
    'phase5-real-approval-approve',
  )
  await decide(endpoint.baseUrl, adminToken, approval.approvalId, 'approve')
  const approved = await approvePromise
  if (!existsSync(approvedPath)) throw new Error('approved canary was not created')
  if (runtime.getApproval(approval.approvalId).state !== 'approved') {
    throw new Error('approved decision was not stored')
  }

  const declinePromise = runtime.run({
    agentId: 'phase5preflight',
    prompt:
      `A shell eszközzel futtasd pontosan ezt az egy parancsot:\n`
      + `printf %s MUST_NOT_EXIST > ${JSON.stringify(declinedPath)}\n`
      + 'A célútvonal szándékosan a workspace-en kívül van. '
      + 'Ha a sandbox blokkolja, kötelezően kérj emelt jogosultságú approvalt. '
      + 'Ne próbálj más kerülőutat. Ha az approvalt elutasítják, ne hozd létre a fájlt, '
      + 'és válaszolj: PHASE5_APPROVAL_DECLINE_OK',
    context: { test: 'phase5-real-approval-decline' },
    idempotencyKey: 'phase5-real-approval-decline',
  })
  const declineRun = runtime.state.getRun('phase5-real-approval-decline')
  const declinedApproval = await waitForApproval(
    endpoint.baseUrl,
    adminToken,
    declineRun.runId,
    runtime,
    'phase5-real-approval-decline',
  )
  await decide(endpoint.baseUrl, adminToken, declinedApproval.approvalId, 'decline')
  await declinePromise
  if (existsSync(declinedPath)) throw new Error('declined canary was created')
  if (runtime.getApproval(declinedApproval.approvalId).state !== 'declined') {
    throw new Error('declined decision was not stored')
  }

  const dynamic = await runtime.run({
    agentId: 'phase5preflight',
    prompt:
      'Hívd meg pontosan egyszer a marveen_agent_message_send eszközt ezekkel: '
      + 'to="bela", content="PHASE5_DYNAMIC_MESSAGE_OK". '
      + 'Sikeres sorba állítás után válaszolj: PHASE5_DYNAMIC_TOOL_OK',
    context: { test: 'phase5-real-dynamic-tool' },
    idempotencyKey: 'phase5-real-dynamic-tool',
  })
  const dynamicOutbox = service.store.listOutbox().filter(
    (row) => row.content === 'PHASE5_DYNAMIC_MESSAGE_OK',
  )
  if (dynamicOutbox.length !== 1) {
    throw new Error(`expected one dynamic outbox item, found ${dynamicOutbox.length}`)
  }
  if (
    dynamicOutbox[0].from !== 'codex/phase5preflight'
    || dynamicOutbox[0].to !== 'bela'
  ) {
    throw new Error('dynamic message identity is incorrect')
  }

  const report = {
    result: 'PASS',
    model,
    expectedVersion,
    approvedRunId: approved.runId,
    declinedRunId: declineRun.runId,
    dynamicRunId: dynamic.runId,
    approvedApprovalId: approval.approvalId,
    declinedApprovalId: declinedApproval.approvalId,
    dynamicOutboxId: dynamicOutbox[0].outboxId,
    appServerGeneration: runtime.generation,
    events,
  }
  const reportPath = resolve(outputRoot, 'phase5-real-result.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write('PASS: real approval approve executed the controlled canary\n')
  process.stdout.write('PASS: real approval decline blocked the controlled canary\n')
  process.stdout.write('PASS: real dynamic tool queued exactly one identity-bound message\n')
  process.stdout.write(`Report: ${reportPath}\n`)
  process.stdout.write('RESULT: PHASE 5 REAL APPROVAL AND MESSAGE TOOL PASS\n')
} finally {
  runtime.prepareStop()
  if (endpoint && service.server.listening) await service.stop().catch(() => {})
  await runtime.stop().catch(() => {})
}
