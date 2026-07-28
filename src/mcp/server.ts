#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import readline from 'node:readline'
import {
  BELA_TOOL_SPECS,
  callBelaFacadeTool,
  isBelaToolName,
} from '../tools/bela-tools.js'

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing required argument: ${name}`)
  return value
}

const agentId = argument('--agent')
const tokenFile = process.env.BELA_MCP_TOKEN_FILE
const origin = (process.env.BELA_API_ORIGIN || 'http://127.0.0.1:3420').replace(/\/+$/, '')
if (!tokenFile) throw new Error('BELA_MCP_TOKEN_FILE is required')

function token(): string {
  const value = readFileSync(tokenFile!, 'utf8').trim()
  if (!value) throw new Error('Béla MCP token file is empty')
  return value
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!isBelaToolName(name)) throw new Error(`Unknown tool: ${name}`)
  return callBelaFacadeTool({
    name,
    args,
    origin,
    token: token(),
  })
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  if (!line.trim()) return
  let message: {
    id?: string | number
    method?: string
    params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string }
  }
  try { message = JSON.parse(line) } catch { return }
  if (message.id === undefined || message.id === null) return
  const result = (value: unknown) => write({ jsonrpc: '2.0', id: message.id, result: value })
  const error = (code: number, text: string) => write({
    jsonrpc: '2.0',
    id: message.id,
    error: { code, message: text },
  })

  if (message.method === 'initialize') {
    result({
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: `bela-codex-mcp-${agentId}`, version: '0.1.8' },
    })
  } else if (message.method === 'ping') {
    result({})
  } else if (message.method === 'tools/list') {
    result({ tools: BELA_TOOL_SPECS })
  } else if (message.method === 'tools/call' && message.params?.name) {
    void callTool(message.params.name, message.params.arguments ?? {})
      .then((value) => result({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
        isError: false,
      }))
      .catch((cause: Error) => result({
        content: [{ type: 'text', text: cause.message }],
        structuredContent: {
          ok: false,
          error: { code: 'facade_error', message: cause.message, retryable: true },
        },
        isError: true,
      }))
  } else {
    error(-32601, `Method not found: ${message.method ?? ''}`)
  }
})
