import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  INBOX_MAX_BODY_BYTES,
  parseQualifiedId,
  startContractPeer,
  validateInbox,
  validateManifest,
} from '../src/federation-contract.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const TOKEN = 'phase-one-fixture-token-not-a-real-secret'

async function fixture(name) {
  return JSON.parse(await readFile(join(ROOT, 'fixtures', name), 'utf8'))
}

async function withPeer(run) {
  const peer = await startContractPeer({
    manifest: await fixture('manifest.good.json'),
    token: TOKEN,
    peerId: 'marveen',
  })
  try {
    await run(peer)
  } finally {
    await peer.close()
  }
}

async function request(peer, path, options = {}) {
  return fetch(`${peer.baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(options.headers ?? {}),
    },
  })
}

test('strict qualified addressing', () => {
  assert.deepEqual(parseQualifiedId('marveen/bela'), { system: 'marveen', agent: 'bela' })
  for (const invalid of ['bela', 'a/b/c', '../x', 'a/..', 'a/has space', 'a/árvíz']) {
    assert.equal(parseQualifiedId(invalid), null)
  }
})

test('Marveen accepts the Bridge manifest shape', async () => {
  const manifest = await fixture('manifest.good.json')
  assert.deepEqual(validateManifest(manifest, 'codex'), { ok: true })
  assert.equal(validateManifest(manifest, 'other').ok, false)
  assert.equal(validateManifest({ ...manifest, system: '../codex' }, '../codex').ok, false)
  assert.equal(validateManifest({ ...manifest, marveenVersion: '' }).ok, false)
  assert.equal(validateManifest({
    ...manifest,
    agents: [{ ...manifest.agents[0], displayName: 'x'.repeat(121) }],
  }).ok, false)
  assert.equal(validateManifest({
    ...manifest,
    skills: [{ ...manifest.skills[0], description: 'x'.repeat(301) }],
  }).ok, false)
})

test('manifest endpoint requires the peer token', async () => {
  await withPeer(async (peer) => {
    const missing = await fetch(`${peer.baseUrl}/api/federation/manifest`)
    assert.equal(missing.status, 401)
    const wrong = await fetch(`${peer.baseUrl}/api/federation/manifest`, {
      headers: { Authorization: 'Bearer definitely-wrong-token-value-12345' },
    })
    assert.equal(wrong.status, 401)
    const good = await request(peer, '/api/federation/manifest')
    assert.equal(good.status, 200)
    assert.equal((await good.json()).system, 'codex')
  })
})

test('exact Marveen wire payload is accepted and content remains verbatim', async () => {
  await withPeer(async (peer) => {
    const payload = await fixture('inbox.from-marveen.json')
    const response = await request(peer, '/api/federation/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { id: 1, ref: '187' })
    assert.equal(peer.accepted.length, 1)
    assert.deepEqual(peer.accepted[0], {
      id: 1,
      from: 'marveen/bela',
      to: 'programozo',
      content: 'Válaszolj pontosan ezzel: FEDERATION_CONTRACT_OK',
      ref: '187',
    })
  })
})

test('peer/ref dedup returns the original id and inserts once', async () => {
  await withPeer(async (peer) => {
    const payload = await fixture('inbox.from-marveen.json')
    const send = () => request(peer, '/api/federation/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const first = await send()
    const second = await send()
    assert.deepEqual(await first.json(), { id: 1, ref: '187' })
    assert.deepEqual(await second.json(), { id: 1, ref: '187', duplicate: true })
    assert.equal(peer.accepted.length, 1)
  })
})

test('sender impersonation and qualified target are rejected', async () => {
  const agents = new Set(['programozo'])
  assert.equal(validateInbox({
    federationVersion: 1,
    from: 'other/bela',
    to: 'programozo',
    content: 'x',
    ref: '1',
  }, { peerId: 'marveen', ownSystemId: 'codex', agents }).status, 403)
  assert.equal(validateInbox({
    federationVersion: 1,
    from: 'marveen/bela',
    to: 'codex/programozo',
    content: 'x',
    ref: '1',
  }, { peerId: 'marveen', ownSystemId: 'codex', agents }).status, 403)
})

test('unknown agent, invalid version, empty content and oversized ref are rejected', async () => {
  await withPeer(async (peer) => {
    const base = await fixture('inbox.from-marveen.json')
    const cases = [
      [{ ...base, to: 'missing' }, 404],
      [{ ...base, federationVersion: 2 }, 400],
      [{ ...base, content: '   ' }, 400],
      [{ ...base, ref: 'r'.repeat(129) }, 400],
    ]
    for (const [payload, expected] of cases) {
      const response = await request(peer, '/api/federation/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      assert.equal(response.status, expected)
    }
  })
})

test('invalid JSON and an actually oversized body return 400/413', async () => {
  await withPeer(async (peer) => {
    const invalid = await request(peer, '/api/federation/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    })
    assert.equal(invalid.status, 400)

    const oversized = await request(peer, '/api/federation/inbox', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(INBOX_MAX_BODY_BYTES) }),
    })
    assert.equal(oversized.status, 413)
  })
})
