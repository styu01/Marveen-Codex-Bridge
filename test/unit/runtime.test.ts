import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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
    reasoningEffort: 'high',
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
  assert.equal(compiled.config.model_reasoning_effort, 'high')
  assert.deepEqual((server.args as string[]).slice(-2), ['--agent', 'codex-dev'])
  const env = server.env as Record<string, string>
  assert.equal(env.BELA_API_ORIGIN, 'http://127.0.0.1:3420')
  assert.ok(env.BELA_MCP_TOKEN_FILE)
  assert.match(readFileSync(env.BELA_MCP_TOKEN_FILE, 'utf8').trim(), /^bcm1\.codex-dev\.[A-Za-z0-9_-]+$/)
  assert.match(
    readFileSync(join(root, 'runtime', 'codex-dev', '.codex', 'config.toml'), 'utf8'),
    /model_reasoning_effort = "high"/,
  )
  const developerInstructions = readFileSync(
    join(root, 'runtime', 'codex-dev', 'AGENTS.md'),
    'utf8',
  )
  assert.match(developerInstructions, /provider staging file outside the workspace/)
  assert.match(developerInstructions, /bela_image_artifact_register/)
  assert.match(developerInstructions, /Never register the provider staging path/)
})

test('final image inspection is canonical, workspace-scoped, non-symlink, and magic-byte based', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-runtime-image-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const config = testConfig(root)
  config.artifacts.maxImageBytes = 100
  const runtime = new RuntimeManager(config)
  const agent = {
    agentId: 'codex-dev',
    displayName: 'Codex Dev',
    desiredState: 'running' as const,
    actualState: 'idle' as const,
    model: 'gpt-5.6-terra',
    reasoningEffort: 'high' as const,
    workspacePath: workspace,
    workspaceMode: 'directory' as const,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'bela' as const,
    networkEnabled: false,
    instructions: '',
    configRevision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const valid = join(workspace, 'valid.bin')
  writeFileSync(valid, png)
  const inspected = runtime.inspectGeneratedImage(agent, valid)
  assert.equal(inspected.mimeType, 'image/png')
  assert.equal(inspected.workspaceRelativePath, 'valid.bin')
  assert.match(inspected.sha256, /^[0-9a-f]{64}$/)

  assert.throws(
    () => runtime.inspectGeneratedImage(agent, 'valid.bin'),
    /savedPath is not absolute/,
  )
  const outside = join(root, 'outside.png')
  writeFileSync(outside, png)
  assert.throws(
    () => runtime.inspectGeneratedImage(agent, outside),
    /outside the configured agent workspace/,
  )
  const link = join(workspace, 'linked.png')
  symlinkSync(valid, link)
  assert.throws(
    () => runtime.inspectGeneratedImage(agent, link),
    /non-symlink regular file/,
  )
  const fake = join(workspace, 'fake.png')
  writeFileSync(fake, 'not an image')
  assert.throws(
    () => runtime.inspectGeneratedImage(agent, fake),
    /not a supported PNG, JPEG, or WebP/,
  )
  const oversized = join(workspace, 'oversized.png')
  writeFileSync(oversized, Buffer.concat([png, Buffer.alloc(101)]))
  assert.throws(
    () => runtime.inspectGeneratedImage(agent, oversized),
    /must be between 1 and 100 bytes/,
  )
})
