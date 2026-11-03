#!/usr/bin/env node
import { createHash } from 'node:crypto'
import {
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

const args = parseArgs(process.argv.slice(2))
for (const required of ['codex-bin', 'better-sqlite3-path', 'output-root']) {
  if (!args[required]) throw new Error(`--${required} is required`)
}

const outputRoot = resolve(args['output-root'])
const runtimeRoot = resolve(outputRoot, 'runtime')
const workspacePath = resolve(outputRoot, 'workspace')
const database = resolve(outputRoot, 'state', 'federation.sqlite3')
mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
mkdirSync(workspacePath, { recursive: true, mode: 0o700 })

const model = args.model ?? 'gpt-5.6-terra'
const expectedVersion = args['expected-version'] ?? '0.164.0'
const adminToken = 'phase52-real-admin-token-00000000000000000000000'
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
    turnTimeoutMs: 900_000,
    approvalTimeoutMs: 300_000,
    imageGenerationRequired: true,
    imageModel: 'gpt-image-2',
    artifactMaxBytes: 20 * 1024 * 1024,
    imageMaxPixels: 16_777_216,
  },
  admin: { token: adminToken },
  agents: [{
    id: 'phase52image',
    displayName: 'Phase 5.2 image preflight',
    model,
    capabilitySummary: 'Disposable GPT image pipeline verification.',
    workspacePath,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    reasoningEffort: 'high',
    networkEnabled: false,
    federationPeer: 'marveen',
    developerInstructions:
      'This is a controlled image-generation preflight. Generate one original image, '
      + 'save the final PNG inside the workspace, verify it is exactly 1024x1024, '
      + 'then call marveen_image_artifact_register exactly once with its relative path. '
      + 'Do not use an API key, external network request or workspace-external final path.',
  }],
  peers: [{
    id: 'marveen',
    baseUrl: new URL('http://127.0.0.1:9'),
    inboundToken: 'phase52-real-inbound-token-000000000000000000000',
    outboundToken: 'phase52-real-outbound-token-00000000000000000000',
  }],
  workers: {
    intervalMs: 60_000,
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
  if (runtime.capabilities().imageGeneration.available !== true) {
    throw new Error('runtime did not expose the required image-generation capability')
  }
  const run = await runtime.run({
    agentId: 'phase52image',
    prompt:
      '$imagegen Készíts egy eredeti, négyzetes technológiai absztrakt képet '
      + 'sötétkék háttérrel és finom türkiz fényekkel, ember és felirat nélkül. '
      + 'A végleges kép pontosan 1024x1024 képpontos PNG legyen. '
      + 'Mentsd az assets/phase52-imagegen-preflight.png fájlba. '
      + 'A végleges fájl ellenőrzése után hívd meg pontosan egyszer a '
      + 'marveen_image_artifact_register eszközt a workspace-relatív útvonallal. '
      + 'A válaszod utolsó sora pontosan ez legyen: PHASE52_IMAGEGEN_OK',
    context: {
      test: 'phase52-real-imagegen',
      imageGeneration: true,
    },
    idempotencyKey: 'phase52-real-imagegen',
  })
  if (!run.response.trim().endsWith('PHASE52_IMAGEGEN_OK')) {
    throw new Error(`unexpected image response: ${JSON.stringify(run.response)}`)
  }
  if (run.artifacts.length !== 1) {
    throw new Error(`expected one image artifact, received ${run.artifacts.length}`)
  }
  const artifact = run.artifacts[0]
  if (
    artifact.workspaceRelativePath !== 'assets/phase52-imagegen-preflight.png'
    || artifact.mimeType !== 'image/png'
    || artifact.width !== 1024
    || artifact.height !== 1024
  ) {
    throw new Error(`unexpected artifact metadata: ${JSON.stringify(artifact)}`)
  }
  const response = await fetch(
    `${endpoint.baseUrl}/v1/artifacts/${artifact.artifactId}/content`,
    { headers: { authorization: `Bearer ${adminToken}` } },
  )
  if (!response.ok) throw new Error(`artifact content returned HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256 || bytes.length !== artifact.byteSize) {
    throw new Error('artifact API bytes do not match persisted metadata')
  }
  const report = {
    result: 'PASS',
    model,
    imageModel: runtime.capabilities().imageGeneration.model,
    expectedVersion,
    runId: run.runId,
    response: run.response,
    artifact,
    contentSha256: digest,
    events,
  }
  const reportPath = resolve(outputRoot, 'phase52-real-imagegen-result.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  process.stdout.write('PASS: real GPT image generation completed through ChatGPT login\n')
  process.stdout.write('PASS: final 1024x1024 PNG was registered from inside the agent workspace\n')
  process.stdout.write('PASS: immutable artifact API bytes match size and SHA-256 metadata\n')
  process.stdout.write(`Artifact: ${artifact.workspaceRelativePath}\n`)
  process.stdout.write(`Report: ${reportPath}\n`)
  process.stdout.write('RESULT: PHASE 5.2 REAL IMAGEGEN AND ARTIFACT PASS\n')
} finally {
  runtime.prepareStop()
  if (endpoint && service.server.listening) await service.stop().catch(() => {})
  await runtime.stop().catch(() => {})
}
