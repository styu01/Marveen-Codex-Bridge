import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, symlinkSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { loadServiceConfig } from '../src/config.mjs'
import { FederationInboxOrchestrator } from '../src/inbox-orchestrator.mjs'
import { CodexAppServerRuntime } from '../src/codex-app-server-runtime.mjs'

const FORTY_FIVE_MINUTES = 2_700_000
const MIGRATOR = 'scripts/migrate-timeouts-0.3.4.1.mjs'
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-timeouts-0341-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['runtime', 'workspace']) mkdirSync(join(root, name))
  for (const [name, value] of [['admin.token','admin-token-000000000000000000000001'],['inbound.token','inbound-token-000000000000000000001'],['outbound.token','outbound-token-00000000000000000001']]) {
    writeFileSync(join(root, name), value+'\n', { mode: 0o600 })
  }
  const c = {
    version:1, systemId:'codex', listen:{ host:'127.0.0.1',port:0 },
    storage:{ database:join(root,'db.sqlite3') },
    codex:{binary:process.execPath,expectedVersion:'0.164.0',runtimeRoot:join(root,'runtime')},
    admin:{tokenFile:join(root,'admin.token')},
    agents:[{id:'programozo',displayName:'Programozó',model:'gpt-6.1-sol',reasoningEffort:'medium',workspacePath:join(root,'workspace'),sandboxMode:'read-only',approvalPolicy:'never'}],
    peers:[{id:'marveen',baseUrl:'http://127.0.0.1:3420',inboundTokenFile:join(root,'inbound.token'),outboundTokenFile:join(root,'outbound.token')}],
    workers:{intervalMs:250},
  }
  const path=join(root,'config.json')
  const save=(value=c)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600})
  save()
  return {root,c,path,save}
}

test('0.3.4.1 defaults both Codex turn and runtime lease to forty-five minutes',t=>{
  const {path}=setup(t)
  const cfg=loadServiceConfig(path)
  assert.equal(cfg.codex.turnTimeoutMs,FORTY_FIVE_MINUTES)
  assert.equal(cfg.workers.runtimeLeaseMs,FORTY_FIVE_MINUTES)
  const worker=new FederationInboxOrchestrator({store:{},runtime:{run(){}},systemId:'codex',workerId:'w'})
  assert.equal(worker.leaseMs,FORTY_FIVE_MINUTES)
  assert.equal(worker.heartbeatIntervalMs,30_000)
})

test('turn deadline schedules forty-five minutes, not fifteen, and clears on completion',()=>{
  const runtime=new CodexAppServerRuntime({config:{codex:{turnTimeoutMs:FORTY_FIVE_MINUTES},agents:[]}})
  const active=runtime.createActiveTurn({runId:'r',agentId:'programozo',threadId:'t'})
  active.turnId='turn-1'
  const original=globalThis.setTimeout
  const scheduled=[]
  globalThis.setTimeout=(fn,ms,...args)=>{ scheduled.push({fn,ms}); return {unref(){}} }
  try {runtime.startTurnDeadline(active)} finally {globalThis.setTimeout=original}
  assert.deepEqual(scheduled.map(x=>x.ms),[FORTY_FIVE_MINUTES])
  assert.equal(active.timedOut,false)
  active.resolve({status:'completed'})
  return active.completion.then(x=>assert.equal(x.status,'completed'))
})

test('migration upgrades missing 15-minute turn and 20-minute lease while preserving all other settings',t=>{
  const env=setup(t)
  env.c.workers.runtimeLeaseMs=1_200_000
  env.c.codex.approvalTimeoutMs=300_000
  env.c.codex.expectedVersion='0.164.0'
  env.save()
  const before=readFileSync(env.path,'utf8')
  const dst=join(env.root,'out.json')
  const result=spawnSync(process.execPath,[MIGRATOR,env.path,dst],{cwd:process.cwd(),encoding:'utf8'})
  assert.equal(result.status,0,result.stderr)
  assert.equal(readFileSync(env.path,'utf8'),before)
  const out=JSON.parse(readFileSync(dst,'utf8'))
  assert.equal(out.codex.turnTimeoutMs,FORTY_FIVE_MINUTES)
  assert.equal(out.workers.runtimeLeaseMs,FORTY_FIVE_MINUTES)
  const expected=structuredClone(env.c)
  expected.codex.turnTimeoutMs=FORTY_FIVE_MINUTES
  expected.workers.runtimeLeaseMs=FORTY_FIVE_MINUTES
  assert.deepEqual(out,expected)
  assert.equal(statSync(dst).mode & 0o077,0)
  assert.equal(loadServiceConfig(dst).codex.turnTimeoutMs,FORTY_FIVE_MINUTES)
})

test('migration upgrades explicitly configured 30-minute turn and 30-minute lease',t=>{
  const e=setup(t)
  e.c.codex.turnTimeoutMs=1_800_000;e.c.workers.runtimeLeaseMs=1_800_000;e.save()
  const dst=join(e.root,'out.json')
  assert.equal(spawnSync(process.execPath,[MIGRATOR,e.path,dst],{cwd:process.cwd()}).status,0)
  const o=JSON.parse(readFileSync(dst,'utf8'))
  assert.equal(o.codex.turnTimeoutMs,FORTY_FIVE_MINUTES)
  assert.equal(o.workers.runtimeLeaseMs,FORTY_FIVE_MINUTES)
})

test('migration is idempotent in values and refuses existing output',t=>{
  const e=setup(t)
  e.c.codex.turnTimeoutMs=FORTY_FIVE_MINUTES;e.c.workers.runtimeLeaseMs=FORTY_FIVE_MINUTES;e.save()
  const dst=join(e.root,'out.json')
  assert.equal(spawnSync(process.execPath,[MIGRATOR,e.path,dst],{cwd:process.cwd()}).status,0)
  const before=readFileSync(dst,'utf8')
  assert.notEqual(spawnSync(process.execPath,[MIGRATOR,e.path,dst],{cwd:process.cwd()}).status,0)
  assert.equal(readFileSync(dst,'utf8'),before)
})

test('migration rejects symlink and public config and out-of-range values',t=>{
  const e=setup(t), dst=join(e.root,'out.json'),link=join(e.root,'linked.json')
  symlinkSync(e.path,link)
  assert.notEqual(spawnSync(process.execPath,[MIGRATOR,link,dst],{cwd:process.cwd()}).status,0)
  chmodSync(e.path,0o644)
  assert.notEqual(spawnSync(process.execPath,[MIGRATOR,e.path,dst],{cwd:process.cwd()}).status,0)
  chmodSync(e.path,0o600)
  e.c.codex.turnTimeoutMs=3_600_001;e.save()
  assert.notEqual(spawnSync(process.execPath,[MIGRATOR,e.path,dst],{cwd:process.cwd()}).status,0)
  assert.notEqual(spawnSync(process.execPath,[MIGRATOR,e.path,e.path],{cwd:process.cwd()}).status,0)
  assert.equal(readFileSync(e.path,'utf8'),JSON.stringify(e.c,null,2)+'\n')
})
