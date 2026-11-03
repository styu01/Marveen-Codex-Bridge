import { MockCodexRuntime } from '../../src/mock-runtime.mjs'

export function createRuntime({ config }) {
  return new MockCodexRuntime({
    agents: config.agents,
    responder: async () => 'MAIN_PROCESS_E2E_OK',
  })
}
