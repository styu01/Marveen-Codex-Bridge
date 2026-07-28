#!/usr/bin/env node

import readline from 'node:readline'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.145.0\n')
  process.exit(0)
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\n')
  process.exit(0)
}
if (args[0] !== 'app-server') {
  process.stderr.write(`unsupported fake command: ${args.join(' ')}\n`)
  process.exit(2)
}

const threads = new Map()
const pendingDynamicCalls = new Map()
const pendingApprovalCalls = new Map()
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function respond(id, result) {
  write({ id, result })
}

function completeTurn(threadId, turnId, text) {
  write({
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        phase: 'final_answer',
        text,
      },
    },
  })
  write({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId,
      turnId,
      inputTokens: 12,
      outputTokens: 4,
    },
  })
  write({
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status: 'completed' },
    },
  })
}

input.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  if (message.id === undefined) return
  if (!message.method && (message.result !== undefined || message.error !== undefined)) {
    const approval = pendingApprovalCalls.get(String(message.id))
    if (approval) {
      pendingApprovalCalls.delete(String(message.id))
      completeTurn(
        approval.threadId,
        approval.turnId,
        `FAKE_APPROVAL_RESULT:${message.result?.decision ?? 'error'}`,
      )
      return
    }
    const pending = pendingDynamicCalls.get(String(message.id))
    if (!pending) return
    pendingDynamicCalls.delete(String(message.id))
    const result = message.result ?? {
      success: false,
      contentItems: [{ type: 'inputText', text: message.error?.message ?? 'unknown error' }],
    }
    write({
      method: 'item/completed',
      params: {
        threadId: pending.threadId,
        turnId: pending.turnId,
        item: {
          type: 'dynamicToolCall',
          id: pending.callId,
          namespace: null,
          tool: pending.tool,
          arguments: pending.arguments,
          status: result.success ? 'completed' : 'failed',
          contentItems: result.contentItems ?? [],
          success: Boolean(result.success),
          durationMs: 1,
        },
      },
    })
    const output = result.contentItems?.[0]?.text ?? ''
    completeTurn(
      pending.threadId,
      pending.turnId,
      `FAKE_DYNAMIC_TOOL_OK:${String(result.success)}:${output}`,
    )
    return
  }
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    respond(id, { serverInfo: { name: 'fake-codex', version: '0.145.0' } })
    return
  }
  if (method === 'model/list') {
    respond(id, { data: [{ model: 'gpt-5.6-terra' }, { model: 'gpt-5.5' }] })
    return
  }
  if (method === 'thread/start') {
    const threadId = randomUUID()
    threads.set(threadId, { ...params })
    respond(id, {
      thread: { id: threadId },
      model: params.model,
      cwd: params.cwd,
      sandbox: { type: params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' },
    })
    return
  }
  if (method === 'thread/resume') {
    if (!threads.has(params.threadId)) threads.set(params.threadId, { ...params })
    respond(id, { thread: { id: params.threadId }, model: params.model, cwd: params.cwd })
    return
  }
  if (method === 'mcpServerStatus/list') {
    const thread = threads.get(params.threadId) ?? {}
    const servers = thread.config?.mcp_servers ?? {}
    respond(id, {
      data: Object.entries(servers)
        .filter(([, config]) => config?.enabled !== false)
        .map(([name]) => ({
          name,
          tools: name === 'bela'
            ? {
                bela_agent_message_send: {},
                bela_agent_message_status: {},
                bela_memory_search: {},
                bela_memory_get: {},
              }
            : {},
          resources: [],
          resourceTemplates: [],
          authStatus: 'notApplicable',
        })),
      nextCursor: null,
    })
    return
  }
  if (method === 'turn/start') {
    const turnId = randomUUID()
    respond(id, { turn: { id: turnId } })
    const text = params.input?.[0]?.text ?? ''
    if (text.includes('DYNAMIC_TOOL_TEST')) {
      setTimeout(() => {
        const thread = threads.get(params.threadId) ?? {}
        const tool = thread.dynamicTools?.find(
          (candidate) => candidate.name === 'bela_agent_message_send',
        )
        if (!tool) {
          completeTurn(params.threadId, turnId, 'FAKE_DYNAMIC_TOOL_MISSING')
          return
        }
        const callId = randomUUID()
        const requestId = `dynamic-${callId}`
        const argumentsValue = {
          to: 'bela',
          content: 'DYNAMIC_TOOL_DELIVERY_OK',
          ref: 'dynamic-tool-test',
        }
        pendingDynamicCalls.set(requestId, {
          threadId: params.threadId,
          turnId,
          callId,
          tool: tool.name,
          arguments: argumentsValue,
        })
        write({
          method: 'item/started',
          params: {
            threadId: params.threadId,
            turnId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              namespace: null,
              tool: tool.name,
              arguments: argumentsValue,
              status: 'inProgress',
            },
          },
        })
        write({
          id: requestId,
          method: 'item/tool/call',
          params: {
            threadId: params.threadId,
            turnId,
            callId,
            namespace: null,
            tool: tool.name,
            arguments: argumentsValue,
          },
        })
      }, 10)
      return
    }
    if (text.includes('APPROVAL_TEST')) {
      setTimeout(() => {
        const requestId = 'reusable-approval-request-id'
        pendingApprovalCalls.set(requestId, {
          threadId: params.threadId,
          turnId,
        })
        write({
          id: requestId,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: params.threadId,
            turnId,
            command: ['node', '-e', 'process.stdout.write("approval-canary")'],
            cwd: params.cwd,
            reason: 'Deterministic Bridge approval regression test',
          },
        })
      }, 10)
      return
    }
    setTimeout(() => {
      completeTurn(params.threadId, turnId, `FAKE_CODEX_OK:${text.slice(0, 80)}`)
    }, 10)
    return
  }
  if (method === 'turn/interrupt') {
    respond(id, {})
    setTimeout(() => {
      write({
        method: 'turn/completed',
        params: {
          threadId: params.threadId,
          turn: { id: params.turnId, status: 'interrupted' },
        },
      })
    }, 5)
    return
  }
  respond(id, {})
})
