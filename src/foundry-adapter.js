'use strict';

async function configureWorldSettings(options) {
  const g=globalThis.game;
  if(!g?.ready || !g.world?.id) throw new Error('Join a loaded world first.');
  const key=Symbol.for('foundry-client.world-settings'), previous=globalThis[key];
  const hooks=globalThis.Hooks || globalThis.foundry?.helpers?.Hooks;
  const before=readFoundry().settings, ticker=globalThis.canvas?.app?.ticker, oldFPS=clientFrameTarget(ticker);
  if(previous?.handler && hooks?.off) hooks.off('canvasReady',previous.handler);
  try {
    const desired=Object.fromEntries(Object.entries(options.settings || {}).filter(([name,value])=>before[name]!==value));
    let result={applied:[],skipped:[],reload:false};
    if(Object.keys(desired).length) result=await changeFoundrySettings(desired,!!options.forget);
    if(options.forget) {
      if(ticker && typeof oldFPS==='number') changeFrameLimit(null);
      if(ticker && Number.isFinite(options.restoreFPS)) setClientFrameTarget(ticker,options.restoreFPS);
      delete globalThis[key];return result;
    }
    if(!hooks?.on || !hooks?.off) throw new Error('This world does not expose supported scene-ready hooks.');
    const state={id:String(g.world.id),error:'',handler:null,busy:false};
    if(options.fps !== null && options.fps !== undefined) changeFrameLimit(options.fps);
    state.handler=async()=>{
      if(globalThis.game!==g || !g.ready || String(g.world?.id)!==state.id || state.busy)return;
      state.busy=true;
      try {
        const current=readFoundry().settings;
        const changed=Object.fromEntries(Object.entries(options.settings||{}).filter(([name,value])=>current[name]!==value));
        if(Object.keys(changed).length) await changeFoundrySettings(changed);
        if(options.fps !== null && options.fps !== undefined) changeFrameLimit(options.fps);
        state.error='';
      }catch(error){state.error=String(error.message||error);}finally{state.busy=false;}
    };
    hooks.on('canvasReady',state.handler);
    globalThis[key]=state;
    return result;
  } catch(error) {
    try {if(Object.keys(before).length) await changeFoundrySettings(before,true);if(ticker && Number.isFinite(oldFPS))setClientFrameTarget(ticker,oldFPS);}catch{/* Keep the original failure visible. */}
    if(previous?.handler && hooks?.on) hooks.on('canvasReady',previous.handler);
    globalThis[key]=previous;
    throw error;
  }
}

function changeFrameLimit(limit) {
  if (!globalThis.game?.ready || !/^14(?:\.|$)/.test(String(game.version))) throw new Error('Join a Foundry V14 world first.');
  const ticker = globalThis.canvas?.app?.ticker;
  if (!ticker || typeof ticker.maxFPS !== 'number' || !Number.isFinite(ticker.maxFPS)) throw new Error('This world does not expose a supported canvas FPS limiter.');
  if (limit !== null && ![0,30,60,90,120,144,165,180,240].includes(limit)) throw new Error('Choose a supported FPS limit.');
  const key = Symbol.for('foundry-client.frame-limit-backups');
  const backups = globalThis[key] ||= new WeakMap();
  if (limit === null && !backups.has(ticker)) return {maxFPS:clientFrameTarget(ticker),restored:true};
  const original = clientFrameTarget(ticker), first = !backups.has(ticker);
  if (first) backups.set(ticker, original);
  const target = limit === null ? backups.get(ticker) : limit;
  try {
    setClientFrameTarget(ticker,target);
  } catch (error) { setClientFrameTarget(ticker,original); if(first)backups.delete(ticker); throw error; }
  if (limit === null) backups.delete(ticker);
  return {maxFPS:target,restored:limit === null};
}

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
    frameLimit: Number.isFinite(clientFrameTarget(c?.app?.ticker)) ? clientFrameTarget(c.app.ticker) : null,
    webgl: gl ? (typeof gl.texImage3D === 'function' ? 'WebGL 2' : 'WebGL 1') : null,
    settings: values
  };
}

async function changeFoundrySettings(requested, restore = false) {
  const g = globalThis.game;
  if (!g?.ready || !g.settings?.settings) throw new Error('Join a Foundry world before applying a rendering profile.');
  const before = {}, applied = [], skipped = [];
  const ticker = globalThis.canvas?.app?.ticker, beforeFPS = clientFrameTarget(ticker);
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
    for (const [key, value] of plan) { await g.settings.set('core', key, value); applied.push(key); if(key==='maxFPS'&&Number.isFinite(globalThis.canvas?.app?.ticker?.maxFPS))setClientFrameTarget(canvas.app.ticker,value); }
  } catch (error) {
    let rollbackFailed = false;
    for (const key of applied.reverse()) { try { await g.settings.set('core', key, before[key]);if(key==='maxFPS'&&Number.isFinite(globalThis.canvas?.app?.ticker?.maxFPS))setClientFrameTarget(canvas.app.ticker,before[key]); } catch { rollbackFailed = true; } }
    if (Number.isFinite(beforeFPS)) { try { setClientFrameTarget(ticker, beforeFPS); } catch { rollbackFailed = true; } }
    throw new Error(rollbackFailed ? 'A setting failed and rollback was incomplete. Check Foundry’s Configure Settings menu.' : 'Could not apply settings; previous values were restored.');
  }
  return { before, applied, skipped, restore, reload: plan.some(([key]) => !!g.settings.settings.get(`core.${key}`).requiresReload) };
}
