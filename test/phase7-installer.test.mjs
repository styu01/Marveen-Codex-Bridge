import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

test('Phase 7 prepare-only installer creates an isolated candidate and never touches Marveen', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phase7-installer-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const marveen = join(home, 'marveen')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(marveen)
  const sentinel = join(marveen, 'DO-NOT-TOUCH')
  writeFileSync(sentinel, 'marveen-source-unchanged\n')

  const fakeCodex = join(bin, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 0.164.0"; exit 0; fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  echo "Logged in using ChatGPT"; exit 0
fi
exit 1
`)
  chmodSync(fakeCodex, 0o755)
  const fakeNode = join(bin, 'node22')
  writeFileSync(fakeNode, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "v22.23.1"; exit 0; fi
exec "${process.execPath}" "$@"
`)
  chmodSync(fakeNode, 0o755)
  const fakeId = join(bin, 'id')
  writeFileSync(fakeId, `#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then echo "1000"; exit 0; fi
exec /usr/bin/id "$@"
`)
  chmodSync(fakeId, 0o755)

  const result = spawnSync('bash', [
    resolve('scripts/install-phase7.sh'),
    '--node-bin', fakeNode,
    '--codex-bin', fakeCodex,
    '--prepare-only',
    '--skip-dependencies',
    '--skip-tests',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_DATA_HOME: join(home, '.local/share'),
      CODEX_HOME: join(home, '.codex'),
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PHASE 7 PREPARED \(NOT ACTIVATED\)/)
  assert.equal(readFileSync(sentinel, 'utf8'), 'marveen-source-unchanged\n')

  const data = join(home, '.local/share/marveen-codex-bridge')
  const candidate = join(data, 'candidate')
  assert.equal(lstatSync(candidate).isSymbolicLink(), true)
  assert.match(readlinkSync(candidate), /0\.3\.4$/)
  assert.equal(existsSync(join(data, 'current')), false)
  assert.equal(
    JSON.parse(readFileSync(join(
      data,
      'releases/0.3.4/package.json',
    ))).version,
    '0.3.4',
  )
  const configRoot = join(home, '.config/marveen-codex-bridge')
  assert.equal(lstatSync(join(configRoot, 'config.json')).mode & 0o777, 0o600)
  const installedConfig = JSON.parse(readFileSync(join(configRoot, 'config.json'), 'utf8'))
  assert.deepEqual(installedConfig.codex.allowedModels, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"])
  assert.equal(installedConfig.agents[0].reasoningEffort, 'high')
  assert.match(installedConfig.agents[0].developerInstructions, /Codex programozó/)
  assert.match(installedConfig.agents[0].developerInstructions, /marveen_agent_message_send/)
  assert.equal(lstatSync(join(configRoot, 'marveen-pairing.env')).mode & 0o777, 0o600)
  const unitPath = join(
    home,
    '.config/systemd/user/marveen-codex-bridge.service.candidate',
  )
  const unit = readFileSync(
    unitPath,
    'utf8',
  )
  assert.equal(existsSync(join(
    home,
    '.config/systemd/user/marveen-codex-bridge.service',
  )), false)
  assert.doesNotMatch(unit, /bela-codex-bridge/)
  assert.match(
    unit,
    /releases\/0\.3\.4\/src\/main\.mjs/,
  )
  assert.match(
    unit,
    /MARVEEN_CODEX_BRIDGE_RUNTIME_MODULE=.*releases\/0\.3\.4\/src\/codex-runtime-module\.mjs/,
  )
  assert.match(
    unit,
    /MARVEEN_CODEX_BRIDGE_BETTER_SQLITE3_PATH=.*releases\/0\.3\.4\/node_modules\/better-sqlite3/,
  )
  assert.match(unit, /Environment=CODEX_HOME=.*\/\.codex/)
  assert.match(unit, /ReadWritePaths=.*\/\.config\/marveen-codex-bridge/)
  assert.match(unit, /ReadWritePaths=.*\/\.codex/)
  assert.match(unit, /ReadOnlyPaths=.*admin\.token.*marveen-inbound\.token.*marveen-outbound\.token/)
  assert.doesNotMatch(unit, /marveen-codex-bridge\/current/)
  const installer = readFileSync(resolve('scripts/install-phase7.sh'), 'utf8')
  const verifier = readFileSync(resolve('scripts/verify-phase7.sh'), 'utf8')
  assert.match(verifier, /--test-concurrency=1/)
  assert.ok(
    installer.indexOf('systemctl --user reset-failed marveen-codex-bridge.service')
      < installer.indexOf('systemctl --user restart marveen-codex-bridge.service'),
    'a prior failed release must not leave the activation start-limited',
  )
  assert.match(installer, /mv -f "\$\{UNIT_PATH\}\.rollback" "\$\{UNIT_PATH\}"/)
  assert.match(
    installer,
    /mv -f "\$\{UNIT_PATH\}\.rollback" "\$\{UNIT_PATH\}"[\s\S]*reset-failed marveen-codex-bridge\.service[\s\S]*ROLLBACK_READY/,
  )

  const legacyConfigPath = join(configRoot, 'config.json')
  const legacyConfig = JSON.parse(readFileSync(legacyConfigPath, 'utf8'))
  const externalWorkspace = join(home, 'projects/programozo')
  mkdirSync(externalWorkspace, { recursive: true })
  delete legacyConfig.codex.allowedModels
  legacyConfig.agents[0].workspacePath = externalWorkspace
  legacyConfig.agents[0].developerInstructions = 'Megőrzendő 0.3.1 production szerepkör.'
  writeFileSync(legacyConfigPath, `${JSON.stringify(legacyConfig, null, 2)}\n`, {
    mode: 0o600,
  })
  chmodSync(legacyConfigPath, 0o600)

  const installedRelease = join(data, 'releases/0.3.4')
  const staleMarker = join(installedRelease, 'STALE-CANDIDATE')
  writeFileSync(staleMarker, 'must be replaced\n')
  const replacement = spawnSync('bash', [
    resolve('scripts/install-phase7.sh'),
    '--node-bin', fakeNode,
    '--codex-bin', fakeCodex,
    '--prepare-only',
    '--skip-dependencies',
    '--skip-tests',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_DATA_HOME: join(home, '.local/share'),
      CODEX_HOME: join(home, '.codex'),
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
  assert.equal(replacement.status, 0, `${replacement.stdout}\n${replacement.stderr}`)
  assert.match(replacement.stdout, /Superseded inactive release retained at:/)
  assert.equal(existsSync(staleMarker), false)
  const preservedLegacyConfig = JSON.parse(readFileSync(legacyConfigPath, 'utf8'))
  assert.equal(preservedLegacyConfig.codex.allowedModels, undefined)
  assert.equal(preservedLegacyConfig.agents[0].workspacePath, externalWorkspace)
  assert.equal(
    preservedLegacyConfig.agents[0].developerInstructions,
    'Megőrzendő 0.3.1 production szerepkör.',
  )
  assert.ok(
    readdirSync(join(data, 'releases'))
      .some((name) => name.startsWith('.0.3.4.superseded.')),
  )
  const replacementUnit = readFileSync(unitPath, 'utf8')
  assert.match(
    replacementUnit,
    new RegExp(`ReadWritePaths=${JSON.stringify(externalWorkspace).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  )
})

test('Phase 7 dependency lifecycle PATH is pinned to the selected Node 22 bin', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phase7-node-path-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const commandBin = join(root, 'commands')
  const nodeBin = join(root, 'node22/bin')
  const npmDir = join(root, 'node22/lib/node_modules/npm/bin')
  mkdirSync(home, { recursive: true })
  mkdirSync(commandBin, { recursive: true })
  mkdirSync(nodeBin, { recursive: true })
  mkdirSync(npmDir, { recursive: true })

  const nodeWrapper = join(nodeBin, 'node')
  writeFileSync(nodeWrapper, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "v22.23.1"; exit 0; fi
exec "${process.execPath}" "$@"
`)
  chmodSync(nodeWrapper, 0o755)
  const pathCapture = join(root, 'npm-path.txt')
  writeFileSync(join(npmDir, 'npm-cli.js'), `
require('node:fs').writeFileSync(process.env.PHASE6_PATH_CAPTURE, process.env.PATH)
`)

  const fakeCodex = join(commandBin, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 0.164.0"; exit 0; fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  echo "Logged in using ChatGPT"; exit 0
fi
exit 1
`)
  chmodSync(fakeCodex, 0o755)
  const fakeId = join(commandBin, 'id')
  writeFileSync(fakeId, `#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then echo "1000"; exit 0; fi
exec /usr/bin/id "$@"
`)
  chmodSync(fakeId, 0o755)

  const result = spawnSync('bash', [
    resolve('scripts/install-phase7.sh'),
    '--node-bin', nodeWrapper,
    '--codex-bin', fakeCodex,
    '--prepare-only',
    '--skip-tests',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_DATA_HOME: join(home, '.local/share'),
      CODEX_HOME: join(home, '.codex'),
      PATH: `${commandBin}:${process.env.PATH}`,
      PHASE6_PATH_CAPTURE: pathCapture,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(readFileSync(pathCapture, 'utf8').split(':')[0], nodeBin)
})

test('Phase 7 installer rejects a symbolic-link CODEX_HOME', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'phase7-codex-home-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const redirected = join(root, 'redirected-codex-home')
  mkdirSync(home)
  mkdirSync(bin)
  mkdirSync(redirected)
  symlinkSync(redirected, join(home, '.codex'))

  const fakeCodex = join(bin, 'codex')
  writeFileSync(fakeCodex, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "codex-cli 0.164.0"; exit 0; fi
if [[ "\${1:-}" == "login" && "\${2:-}" == "status" ]]; then
  echo "Logged in using ChatGPT"; exit 0
fi
exit 1
`)
  chmodSync(fakeCodex, 0o755)
  const fakeNode = join(bin, 'node22')
  writeFileSync(fakeNode, `#!/usr/bin/env bash
if [[ "\${1:-}" == "--version" ]]; then echo "v22.23.1"; exit 0; fi
exec "${process.execPath}" "$@"
`)
  chmodSync(fakeNode, 0o755)
  const fakeId = join(bin, 'id')
  writeFileSync(fakeId, `#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then echo "1000"; exit 0; fi
exec /usr/bin/id "$@"
`)
  chmodSync(fakeId, 0o755)

  const result = spawnSync('bash', [
    resolve('scripts/install-phase7.sh'),
    '--node-bin', fakeNode,
    '--codex-bin', fakeCodex,
    '--prepare-only',
    '--skip-dependencies',
    '--skip-tests',
  ], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_STATE_HOME: join(home, '.local/state'),
      XDG_DATA_HOME: join(home, '.local/share'),
      CODEX_HOME: join(home, '.codex'),
      PATH: `${bin}:${process.env.PATH}`,
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /CODEX_HOME must be a real directory, not a symlink/)
})
