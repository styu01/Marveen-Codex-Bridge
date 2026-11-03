// Stable, explicit model catalog. Availability is ALSO checked at runtime via model/list.
export const BRIDGE_ALLOWED_MODELS = Object.freeze([
  'gpt-5.6-terra', 'gpt-5.6-sol',
  'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra',
])

const BASE = Object.freeze(['low', 'medium', 'high', 'xhigh'])
const SIX = Object.freeze([...BASE, 'max'])
const SIX_WITH_NONE = Object.freeze(['none', ...SIX])
const LEGACY_CONFIG = Object.freeze([...BASE, 'max', 'ultra'])

// Existing 0.3.2 configurations accepted max/ultra. Preserve loading those
// configurations for rollback compatibility, but only expose documented choices
// in the dashboard for legacy models.
export function effortsForModel(model, { existingConfig = false } = {}) {
  if (model === 'gpt-6-astra' || model === 'gpt-6.1-sol') return SIX
  if (model === 'gpt-6-luna' || model === 'gpt-6-sol') return SIX_WITH_NONE
  if (existingConfig) return LEGACY_CONFIG
  return BASE
}

export function isValidModelEffort(model, effort, options) {
  return effortsForModel(model, options).includes(effort)
}
