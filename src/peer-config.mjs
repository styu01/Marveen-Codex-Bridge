const TOKEN_MIN_LENGTH = 32

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

export function requiredPeerConfiguration(value, expectedPeerId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Federation peer '${expectedPeerId}' is not configured`)
  }
  if (
    typeof value.id !== 'string'
    || value.id.toLowerCase() !== expectedPeerId.toLowerCase()
  ) {
    throw new Error(`Federation peer identity mismatch for '${expectedPeerId}'`)
  }
  let url
  try {
    url = new URL(value.baseUrl)
  } catch {
    throw new Error(`Federation peer '${expectedPeerId}' has an invalid baseUrl`)
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Federation peer '${expectedPeerId}' baseUrl contains forbidden components`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`Federation peer '${expectedPeerId}' requires HTTPS or loopback HTTP`)
  }
  if (
    typeof value.outboundToken !== 'string'
    || value.outboundToken.length < TOKEN_MIN_LENGTH
  ) {
    throw new Error(`Federation peer '${expectedPeerId}' outbound token is invalid`)
  }
  return {
    id: value.id.toLowerCase(),
    baseUrl: url,
    outboundToken: value.outboundToken,
  }
}
