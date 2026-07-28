export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error
  return new BridgeError('internal_error', (error as Error)?.message || 'Internal error', 500)
}
