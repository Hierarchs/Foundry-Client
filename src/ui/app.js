'use strict';

const $ = id => document.getElementById(id);
let state = null, page = 'sessions', editingId = null, deleteId = null, performanceProfile = 'balanced';
let diagnosticTimer = null, diagnosticBusy = false, toastTimer = null, previousActive = null;
let liveFPS = false;
const invoke = (action, payload) => window.client.invoke(action, payload);
const element = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
async function safely(action, button) {
  if (button) button.disabled = true;
  try { return await action(); } catch (error) { toast(errorText(error), true); }
  finally { if (button) button.disabled = false; }
}
function result(id, message, error = false) { $(id).textContent = message; $(id).classList.toggle('error', error); }

function render(next) {
  state = next;
  $('launcher').hidden = !!state.active && !state.overlay;
  $('game-tools').hidden = !state.active;
  document.body.classList.toggle('focus-mode', state.focusMode);
  $('active-title').textContent = state.active?.name || '';
  $('library-toggle').textContent = state.overlay ? 'Return to game' : 'Sessions';
  $('connection-banner').hidden = !state.active;
  $('connection-banner').classList.toggle('error', state.status.phase === 'error');
  $('connection-message').textContent = state.status.phase === 'error' ? state.status.message : `${state.active?.name || 'Session'} · ${state.status.message}`;
  $('retry').hidden = state.status.phase !== 'error';
  $('warning').hidden = !state.warning; $('warning').textContent = state.warning || '';
  $('session-count').textContent = state.sessions.length;
  $('list-count').textContent = String(state.sessions.length).padStart(2, '0');
  $('runtime-short').textContent = `Chromium ${state.runtime.chromium.split('.')[0]}`;
  $('client-version-label').textContent = `CLIENT ${state.runtime.app}`;
  if (state.runtime.backend === 'rust') {
    $('runtime-short').textContent = `Rust · WebView2 ${state.runtime.chromium.split('.')[0]}`;
    $('background-throttle-description').textContent = 'Reduce browser memory while minimized. Changes to background timer throttling take effect after restarting the client.';
  }
  for (const [key, value] of Object.entries(state.preferences)) $(`pref-${key}`).checked = value;
  if (previousActive !== state.active?.url) {
    previousActive = state.active?.url;
    performanceProfile = state.active?.profile || 'balanced';
    renderProfiles();
  }
  $('apply-profile').disabled = !state.active;
  $('restore-profile').disabled = !state.active;
  renderSessions(); renderCache(); renderRuntime(); renderUpdates(); scheduleDiagnostics();
}
function renderUpdates() {
  const update = state.updates;
  $('update-panel').hidden = !update;
  const available = update?.status === 'available';
  $('update-banner').hidden = !available;
  if (!update) return;
  $('update-version').textContent = `Installed version ${update.currentVersion}`;
  $('update-status').textContent = update.message;
  $('update-status').classList.toggle('error', update.status === 'error');
  $('update-checked').textContent = update.lastChecked ? `Last checked ${new Date(update.lastChecked).toLocaleString()}` : '';
  $('check-updates').disabled = update.status === 'checking';
  $('check-updates').textContent = update.status === 'checking' ? 'Checking…' : 'Check for updates';
  $('download-update').hidden = !available || !update.release?.downloadUrl;
  $('download-update').textContent = update.release?.downloadLabel || 'Download installer';
  $('release-notes').textContent = update.release ? 'Release notes' : 'View releases';
  $('update-banner-text').textContent = available ? update.message : '';
}
function renderSessions() {
  $('session-list').replaceChildren();
  $('empty-state').hidden = state.sessions.length > 0;
  const sorted = [...state.sessions].sort((a, b) => (b.lastJoined || '').localeCompare(a.lastJoined || ''));
  for (const item of sorted) {
    const card = element('article', 'session-card');
    const top = element('div', 'session-card-top');
    top.append(element('div', 'session-avatar', item.name.slice(0, 1).toUpperCase()));
    const info = element('div', 'session-info');
    info.append(element('h3', '', item.name), element('p', '', new URL(item.url).host));
    top.append(info);
    top.append(element('span', 'badge', new URL(item.url).hostname.endsWith('.sqyre.app') || new URL(item.url).hostname === 'sqyre.app' ? 'SQYRE' : 'FOUNDRY'));
    const bottom = element('div', 'session-card-bottom');
    const date = item.lastJoined ? `Joined ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(item.lastJoined))}` : 'Ready for your first visit';
    bottom.append(element('small', '', `${state.profiles[item.profile].name} · ${date}`));
    const edit = element('button', 'card-edit', 'Edit'); edit.type = 'button'; edit.setAttribute('aria-label', `Edit ${item.name}`); edit.onclick = () => editSession(item);
    const remove = element('button', 'card-delete', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.name}`); remove.onclick = () => { deleteId = item.id; $('delete-dialog').showModal(); };
    const join = element('button', 'secondary-button card-join', 'Join →'); join.type = 'button'; join.setAttribute('aria-label', `Join ${item.name}`); join.onclick = () => safely(async () => render(await invoke('connect', { id: item.id })), join);
    bottom.append(edit, remove, join); card.append(top, bottom); $('session-list').append(card);
  }
}
function renderProfiles() {
  if (!state) return;
  $('performance-profiles').replaceChildren();
  for (const [id, profile] of Object.entries(state.profiles)) {
    const label = element('label', 'performance-option');
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'performance-profile'; radio.value = id; radio.checked = performanceProfile === id; radio.onchange = () => { performanceProfile = id; };
    const content = element('div'); content.append(element('strong', '', profile.name), element('small', '', profile.description));
    label.append(radio, content, element('span', 'profile-spec', `${profile.settings.maxFPS} FPS`));
    $('performance-profiles').append(label);
  }
}
function renderCache() {
  const current = $('cache-session').value;
  $('cache-session').replaceChildren();
  if (!state.sessions.length) { const option = element('option', '', 'No saved sessions'); option.value = ''; $('cache-session').append(option); }
  for (const s of state.sessions) { const option = element('option', '', s.name); option.value = s.id; $('cache-session').append(option); }
  if (state.sessions.some(s => s.id === current)) $('cache-session').value = current;
  $('clear-cache').disabled = !state.sessions.length;
}
function renderRuntime() {
  const details = { 'Client version': state.runtime.app, ...(state.runtime.backend === 'rust' ? {'Native host': state.runtime.rust, 'Renderer': `WebView2 ${state.runtime.chromium}`} : {'Electron': state.runtime.electron, 'Chromium': state.runtime.chromium}), 'System RAM': `${state.runtime.ramGB} GB`, 'Foundry version': 'Join a world to detect', 'Asset cache': 'Persistent', 'Background rendering': state.preferences.backgroundThrottle ? 'Throttled' : 'Unrestricted' };
  $('runtime-details').replaceChildren();
  for (const [name, value] of Object.entries(details)) { const dt = element('dt', '', name), dd = element('dd', '', value); if (name === 'Foundry version') dd.id = 'foundry-version'; $('runtime-details').append(dt, dd); }
}
async function refreshDiagnostics() {
  if (diagnosticBusy || document.hidden) return;
  diagnosticBusy = true;
  try {
    if (state.runtime.backend === 'rust' && liveFPS && state.active && !state.overlay) {
      const fps = await invoke('frame');
      $('live-fps').textContent = `${fps ?? '—'} FPS`;
      $('live-fps').title = 'Live canvas FPS. Open Performance for memory and CPU diagnostics. Click to stop monitoring.';
      return;
    }
    const d = await invoke('diagnostics');
    const accelerated = String(d.gpu.webgl2 || d.gpu.webgl || '').startsWith('enabled');
    $('engine-label').textContent = accelerated ? 'GPU acceleration active' : 'Check GPU acceleration';
    $('engine-light').classList.toggle('ready', accelerated);
    $('metric-fps').textContent = d.foundry?.fps ?? '—';
    $('metric-memory').textContent = d.memoryMB.toLocaleString();
    $('metric-cpu').textContent = d.cpuPercent.toFixed(1);
    $('metric-gpu').textContent = accelerated ? 'Accelerated' : 'Software / off';
    $('metric-webgl').textContent = d.foundry?.webgl || 'Canvas not detected';
    if (liveFPS) { $('live-fps').textContent = `${d.foundry?.fps ?? '—'} FPS`; $('live-fps').title = `${d.memoryMB.toLocaleString()} MB across client processes. Click to stop monitoring.`; }
    if ($('foundry-version')) $('foundry-version').textContent = d.foundry?.version || 'Join a world to detect';
  } catch { /* A closing window or changing renderer may temporarily be unavailable. */ }
  finally { diagnosticBusy = false; }
}
function scheduleDiagnostics() {
  clearTimeout(diagnosticTimer);
  const inGame = !!state?.active && !state.overlay;
  if (document.hidden || state?.focusMode || (inGame ? !liveFPS : page !== 'performance')) return;
  diagnosticTimer = setTimeout(async () => { await refreshDiagnostics(); scheduleDiagnostics(); }, 2500);
}
async function showPage(target) {
  page = target;
  document.querySelectorAll('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  document.querySelectorAll('.nav-button').forEach(el => el.classList.toggle('selected', el.dataset.page === page));
  if (state?.active && !state.overlay) render(await invoke('overlay', true));
  if (page === 'performance') { renderProfiles(); await refreshDiagnostics(); }
  scheduleDiagnostics();
}
function newSession() {
  editingId = null; $('join-form').reset(); $('form-title').textContent = 'Join a session'; $('form-error').hidden = true;
  $('session-url').focus();
}
function editSession(item) {
  editingId = item.id; $('session-url').value = item.url; $('session-name').value = item.name;
  document.querySelector(`input[name="profile"][value="${item.profile}"]`).checked = true;
  $('save-session').checked = true; $('form-title').textContent = 'Edit your session'; $('form-error').hidden = true; $('session-url').focus();
}
async function submitSession(connect) {
  if (!$('join-form').reportValidity()) return;
  $('form-error').hidden = true;
  $('join-button').disabled = true; $('save-only').disabled = true;
  try {
    const input = { id: editingId, url: $('session-url').value, name: $('session-name').value, profile: document.querySelector('input[name="profile"]:checked').value };
    if (!connect || $('save-session').checked) {
      const next = await invoke('save', input); editingId = next.savedId; input.id = editingId; render(next); $('form-title').textContent = 'Edit your session';
    } else input.id = null;
    if (connect) render(await invoke('connect', input));
    else toast('Session saved. Ready for game night.');
  } catch (error) { $('form-error').textContent = errorText(error); $('form-error').hidden = false; }
  finally { $('join-button').disabled = false; $('save-only').disabled = false; }
}

$('join-form').addEventListener('submit', event => { event.preventDefault(); submitSession(true); });
$('save-only').onclick = () => submitSession(false);
$('new-session').onclick = newSession;
$('empty-add').onclick = newSession;
document.querySelectorAll('.nav-button').forEach(button => { button.onclick = () => safely(() => showPage(button.dataset.page)); });
$('cancel-delete').onclick = () => $('delete-dialog').close();
$('confirm-delete').onclick = () => safely(async () => { render(await invoke('remove', deleteId)); if (editingId === deleteId) newSession(); $('delete-dialog').close(); toast('Saved session removed.'); });
$('library-toggle').onclick = () => safely(async () => { if (state.overlay) render(await invoke('overlay', false)); else await showPage('sessions'); });
$('quick-performance').onclick = () => safely(() => showPage('performance'));
$('live-fps').onclick = () => { liveFPS = !liveFPS; $('live-fps').setAttribute('aria-pressed', liveFPS); $('live-fps').textContent = liveFPS ? '— FPS' : 'FPS'; $('live-fps').title = 'Toggle live gameplay FPS'; if (liveFPS) refreshDiagnostics(); scheduleDiagnostics(); };
$('resume').onclick = () => safely(async () => render(await invoke('overlay', false)));
$('disconnect').onclick = () => safely(async () => render(await invoke('disconnect')));
$('retry').onclick = $('reload-game').onclick = () => safely(async () => render(await invoke('reload')));
$('focus-game').onclick = () => safely(async () => render(await invoke('focus')));
$('fullscreen').onclick = () => safely(() => invoke('fullscreen'));
$('open-sqyre').onclick = () => safely(() => invoke('sqyre'));
for (const action of ['minimize', 'maximize', 'close']) $(action).onclick = () => safely(() => invoke(action));
document.querySelector('.titlebar').addEventListener('pointerdown', event => {
  if (state?.runtime.backend === 'rust' && event.button === 0 && !event.target.closest('button')) safely(() => invoke('drag'));
});
for (const key of ['backgroundThrottle', 'keepAwake', 'allowMedia', 'preferDedicatedGpu', 'autoCheckUpdates']) $(`pref-${key}`).onchange = () => safely(async () => { render(await invoke('preferences', { [key]: $(`pref-${key}`).checked })); toast(key === 'preferDedicatedGpu' || (key === 'backgroundThrottle' && state.runtime.backend === 'rust') ? 'Preference saved. Restart the client to finish applying.' : 'Preference saved.'); });
$('check-updates').onclick = () => safely(async () => render(await invoke('check-updates')));
$('review-update').onclick = () => safely(() => showPage('preferences'));
$('download-update').onclick = () => safely(() => invoke('open-update', 'download'));
$('release-notes').onclick = () => safely(() => invoke('open-update', state.updates?.release ? 'release' : 'releases'));
$('apply-profile').onclick = () => safely(async () => {
  result('profile-result', 'Applying rendering settings…');
  try {
    const changed = await invoke('profile', performanceProfile);
    result('profile-result', `${state.profiles[performanceProfile].name} applied (${changed.applied.length} settings).${changed.skipped.length ? ` ${changed.skipped.length} unavailable settings skipped.` : ''}${changed.reload ? ' Reload the game to finish applying.' : ''}`);
    await refreshDiagnostics();
  } catch (error) { result('profile-result', errorText(error), true); }
}, $('apply-profile'));
$('restore-profile').onclick = () => safely(async () => {
  try { const changed = await invoke('restore'); result('profile-result', `Original rendering settings restored.${changed.reload ? ' Reload the game to finish applying.' : ''}`); await refreshDiagnostics(); }
  catch (error) { result('profile-result', errorText(error), true); }
}, $('restore-profile'));
$('clear-cache').onclick = () => safely(async () => { try { await invoke('cache', $('cache-session').value); result('cache-result', 'Asset cache cleared. Login and settings retained.'); } catch (error) { result('cache-result', errorText(error), true); } }, $('clear-cache'));
document.addEventListener('visibilitychange', scheduleDiagnostics);
document.addEventListener('keydown', event => {
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === 'F11') { event.preventDefault(); safely(() => invoke('fullscreen')); }
  else if (modifier && event.shiftKey && event.key.toLowerCase() === 'l') { event.preventDefault(); safely(() => showPage('sessions')); }
  else if (modifier && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); safely(async () => render(await invoke('focus'))); }
  else if (event.key === 'F5' || (modifier && event.key.toLowerCase() === 'r')) { event.preventDefault(); if (state?.active) safely(async () => render(await invoke('reload'))); }
});
window.client.onState(render);
safely(async () => {
  render(await invoke('state')); renderProfiles();
  // A short-lived capability probe initializes Chromium's lazy GPU diagnostics.
  // Release it immediately; the actual game owns its own rendering context.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (state.runtime.backend === 'rust') {
    const debug = probe?.getExtension('WEBGL_debug_renderer_info');
    await invoke('graphics', {webgl2: !!probe, renderer: debug ? probe.getParameter(debug.UNMASKED_RENDERER_WEBGL) : ''});
  }
  probe?.getExtension('WEBGL_lose_context')?.loseContext();
  await refreshDiagnostics();
});
