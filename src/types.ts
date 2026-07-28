export type DesiredAgentState = 'running' | 'stopped' | 'draining' | 'disabled'
export type ActualAgentState =
  | 'offline'
  | 'starting'
  | 'idle'
  | 'busy'
  | 'waiting_approval'
  | 'auth_required'
  | 'degraded'
  | 'incompatible'
  | 'stopping'
  | 'crashed'

export type RunState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupting'
  | 'interrupted'
  | 'interrupted_unknown'
  | 'timed_out'

export interface AgentRecord {
  agentId: string
  displayName: string
  desiredState: DesiredAgentState
  actualState: ActualAgentState
  model: string
  workspacePath: string
  workspaceMode: 'directory' | 'worktree'
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'never' | 'bela'
  networkEnabled: boolean
  instructions: string
  configRevision: number
  createdAt: string
  updatedAt: string
}

export interface RunRecord {
  runId: string
  agentId: string
  idempotencyKey: string
  payloadHash: string
  state: RunState
  priority: number
  prompt: string
  context: Record<string, unknown>
  threadId: string | null
  turnId: string | null
  finalResponse: string | null
  errorCode: string | null
  errorMessage: string | null
  usage: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export interface NormalizedEvent {
  type:
    | 'user_input'
    | 'assistant_text'
    | 'assistant_reasoning_summary'
    | 'tool_call'
    | 'tool_result'
    | 'approval_request'
    | 'approval_result'
    | 'usage'
    | 'system_notice'
    | 'error'
    | 'turn_completed'
  payload: Record<string, unknown>
}
