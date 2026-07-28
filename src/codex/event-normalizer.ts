import type { RpcNotification } from './protocol-client.js'
import type { NormalizedEvent } from '../types.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function notificationIdentity(notification: RpcNotification): {
  threadId: string | null
  turnId: string | null
} {
  const params = notification.params ?? {}
  const turn = object(params.turn)
  return {
    threadId: typeof params.threadId === 'string' ? params.threadId : null,
    turnId:
      typeof params.turnId === 'string'
        ? params.turnId
        : typeof turn.id === 'string'
          ? turn.id
          : null,
  }
}

export function normalizeNotification(notification: RpcNotification): NormalizedEvent | null {
  const params = notification.params ?? {}
  if (notification.method === 'item/completed' || notification.method === 'item/started') {
    const item = object(params.item)
    const type = item.type
    if (type === 'agentMessage') {
      return {
        type: 'assistant_text',
        payload: {
          text: typeof item.text === 'string' ? item.text : '',
          phase: item.phase ?? null,
          rawMethod: notification.method,
        },
      }
    }
    if (type === 'reasoning') {
      return {
        type: 'assistant_reasoning_summary',
        payload: {
          text: item.summary ?? item.text ?? '',
          rawMethod: notification.method,
        },
      }
    }
    if (type === 'commandExecution' || type === 'mcpToolCall' || type === 'fileChange') {
      return {
        type: notification.method === 'item/started' ? 'tool_call' : 'tool_result',
        payload: { item },
      }
    }
    return { type: 'system_notice', payload: { method: notification.method, item } }
  }
  if (notification.method === 'thread/tokenUsage/updated') {
    return { type: 'usage', payload: { usage: params } }
  }
  if (notification.method === 'turn/completed') {
    return { type: 'turn_completed', payload: params }
  }
  if (notification.method.includes('error')) {
    return { type: 'error', payload: { method: notification.method, params } }
  }
  return null
}

export function turnStatus(notification: RpcNotification): string | null {
  const turn = object(notification.params?.turn)
  return typeof turn.status === 'string' ? turn.status : null
}
