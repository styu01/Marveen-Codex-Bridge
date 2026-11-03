import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import {
  CutoverApiError,
  disableFederation,
  enableFederation,
  normalizeLoopbackOrigin,
  preflightFederation,
  runFederationCanary,
} from '../src/federation-cutover-api.mjs'

function mockFederation({ paired = true } = {}) {
  const state = {
    enabled: false,
    routingMode: 'catalog-first',
    systemId: 'bela',
    peers: paired ? [{ id: 'codex' }] : [],
    calls: [],
  }
  const request = async (path, init = {}) => {
    state.calls.push({ path, ...init })
    if (path === '/api/federation/peers') {
      return {
        enabled: state.enabled,
        routingMode: state.routingMode,
        systemId: state.systemId,
        peers: state.peers,
      }
    }
    if (path === '/api/federation/routing-mode') {
      state.routingMode = init.body.mode
      return { ok: true }
    }
    if (path === '/api/federation/enabled') {
      state.enabled = init.body.enabled
      return { ok: true }
    }
    if (path === '/api/federation/apply') return { ok: true }
    throw new Error(`unexpected path ${path}`)
  }
  return { state, request }
}

test('cutover origin accepts loopback only', () => {
  assert.equal(normalizeLoopbackOrigin('http://127.0.0.1:3420/'), 'http://127.0.0.1:3420')
  assert.throws(
    () => normalizeLoopbackOrigin('https://127.0.0.1:3420'),
    (error) => error instanceof CutoverApiError && error.code === 'invalid_origin',
  )
  assert.throws(
    () => normalizeLoopbackOrigin('http://example.com:3420'),
    (error) => error instanceof CutoverApiError && error.code === 'invalid_origin',
  )
})

test('preflight is read-only, requires disabled Federation and can require peer', async () => {
  const missing = mockFederation({ paired: false })
  assert.deepEqual(
    await preflightFederation({ request: missing.request }),
    {
      enabled: false,
      systemId: 'bela',
      routingMode: 'catalog-first',
      peerPresent: false,
    },
  )
  assert.equal(missing.state.calls.length, 1)
  await assert.rejects(
    preflightFederation({ request: missing.request, requirePeer: true }),
    (error) => error.code === 'peer_missing',
  )
  missing.state.enabled = true
  await assert.rejects(
    preflightFederation({ request: missing.request }),
    (error) => error.code === 'already_enabled',
  )
})

test('enable validates peer, sets routing, enables, applies and verifies', async () => {
  const mock = mockFederation()
  const result = await enableFederation({
    request: mock.request,
    routingMode: 'advisory',
  })
  assert.deepEqual(result, { enabled: true, routingMode: 'advisory' })
  assert.deepEqual(
    mock.state.calls.map(({ path }) => path),
    [
      '/api/federation/peers',
      '/api/federation/routing-mode',
      '/api/federation/enabled',
      '/api/federation/apply',
      '/api/federation/peers',
    ],
  )
  assert.equal(mock.state.enabled, true)
  assert.equal(mock.state.routingMode, 'advisory')
})

test('disable persists the safety switch even if apply fails', async () => {
  const mock = mockFederation()
  mock.state.enabled = true
  const original = mock.request
  const request = async (path, init) => {
    if (path === '/api/federation/apply') throw new Error('restart unavailable')
    return original(path, init)
  }
  assert.deepEqual(await disableFederation({ request }), { enabled: false })
  assert.equal(mock.state.enabled, false)
})

test('canary requires a delivered federated original and exactly one exact reply', async () => {
  let polls = 0
  const request = async (path, init = {}) => {
    if (path === '/api/messages' && init.method === 'POST') {
      assert.equal(init.body.from, 'bela')
      assert.equal(init.body.to, 'codex/programozo')
      assert.match(init.body.content, /PHASE7_CANARY_OK/)
      return { id: 51 }
    }
    if (path.startsWith('/api/messages?')) {
      polls += 1
      if (polls === 1) {
        return [{
          id: 51,
          from_agent: 'bela',
          to_agent: 'codex/programozo',
          status: 'delivered',
        }]
      }
      return [
        {
          id: 51,
          from_agent: 'bela',
          to_agent: 'codex/programozo',
          status: 'delivered',
        },
        {
          id: 52,
          from_agent: 'codex/programozo',
          to_agent: 'bela',
          content: 'PHASE7_CANARY_OK',
        },
      ]
    }
    throw new Error(`unexpected ${path}`)
  }
  assert.deepEqual(
    await runFederationCanary({
      request,
      mainAgentId: 'bela',
      marker: 'PHASE7_CANARY_OK',
      pollIntervalMs: 1,
      timeoutMs: 100,
    }),
    { messageId: 51, replyId: 52, marker: 'PHASE7_CANARY_OK' },
  )
})

test('canary rejects duplicate exact replies', async () => {
  const request = async (path) => {
    if (path === '/api/messages') return { id: 51 }
    return [
      { id: 51, status: 'delivered' },
      {
        id: 52,
        from_agent: 'codex/programozo',
        to_agent: 'bela',
        content: 'PHASE7_DUPLICATE_OK',
      },
      {
        id: 53,
        from_agent: 'codex/programozo',
        to_agent: 'bela',
        content: 'PHASE7_DUPLICATE_OK',
      },
    ]
  }
  await assert.rejects(
    runFederationCanary({
      request,
      mainAgentId: 'bela',
      marker: 'PHASE7_DUPLICATE_OK',
      pollIntervalMs: 1,
      timeoutMs: 100,
    }),
    (error) => error.code === 'duplicate_canary_reply',
  )
})

test('cutover script keeps rollback and independence invariants', () => {
  const source = readFileSync(resolve('scripts/cutover-phase7.sh'), 'utf8')
  const installer = readFileSync(resolve('scripts/install-phase7.sh'), 'utf8')
  const recovery = readFileSync(
    resolve('scripts/recover-phase7.5-failed-cutover.sh'),
    'utf8',
  )
  const verifier = readFileSync(resolve('scripts/verify-phase7.sh'), 'utf8')
  const historicalVerifiers = [2, 3, 4, 5].map((phase) => (
    readFileSync(resolve(`scripts/verify-phase${phase}.sh`), 'utf8')
  ))
  assert.match(source, /Without --execute this command is a read-only preflight/)
  assert.match(source, /ROLLBACK: disabling Federation first/)
  assert.match(source, /federation-cutover-api\.mjs" \\\n\s+disable/)
  assert.match(source, /stash push --include-untracked/)
  assert.match(source, /stash apply "\$\{STASH_COMMIT\}"/)
  assert.match(source, /node_modules-before-cutover/)
  assert.match(source, /dist-before-cutover/)
  assert.match(source, /dist-failed-candidate/)
  assert.match(source, /mv -- "\$\{MARVEEN_ROOT\}\/dist" "\$\{OLD_DIST\}"/)
  assert.match(source, /mv -- "\$\{OLD_DIST\}" "\$\{MARVEEN_ROOT\}\/dist"/)
  assert.match(source, /systemctl --user disable --now bela-codex-bridge\.service/)
  assert.match(source, /systemctl --user enable --now bela-codex-bridge\.service/)
  assert.ok(
    source.indexOf('systemctl --user disable --now bela-codex-bridge.service')
      < source.indexOf('git -C "${MARVEEN_ROOT}" stash push --include-untracked'),
    'the real systemd smoke test must happen before Marveen mutation',
  )
  assert.ok(
    source.indexOf('standalone Bridge passed the real systemd sandbox before Marveen mutation')
      < source.indexOf('git -C "${MARVEEN_ROOT}" stash push --include-untracked'),
    'readiness must be proven before the production checkout is stashed',
  )
  const liveInstallerCall = source.slice(
    source.indexOf('"${SOURCE_ROOT}/scripts/install-phase7.sh"'),
    source.indexOf('standalone Bridge passed the real systemd sandbox'),
  )
  assert.match(liveInstallerCall, /--activate/)
  assert.match(liveInstallerCall, /--skip-tests/)
  assert.doesNotMatch(
    liveInstallerCall,
    /--skip-dependencies/,
    'production cutover must install the immutable release dependencies',
  )
  assert.match(
    source,
    /if \[\[ "\$\{MARVEEN_SWITCHED\}" -eq 1 \]\]; then\n    echo "ROLLBACK: disabling Federation first"/,
  )
  assert.match(source, /PAIRING_CREATED/)
  assert.match(source, /--rollback/)
  assert.match(
    readFileSync(resolve('scripts/pair-marveen-phase6.2.mjs'), 'utf8'),
    /summarizeMarveenPairing\(result\)/,
  )
  assert.match(source, /reconcile-bridge-peer\.mjs/)
  assert.match(source, /bridge-config-before-peer-reconcile\.json/)
  assert.match(
    source,
    /install -m 0600 "\$\{BRIDGE_CONFIG_BACKUP\}" "\$\{BRIDGE_CONFIG\}"/,
  )
  assert.ok(
    source.indexOf('Bridge peer identity matches the Marveen Federation systemId')
      < source.indexOf('federation-cutover-api.mjs" \\\n  enable'),
    'peer identity must be reconciled before Federation is enabled',
  )
  assert.match(source, /rollback_verified/)
  assert.match(source, /EXPECTED_MARVEEN_VERSION="1\.25\.1"/)
  assert.match(source, /LEGACY_MARVEEN_VERSION="1\.21\.1"/)
  assert.match(source, /candidate is not Marveen \$\{EXPECTED_MARVEEN_VERSION\}/)
  assert.match(source, /\$\{PHASE0_ROOT\}\/MANIFEST\.json/)
  assert.doesNotMatch(source, /\$\{PHASE0_ROOT\}\/manifest\.json/)
  assert.match(source, /\$\{PHASE0_ROOT\}\/SHA256SUMS/)
  assert.match(source, /sha256sum -c -- SHA256SUMS/)
  assert.match(source, /Phase 0 checkpoint checksum verification failed/)
  assert.match(
    source,
    /git -C "\$\{MARVEEN_ROOT\}" bundle verify "\$\{BUNDLE\}"/,
  )
  assert.doesNotMatch(source, /^git bundle verify/m)
  assert.match(source, /CURRENT_MARVEEN_VERSION/)
  assert.match(source, /HEAD:src\/web\/routes\/federation\.ts/)
  assert.match(source, /legacy Marveen \$\{LEGACY_MARVEEN_VERSION\} has no Federation route/)
  assert.match(source, /current Marveen Federation state cannot be proven disabled/)
  assert.match(source, /dist\/web\/routes\/federation\.js/)
  assert.match(source, /dist\/src\/web\/routes\/federation\.js/)
  assert.match(source, /dist\/providers\/codex-provider\.js/)
  assert.match(
    installer,
    /\['@RELEASE_ROOT@', releaseRoot\]/,
  )
  assert.match(
    installer,
    /\['@BETTER_SQLITE3_PATH@', betterSqlite3Path\]/,
  )
  assert.match(installer, /\['@CONFIG_ROOT@', configRoot\]/)
  assert.match(installer, /ReadWritePaths=\$\{unitPath\(agent\.workspacePath\)\}/)
  assert.match(installer, /render_unit "\$\{RELEASE_ROOT\}" "\$\{UNIT_PATH\}\.candidate"/)
  assert.match(installer, /systemctl --user restart marveen-codex-bridge\.service/)
  assert.match(installer, /mv -f "\$\{UNIT_PATH\}\.rollback" "\$\{UNIT_PATH\}"/)
  assert.doesNotMatch(
    installer,
    /s\|@RELEASE_ROOT@\|\$\{CURRENT_LINK\}\|g/,
  )
  assert.match(recovery, /HYBRID-DIST RECOVERY PREFLIGHT PASS \(NO MUTATION\)/)
  assert.match(recovery, /dist-hybrid-phase7\.5/)
  assert.match(recovery, /CLEAN DIST RECOVERY FAILED; ORIGINAL DIST RESTORED/)
  assert.doesNotMatch(recovery, /\brm\s+-rf\b/)
  assert.doesNotMatch(source, /1\.25\.0/)
  assert.match(source, /PHASE 7 PRODUCTION CUTOVER PASS/)
  assert.doesNotMatch(source, /git reset --hard/)
  assert.doesNotMatch(source, /git clean -/)
  assert.doesNotMatch(source, /patch -p/)
  assert.doesNotMatch(
    source,
    /\b(?:sed|perl|python3?)\b[^\n]*src\/web\/|web\/app\.js.*replace/,
  )
  assert.match(verifier, /tests 151\$/)
  assert.match(verifier, /pass 151\$/)
  assert.match(verifier, /all 151 Phase 1-7/)
  assert.doesNotMatch(verifier, /expected exactly 105/)
  for (const historical of historicalVerifiers) {
    assert.match(historical, /DEPRECATED:/)
    assert.match(historical, /verify-phase7\.sh/)
    assert.doesNotMatch(historical, /expected exactly \d+ tests/)
  }
})

test('Phase 0 gate requires canonical MANIFEST.json and verifies SHA256SUMS', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phase7-phase0-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marveen = join(root, 'marveen')
  const phase0 = join(root, 'phase0')
  const privateDir = join(phase0, 'private')
  const bin = join(root, 'bin')
  mkdirSync(join(marveen, '.git'), { recursive: true })
  mkdirSync(privateDir, { recursive: true })
  mkdirSync(bin)
  const fakeId = join(bin, 'id')
  writeFileSync(fakeId, `#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then echo "1000"; exit 0; fi
exec /usr/bin/id "$@"
`)
  chmodSync(fakeId, 0o755)

  const files = [
    'MANIFEST.json',
    'private/marveen-source-checkpoint.tar.gz',
    'private/marveen-runtime-backup.tar.gz',
    'private/legacy-bridge-backup.tar.gz',
    'diagnostics-safe.tar.gz',
  ]
  for (const path of files) {
    writeFileSync(join(phase0, path), `${path}\n`)
  }
  const checksum = (path) => createHash('sha256')
    .update(readFileSync(join(phase0, path)))
    .digest('hex')
  writeFileSync(
    join(phase0, 'SHA256SUMS'),
    files.map((path) => `${checksum(path)}  ${path}`).join('\n') + '\n',
  )

  const bundle = join(root, 'candidate.bundle')
  writeFileSync(bundle, 'not-a-real-bundle\n')
  writeFileSync(
    `${bundle}.sha256`,
    `${createHash('sha256').update(readFileSync(bundle)).digest('hex')}  candidate.bundle\n`,
  )
  const run = () => spawnSync('bash', [
    resolve('scripts/cutover-phase7.sh'),
    '--marveen-root', marveen,
    '--phase0-root', phase0,
    '--candidate-commit', 'deadbee',
    '--bundle', bundle,
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })

  const canonical = run()
  assert.equal(canonical.status, 1)
  assert.match(
    canonical.stdout,
    /PASS: Phase 0 manifest and checkpoint checksums are verified/,
  )
  assert.match(canonical.stderr, /candidate bundle is invalid/)

  writeFileSync(
    join(phase0, 'manifest.json'),
    readFileSync(join(phase0, 'MANIFEST.json')),
  )
  rmSync(join(phase0, 'MANIFEST.json'))
  const wrongCase = run()
  assert.equal(wrongCase.status, 1)
  assert.match(wrongCase.stderr, /verified Phase 0 manifest is missing/)

  writeFileSync(join(phase0, 'MANIFEST.json'), 'MANIFEST.json\n')
  rmSync(join(phase0, 'manifest.json'))
  writeFileSync(
    join(phase0, 'private/marveen-source-checkpoint.tar.gz'),
    'tampered\n',
  )
  const tampered = run()
  assert.equal(tampered.status, 1)
  assert.match(
    tampered.stderr,
    /Phase 0 checkpoint checksum verification failed/,
  )
})
