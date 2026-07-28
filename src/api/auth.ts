import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export function authorized(request: IncomingMessage, expectedToken: string): boolean {
  const raw = request.headers.authorization
  if (!raw?.startsWith('Bearer ')) return false
  const supplied = Buffer.from(raw.slice('Bearer '.length), 'utf8')
  const expected = Buffer.from(expectedToken, 'utf8')
  if (supplied.length !== expected.length) return false
  return timingSafeEqual(supplied, expected)
}
