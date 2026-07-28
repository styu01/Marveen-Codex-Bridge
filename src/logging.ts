const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type Level = keyof typeof LEVELS

const SECRET_KEY = /(authorization|token|secret|password|cookie|credential|api[-_]?key)/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

function redact(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return value.replace(BEARER, 'Bearer [REDACTED]')
  if (Array.isArray(value)) return value.map((item) => redact(item))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [childKey, child] of Object.entries(value)) result[childKey] = redact(child, childKey)
    return result
  }
  return value
}

export class Logger {
  constructor(private readonly minimum: Level = 'info') {}

  private write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.minimum]) return
    const record = {
      time: new Date().toISOString(),
      level,
      message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    }
    const line = `${JSON.stringify(record)}\n`
    if (level === 'error' || level === 'warn') process.stderr.write(line)
    else process.stdout.write(line)
  }

  debug(message: string, fields?: Record<string, unknown>): void { this.write('debug', message, fields) }
  info(message: string, fields?: Record<string, unknown>): void { this.write('info', message, fields) }
  warn(message: string, fields?: Record<string, unknown>): void { this.write('warn', message, fields) }
  error(message: string, fields?: Record<string, unknown>): void { this.write('error', message, fields) }
}

export function redactForTest(value: unknown): unknown {
  return redact(value)
}
