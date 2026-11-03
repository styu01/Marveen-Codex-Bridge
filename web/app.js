const state = {
  token: sessionStorage.getItem('marveenCodexBridgeToken') || '',
  settings: null,
}

const byId = (id) => document.getElementById(id)
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]))

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${state.token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const payload = await response.json().catch(() => ({}))
  if (response.status === 401) throw new Error('unauthorized')
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`)
  return payload
}

async function optionalData(path) {
  try {
    return (await api(path)).data
  } catch (error) {
    if (error.message === 'unauthorized') throw error
    return []
  }
}

function setConnected(value) {
  byId('connection').textContent = value ? 'Bridge online' : 'Nincs kapcsolat'
  byId('connection').className = `badge ${value ? 'online' : 'offline'}`
  byId('login-panel').hidden = value
  byId('dashboard').hidden = !value
}

function renderCards(summary) {
  const cards = [
    ['Verzió', summary.bridgeVersion],
    ['Inbox', summary.counts.inbox],
    ['Dead outbox', summary.counts.outboxDead],
    ['Függő approval', summary.counts.pendingApprovals],
    ['Futások', summary.counts.runs],
  ]
  byId('summary-cards').innerHTML = cards.map(([label, value]) => (
    `<article class="card"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  )).join('')
}

function renderAgents(agents) {
  byId('agents').innerHTML = agents.length
    ? agents.map((agent) => `<div class="agent"><strong>${escapeHtml(agent.displayName)}</strong> <span class="muted">${escapeHtml(agent.id)} · ${escapeHtml(agent.model)} · effort: ${escapeHtml(agent.reasoningEffort)}</span></div>`).join('')
    : '<p class="muted">Nincs konfigurált agent.</p>'
}

function renderSettings(settings) {
  state.settings = settings
  byId('settings-current').innerHTML = [
    `<span>Agent: <strong>${escapeHtml(settings.displayName)}</strong> (${escapeHtml(settings.agentId)})</span>`,
    `<span>Modell: <strong>${escapeHtml(settings.model)}</strong></span>`,
    `<span>Aktuális effort: <strong>${escapeHtml(settings.reasoningEffort)}</strong></span>`,
  ].join('')
  byId('settings-model').innerHTML = settings.selectableModels
    .map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`)
    .join('')
  byId('settings-model').value = settings.model
  renderEfforts(settings.model, settings.reasoningEffort)
  byId('settings-role').value = settings.developerInstructions
  byId('restore-settings').disabled = !settings.canRestore
}

function renderEfforts(model, preferred) {
  const effortControl = byId('settings-effort')
  const allowed = state.settings?.effortsByModel?.[model] ?? ['low', 'medium', 'high', 'xhigh']
  const current = preferred ?? effortControl.value
  effortControl.innerHTML = allowed.map((effort) =>
    `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`).join('')
  // Preserve the current selection when legal; otherwise prefer medium.
  effortControl.value = allowed.includes(current) ? current
    : (allowed.includes('medium') ? 'medium' : allowed[0])
}

function renderSettingsAudit(records) {
  byId('settings-audit').innerHTML = records.length
    ? records.map((record) => `<tr><td>${new Date(record.timestampMs).toLocaleString('hu-HU')}</td><td>${escapeHtml(record.actor)}</td><td>${escapeHtml(record.action)}</td><td>${escapeHtml(record.changes?.model?.before ?? '—')} → ${escapeHtml(record.changes?.model?.after ?? '—')}</td><td>${escapeHtml(record.changes?.reasoningEffort?.before ?? '—')} → ${escapeHtml(record.changes?.reasoningEffort?.after ?? '—')}</td><td>${escapeHtml(record.outcome)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Még nincs beállításmódosítás.</td></tr>'
}

function renderRuns(runs) {
  byId('runs').innerHTML = runs.length
    ? runs.map((run) => `<tr><td>${escapeHtml(run.agentId)}</td><td>${escapeHtml(run.model)}</td><td>${escapeHtml(run.reasoningEffort)}</td><td class="state">${escapeHtml(run.state)}</td><td>${escapeHtml(run.runId.slice(0, 12))}</td><td>${new Date(run.updatedAtMs).toLocaleString('hu-HU')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">Nincs futás.</td></tr>'
}

async function decideApproval(approvalId, decision) {
  await api(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  })
  await refresh()
}

function renderApprovals(approvals) {
  byId('approvals').innerHTML = approvals.length
    ? approvals.map((approval) => `<div class="approval"><div><strong>${escapeHtml(approval.category)}</strong><br><span class="muted">${escapeHtml(approval.agentId)} · ${escapeHtml(approval.approvalId)}</span></div><div><button data-decision="approve" data-id="${escapeHtml(approval.approvalId)}">Jóváhagyás</button> <button class="secondary" data-decision="decline" data-id="${escapeHtml(approval.approvalId)}">Elutasítás</button></div></div>`).join('')
    : '<p class="muted">Nincs függő jóváhagyás.</p>'
}

async function refresh() {
  const [summary, runs, approvals, settings, audit] = await Promise.all([
    api('/v1/dashboard/summary'),
    optionalData('/v1/runs?limit=100'),
    optionalData('/v1/approvals?state=pending'),
    api('/v1/dashboard/agent-settings'),
    api('/v1/dashboard/agent-settings/audit?limit=100'),
  ])
  renderCards(summary.data)
  renderAgents(summary.data.agents)
  renderRuns(runs)
  renderApprovals(approvals)
  renderSettings(settings.data)
  renderSettingsAudit(audit.data)
  setConnected(true)
}

function setSettingsBusy(busy, message = '') {
  byId('save-settings').disabled = busy
  byId('restore-settings').disabled = busy || !state.settings?.canRestore
  byId('settings-status').textContent = message
  byId('settings-status').className = busy ? 'muted' : ''
}

async function saveSettings(event) {
  event.preventDefault()
  const actor = byId('settings-actor').value.trim()
  const model = byId('settings-model').value
  const developerInstructions = byId('settings-role').value
  const reasoningEffort = byId('settings-effort').value
  if (!actor || !developerInstructions.trim()) {
    byId('settings-status').textContent = 'A módosító neve és a szerepkör kötelező.'
    return
  }
  const confirmed = window.confirm(
    `Biztosan mented a modellt (${state.settings.model} → ${model}), a szerepkört és az effortot (${state.settings.reasoningEffort} → ${reasoningEffort})? Sikeres readiness után a régi Codex-thread lezárul.`,
  )
  if (!confirmed) return
  setSettingsBusy(true, 'Mentés és runtime-újraindítás…')
  try {
    await api('/v1/dashboard/agent-settings', {
      method: 'PUT',
      body: JSON.stringify({ actor, model, developerInstructions, reasoningEffort, confirm: true }),
    })
    await refresh()
    byId('settings-status').textContent = 'Mentve. A runtime újraindult, a régi thread lezárult.'
    byId('settings-status').className = 'success'
  } catch (error) {
    setSettingsBusy(false, `Sikertelen: ${error.message}`)
  }
}

async function restoreSettings() {
  const actor = byId('settings-actor').value.trim()
  if (!actor) {
    byId('settings-status').textContent = 'A visszaállításhoz add meg a módosító nevét.'
    return
  }
  if (!window.confirm('Visszaállítod az előző konfigurációt? A régi Codex-thread lezárul, a runtime újraindul.')) return
  setSettingsBusy(true, 'Visszaállítás és runtime-újraindítás…')
  try {
    await api('/v1/dashboard/agent-settings/restore', {
      method: 'POST',
      body: JSON.stringify({ actor, confirm: true }),
    })
    await refresh()
    byId('settings-status').textContent = 'Az előző beállítás visszaállt.'
    byId('settings-status').className = 'success'
  } catch (error) {
    setSettingsBusy(false, `Sikertelen: ${error.message}`)
  }
}

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  state.token = byId('token').value.trim()
  try {
    await refresh()
    sessionStorage.setItem('marveenCodexBridgeToken', state.token)
    byId('login-error').textContent = ''
    byId('token').value = ''
  } catch {
    state.token = ''
    byId('login-error').textContent = 'A token hibás vagy a Bridge nem elérhető.'
    setConnected(false)
  }
})
byId('refresh').addEventListener('click', () => refresh().catch(() => setConnected(false)))
byId('logout').addEventListener('click', () => {
  sessionStorage.removeItem('marveenCodexBridgeToken')
  state.token = ''
  setConnected(false)
})
byId('approvals').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-decision]')
  if (!button) return
  void decideApproval(button.dataset.id, button.dataset.decision)
})
byId('agent-settings-form').addEventListener('submit', (event) => void saveSettings(event))
byId('restore-settings').addEventListener('click', () => void restoreSettings())

if (state.token) refresh().catch(() => setConnected(false))

byId('settings-model').addEventListener('change', () => renderEfforts(byId('settings-model').value, 'medium'))
