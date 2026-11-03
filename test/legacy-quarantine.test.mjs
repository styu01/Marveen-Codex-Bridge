import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return result.stdout.trim()
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'phase62-quarantine-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const marveen = join(root, 'marveen')
  const phase0 = join(root, 'phase0')
  const state = join(root, 'state')
  const adapterPaths = join(root, 'adapter-paths.txt')
  mkdirSync(marveen)
  mkdirSync(join(phase0, 'private'), { recursive: true })
  writeFileSync(join(phase0, 'private/marveen-source-checkpoint.tar.gz'), 'checkpoint')
  writeFileSync(join(phase0, 'private/marveen-runtime-backup.tar.gz'), 'runtime')
  writeFileSync(join(marveen, 'package.json'), '{"version":"1.21.1"}\n')
  writeFileSync(join(marveen, '.gitignore'), 'store/\n')
  writeFileSync(join(marveen, 'tracked.ts'), 'original\n')
  writeFileSync(join(marveen, 'personal-staged.md'), 'original staged\n')
  writeFileSync(join(marveen, 'personal-mixed.md'), 'original mixed\n')
  git(marveen, ['init'])
  git(marveen, ['config', 'user.name', 'Phase Test'])
  git(marveen, ['config', 'user.email', 'phase@example.invalid'])
  git(marveen, [
    'add',
    'package.json',
    '.gitignore',
    'tracked.ts',
    'personal-staged.md',
    'personal-mixed.md',
  ])
  git(marveen, ['commit', '-m', 'baseline'])
  const head = git(marveen, ['rev-parse', 'HEAD'])
  writeFileSync(join(marveen, 'tracked.ts'), 'adapter change\n')
  writeFileSync(join(marveen, 'codex-provider.ts'), 'untracked adapter\n')
  writeFileSync(join(marveen, 'personal-staged.md'), 'personal staged\n')
  git(marveen, ['add', 'personal-staged.md'])
  writeFileSync(join(marveen, 'personal-mixed.md'), 'personal staged version\n')
  git(marveen, ['add', 'personal-mixed.md'])
  writeFileSync(join(marveen, 'personal-mixed.md'), 'personal worktree version\n')
  writeFileSync(join(marveen, 'personal-untracked.md'), 'personal untracked\n')
  writeFileSync(adapterPaths, 'tracked.ts\ncodex-provider.ts\n')
  mkdirSync(join(marveen, 'store'))
  writeFileSync(join(marveen, 'store/runtime.sqlite3'), 'runtime sentinel\n')
  return { root, marveen, phase0, state, adapterPaths, head }
}

test('legacy quarantine preflight is read-only', (t) => {
  const item = fixture(t)
  const before = git(item.marveen, ['status', '--porcelain=v1', '--untracked-files=all'])
  const result = spawnSync('bash', [
    resolve('scripts/quarantine-legacy-marveen.sh'),
    '--marveen-root', item.marveen,
    '--phase0-root', item.phase0,
    '--state-root', item.state,
    '--adapter-paths-file', item.adapterPaths,
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /PREFLIGHT PASS \(NO MUTATION\)/)
  assert.equal(git(item.marveen, ['status', '--porcelain=v1', '--untracked-files=all']), before)
  assert.equal(existsSync(item.state), false)
})

test('legacy quarantine stashes only adapter paths and preserves all other source state', (t) => {
  const item = fixture(t)
  const preservedBefore = git(item.marveen, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    '.',
    ':(exclude)tracked.ts',
    ':(exclude)codex-provider.ts',
  ])
  const result = spawnSync('bash', [
    resolve('scripts/quarantine-legacy-marveen.sh'),
    '--marveen-root', item.marveen,
    '--phase0-root', item.phase0,
    '--state-root', item.state,
    '--adapter-paths-file', item.adapterPaths,
    '--execute',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /LEGACY ADAPTER SELECTIVELY QUARANTINED/)
  assert.equal(
    git(item.marveen, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      '.',
      ':(exclude)tracked.ts',
      ':(exclude)codex-provider.ts',
    ]),
    preservedBefore,
  )
  assert.equal(
    git(item.marveen, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--',
      'tracked.ts',
      'codex-provider.ts',
    ]),
    '',
  )
  assert.equal(git(item.marveen, ['rev-parse', 'HEAD']), item.head)
  assert.equal(readFileSync(join(item.marveen, 'tracked.ts'), 'utf8'), 'original\n')
  assert.equal(existsSync(join(item.marveen, 'codex-provider.ts')), false)
  assert.equal(readFileSync(join(item.marveen, 'personal-staged.md'), 'utf8'), 'personal staged\n')
  assert.equal(readFileSync(join(item.marveen, 'personal-mixed.md'), 'utf8'), 'personal worktree version\n')
  assert.equal(readFileSync(join(item.marveen, 'personal-untracked.md'), 'utf8'), 'personal untracked\n')
  assert.equal(readFileSync(join(item.marveen, 'store/runtime.sqlite3'), 'utf8'), 'runtime sentinel\n')
  assert.match(git(item.marveen, ['stash', 'list']), /marveen-codex-bridge-legacy-quarantine-/)
  assert.equal(existsSync(item.state), true)
})
