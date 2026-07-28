import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeManager } from '../../src/runtime/runtime-manager.js'
import { testConfig } from '../helpers.js'

test('runtime rejects invalid agent ids and prepares a directory workspace', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const runtime = new RuntimeManager(testConfig(root))
  assert.throws(() => runtime.agentRoot('../escape'), /Agent ID/)
  assert.equal(runtime.prepareWorkspace('codex-dev', workspace, 'directory'), workspace)
})

test('runtime compiles an agent-scoped mandatory Béla MCP server', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-mcp-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const runtime = new RuntimeManager(testConfig(root))
  const compiled = runtime.compile({
    agentId: 'codex-dev',
    displayName: 'Codex Dev',
    desiredState: 'running',
    actualState: 'idle',
    model: 'gpt-5.6-terra',
    workspacePath: workspace,
    workspaceMode: 'directory',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'bela',
    networkEnabled: false,
    instructions: 'Test identity',
    configRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const server = (compiled.config.mcp_servers as Record<string, Record<string, unknown>>).bela
  assert.ok(server)
  assert.equal(server.enabled, true)
  assert.equal(server.required, true)
  assert.equal(server.default_tools_approval_mode, 'auto')
  assert.deepEqual((server.args as string[]).slice(-2), ['--agent', 'codex-dev'])
  const env = server.env as Record<string, string>
  assert.equal(env.BELA_API_ORIGIN, 'http://127.0.0.1:3420')
  assert.ok(env.BELA_MCP_TOKEN_FILE)
  assert.match(readFileSync(env.BELA_MCP_TOKEN_FILE, 'utf8').trim(), /^bcm1\.codex-dev\.[A-Za-z0-9_-]+$/)
})
