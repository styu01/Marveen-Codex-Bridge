export const BELA_DYNAMIC_TOOL_CONTRACT_REVISION = 1

export const BELA_TOOL_SPECS = [
  {
    name: 'bela_agent_message_send',
    title: 'Send a Béla agent message',
    description: 'Send a message as this authenticated Codex agent. The sender identity cannot be overridden.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', minLength: 1, maxLength: 128 },
        content: { type: 'string', minLength: 1, maxLength: 262144 },
        ref: { type: 'string', maxLength: 200 },
      },
      required: ['to', 'content'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'bela_agent_message_status',
    title: 'Read sent-message status',
    description: 'Read the status of a message previously sent by this authenticated Codex agent.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'bela_memory_search',
    title: 'Search Béla memory',
    description: 'Search this agent’s memories and explicitly shared memories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'bela_memory_get',
    title: 'Get a Béla memory',
    description: 'Read one memory using an opaque identifier returned by bela_memory_search.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 16, maxLength: 200 } },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const

export const BELA_DYNAMIC_TOOLS = BELA_TOOL_SPECS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  deferLoading: false,
}))

export type BelaToolName = typeof BELA_TOOL_SPECS[number]['name']

const TOOL_NAMES = new Set<string>(BELA_TOOL_SPECS.map((tool) => tool.name))

export function isBelaToolName(value: string): value is BelaToolName {
  return TOOL_NAMES.has(value)
}

function assertKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key))
  if (unknown.length) throw new Error(`Unknown tool argument(s): ${unknown.join(', ')}`)
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string with at most ${maxLength} characters`)
  }
  return value
}

function validateBelaToolArgs(
  name: BelaToolName,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === 'bela_agent_message_send') {
    assertKeys(args, ['to', 'content', 'ref'])
    const ref = args.ref
    if (ref !== undefined && (typeof ref !== 'string' || ref.length > 200)) {
      throw new Error('ref must be a string with at most 200 characters')
    }
    return {
      to: requiredString(args, 'to', 128),
      content: requiredString(args, 'content', 262144),
      ...(ref !== undefined ? { ref } : {}),
    }
  }
  if (name === 'bela_agent_message_status') {
    assertKeys(args, ['id'])
    if (!Number.isInteger(args.id) || (args.id as number) < 1) {
      throw new Error('id must be a positive integer')
    }
    return { id: args.id }
  }
  if (name === 'bela_memory_search') {
    assertKeys(args, ['query', 'limit'])
    const limit = args.limit
    if (
      limit !== undefined
      && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 20)
    ) {
      throw new Error('limit must be an integer between 1 and 20')
    }
    return {
      query: requiredString(args, 'query', 1000),
      ...(limit !== undefined ? { limit } : {}),
    }
  }
  assertKeys(args, ['id'])
  const id = requiredString(args, 'id', 200)
  if (id.length < 16) throw new Error('id must contain at least 16 characters')
  return { id }
}

export async function callBelaFacadeTool(input: {
  name: BelaToolName
  args: Record<string, unknown>
  origin: string
  token: string
  timeoutMs?: number
}): Promise<unknown> {
  const args = validateBelaToolArgs(input.name, input.args)
  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? 30_000),
    }
    if (body) init.body = JSON.stringify(body)
    const response = await fetch(`${input.origin.replace(/\/+$/, '')}${path}`, init)
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const error = payload.error
      const message = typeof error === 'string'
        ? error
        : error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message: string }).message)
          : `Béla facade HTTP ${response.status}`
      throw new Error(message)
    }
    return payload
  }

  if (input.name === 'bela_agent_message_send') {
    return request('POST', '/api/codex-facade/messages', {
      to: args.to,
      content: args.content,
      ref: args.ref,
    })
  }
  if (input.name === 'bela_agent_message_status') {
    return request(
      'GET',
      `/api/codex-facade/messages/${encodeURIComponent(String(args.id))}`,
    )
  }
  if (input.name === 'bela_memory_search') {
    return request('POST', '/api/codex-facade/memories/search', {
      query: args.query,
      limit: args.limit,
    })
  }
  return request(
    'GET',
    `/api/codex-facade/memories/${encodeURIComponent(String(args.id))}`,
  )
}
