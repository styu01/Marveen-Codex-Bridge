import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BRIDGE_ALLOWED_MODELS, effortsForModel, isValidModelEffort } from '../src/model-policy.mjs'

const six = ['gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']
const additions = ['gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra']
const script = resolve('scripts/migrate-models-0.3.5.mjs')
function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-035-models-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const src = join(root, 'config.json'), dst = join(root, 'migrated.json')
  const base = {
    version: 1, systemId: 'codex', listen: {host:'127.0.0.1',port:3431},
    storage: { database:'/tmp/example.db' },
    codex: {expectedVersion:'0.164.0',binary:'/old/codex',allowedModels:[...six],turnTimeoutMs:2_700_000,imageModel:'gpt-image-2'},
    workers: {runtimeLeaseMs:2_700_000,intervalMs:250},
    agents: [{id:'programozo',model:'gpt-6.1-sol',reasoningEffort:'medium',approvalPolicy:'manual',sandboxMode:'workspace-write',developerInstructions:'VERBATIM'}],
    peers: [{id:'marveen',outboundTokenFile:'/secret/token'}],
    admin: {tokenFile:'/secret/admin'}
  }
  const save = (v = base) => {writeFileSync(src,JSON.stringify(v)+'\n',{mode:0o600});chmodSync(src,0o600)}
  const run = (bin='/new/codex') => spawnSync(process.execPath,[script,src,bin,dst],{encoding:'utf8'})
  return {root,src,dst,base,save,run}
}
test('0.3.5 catalogs nine models, retaining the original six in order',()=>{
  assert.deepEqual(BRIDGE_ALLOWED_MODELS,[...six,...additions]);assert.equal(new Set(BRIDGE_ALLOWED_MODELS).size,9)
  assert.ok(Object.isFrozen(BRIDGE_ALLOWED_MODELS))
})
test('new model efforts are model-specific; none only on Terra',()=>{
  assert.deepEqual(effortsForModel('gpt-6.1-terra'),['none','low','medium','high','xhigh','max'])
  for(const model of additions.slice(1)){
    assert.deepEqual(effortsForModel(model),['low','medium','high','xhigh','max'])
    assert.equal(isValidModelEffort(model,'none'),false)
    assert.equal(isValidModelEffort(model,'ultra',{existingConfig:true}),false)
  }
  assert.equal(isValidModelEffort('gpt-6.1-terra','high'),true)
  assert.equal(isValidModelEffort('gpt-6.1-terra','none'),true)
})
test('the existing six models retain their previous effort rules',()=>{
  for(const model of six){assert.equal(isValidModelEffort(model,'medium'),true)}
  assert.equal(isValidModelEffort('gpt-5.6-terra','ultra',{existingConfig:true}),true)
  assert.equal(isValidModelEffort('gpt-6.1-sol','none'),false)
  assert.equal(isValidModelEffort('gpt-6-luna','none'),true)
})
test('migration is additive and changes only CLI pin, binary and allowed list',t=>{
  const env=environment(t);env.save();const snapshot=readFileSync(env.src)
  const r=env.run();assert.equal(r.status,0,r.stderr);assert.deepEqual(readFileSync(env.src),snapshot)
  const after=JSON.parse(readFileSync(env.dst))
  const other=structuredClone(env.base);delete other.codex.binary;delete other.codex.expectedVersion;delete other.codex.allowedModels
  const without=structuredClone(after);delete without.codex.binary;delete without.codex.expectedVersion;delete without.codex.allowedModels
  assert.deepEqual(without,other);assert.deepEqual(after.codex.allowedModels,[...six,...additions]);
  assert.equal(after.codex.binary,'/new/codex');assert.equal(after.codex.expectedVersion,'0.171.0')
  assert.match(r.stdout,/45-minute limits unchanged/)
})
test('migration preserves custom order, active Terra High and extra models',t=>{
  const env=environment(t);env.base.codex.allowedModels=['custom123','gpt-5.6-terra'];
  env.base.agents[0].model='gpt-5.6-terra';env.base.agents[0].reasoningEffort='high';env.save()
  const r=env.run();assert.equal(r.status,0,r.stderr)
  const after=JSON.parse(readFileSync(env.dst));assert.deepEqual(after.codex.allowedModels,['custom123',...six,...additions])
  assert.equal(after.agents[0].model,'gpt-5.6-terra');assert.equal(after.agents[0].reasoningEffort,'high')
})
test('migration refuses wrong CLI baseline, changed timeouts, duplicate models without output',t=>{
  const cases=[
    v=>{v.codex.expectedVersion='0.171.0'},
    v=>{v.codex.turnTimeoutMs=900_000},
    v=>{v.workers.runtimeLeaseMs=1_800_000},
    v=>{v.codex.allowedModels=['gpt-6.1-sol','gpt-6.1-sol']},
    v=>{v.codex.allowedModels=['../unsafe']},
    v=>{v.codex.allowedModels=[]},
    v=>{v.agents[0].model='not-in-list'},
  ]
  for(const mutate of cases){const env=environment(t);mutate(env.base);env.save();const before=readFileSync(env.src)
    const r=env.run();assert.notEqual(r.status,0);assert.equal(existsSync(env.dst),false);assert.deepEqual(readFileSync(env.src),before)}
})
test('migration fails closed for public and symlink configuration',t=>{
  const env=environment(t);env.save();chmodSync(env.src,0o644)
  assert.notEqual(env.run().status,0);assert.equal(existsSync(env.dst),false)
  const env2=environment(t);env2.save();const alias=join(env2.root,'link.json');symlinkSync(env2.src,alias)
  const r=spawnSync(process.execPath,[script,alias,'/new/codex',env2.dst],{encoding:'utf8'})
  assert.notEqual(r.status,0);assert.equal(existsSync(env2.dst),false)
})
test('migration refuses an existing output and preserves it byte-for-byte',t=>{
  const env=environment(t);env.save();writeFileSync(env.dst,'SENTINEL',{mode:0o600});const r=env.run()
  assert.notEqual(r.status,0);assert.equal(readFileSync(env.dst,'utf8'),'SENTINEL')
})
test('0.171.0 mock App Server exposes all nine selectable models in a read-only probe',t=>{
  const env=environment(t), bin=join(env.root,'codex')
  writeFileSync(bin,`#!/usr/bin/env bash\nexec "${process.execPath}" "${resolve('test/fixtures/fake-codex-app-server.mjs')}" "$@"\n`,{mode:0o700})
  chmodSync(bin,0o700)
  const r=spawnSync(process.execPath,[resolve('scripts/check-codex-models-0.3.5.mjs'),bin,'gpt-6.1-sol'],{encoding:'utf8',timeout:12000})
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/9\/9 selectable/)
  for(const model of additions)assert.match(r.stdout,new RegExp(model.replaceAll('.','\\.')))
})
test('preflight fails closed when currently active model is absent',t=>{
  const env=environment(t),bin=join(env.root,'codex');writeFileSync(bin,`#!/usr/bin/env bash\nexec "${process.execPath}" "${resolve('test/fixtures/fake-codex-app-server.mjs')}" "$@"\n`,{mode:0o700});chmodSync(bin,0o700)
  const r=spawnSync(process.execPath,[resolve('scripts/check-codex-models-0.3.5.mjs'),bin,'gpt-5.6-terra'],{encoding:'utf8',timeout:12000,env:{...process.env,FAKE_CODEX_NO_TERRA:'1'}})
  assert.notEqual(r.status,0);assert.match(r.stderr,/active model/)
})
test('preflight refuses invalid active model input before subprocess starts',()=>{
  const r=spawnSync(process.execPath,[resolve('scripts/check-codex-models-0.3.5.mjs'),'/bin/echo','unapproved'],{encoding:'utf8'})
  assert.notEqual(r.status,0);assert.match(r.stderr,/usage:/)
})
