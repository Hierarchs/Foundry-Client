'use strict';

function readFoundry() {
  const g = globalThis.game;
  const c = globalThis.canvas;
  const fps = c?.app?.ticker?.FPS;
  const values = {};
  for (const key of ['performanceMode', 'maxFPS', 'pixelRatioResolutionScaling']) {
    try { if (g?.settings?.settings?.has(`core.${key}`)) values[key] = g.settings.get('core', key); } catch { /* Not initialized. */ }
  }
  const gl = c?.app?.renderer?.gl;
  return {
    ready: !!g?.ready,
    version: String(g?.version || '').slice(0, 40),
    fps: typeof fps === 'number' && Number.isFinite(fps) ? Math.round(fps) : null,
    webgl: gl ? (typeof gl.texImage3D === 'function' ? 'WebGL 2' : 'WebGL 1') : null,
    settings: values
  };
}

async function changeFoundrySettings(requested, restore = false) {
  const g = globalThis.game;
  if (!g?.ready || !g.settings?.settings) throw new Error('Join a Foundry world before applying a rendering profile.');
  const before = {}, applied = [], skipped = [];
  // Preflight everything before any writes. Only registered client settings qualify.
  const plan = [];
  for (const [key, value] of Object.entries(requested)) {
    if (!['performanceMode', 'maxFPS', 'pixelRatioResolutionScaling'].includes(key)) continue;
    const definition = g.settings.settings.get(`core.${key}`);
    if (!definition || definition.scope !== 'client') { skipped.push(key); continue; }
    if ((definition.type === Number && (typeof value !== 'number' || !Number.isFinite(value))) ||
        (definition.type === Boolean && typeof value !== 'boolean')) { skipped.push(key); continue; }
    if (definition.choices && !Object.hasOwn(definition.choices, String(value))) { skipped.push(key); continue; }
    if (definition.range && (value < definition.range.min || value > definition.range.max)) { skipped.push(key); continue; }
    before[key] = g.settings.get('core', key);
    plan.push([key, value]);
  }
  if (!plan.length) throw new Error('This world does not expose supported client rendering settings. Use Foundry’s Configure Settings menu.');
  try {
    for (const [key, value] of plan) { await g.settings.set('core', key, value); applied.push(key); }
  } catch (error) {
    let rollbackFailed = false;
    for (const key of applied.reverse()) { try { await g.settings.set('core', key, before[key]); } catch { rollbackFailed = true; } }
    throw new Error(rollbackFailed ? 'A setting failed and rollback was incomplete. Check Foundry’s Configure Settings menu.' : 'Could not apply settings; previous values were restored.');
  }
  return { before, applied, skipped, restore, reload: plan.some(([key]) => !!g.settings.settings.get(`core.${key}`).requiresReload) };
}
