import { CodexAppServerRuntime } from './codex-app-server-runtime.mjs'

export function createRuntime({ config, environment, onEvent }) {
  return new CodexAppServerRuntime({ config, environment, onEvent })
}
