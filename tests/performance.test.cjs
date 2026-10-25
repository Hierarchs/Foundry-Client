'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = ['performance-adapter.js', 'foundry-adapter.js'].map(file => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')).join('\n');

function fixture(maxFPS = 240) {
  let now = 0, focused = true, nextTimer = 0;
  const timers = new Map(), listeners = new Map(), values = { maxFPS: 60 };
  const on = (event, fn) => { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); };
  const off = (event, fn) => listeners.get(event)?.delete(fn);
  const context = vm.createContext({
    Number, Boolean, performance: { now: () => now },
    game: { ready: true, version: '14.368', world: { id: 'world', title: 'Campaign' }, socket: { connected: true }, settings: {
      settings: new Map([['core.maxFPS', { scope: 'client', type: Number, range: { min: 0, max: 120 } }]]),
      get: (_ns, key) => values[key], set: async (_ns, key, value) => { values[key] = value; }
    } },
    canvas: { app: { ticker: { maxFPS, FPS: 59.8 } } },
    document: { hidden: false, hasFocus: () => focused, addEventListener: on, removeEventListener: off },
    addEventListener: on, removeEventListener: off,
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  return {
    context, run, values, timers, listeners,
    enable: (enabled = true, idleFPS = 30) => run(`configureAdaptiveFPS(${JSON.stringify({ enabled, idleFPS })})`),
    emit: event => { for (const fn of listeners.get(event) || []) fn(); },
    focus(value) { focused = value; this.emit(value ? 'focus' : 'blur'); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at; timers.delete(due[0]); due[1].fn();
      }
      now = end;
    },
    get ticker() { return context.canvas.app.ticker; }
  };
}

test('adaptive FPS uses one idle timer and input immediately restores the active target', () => {
  const app = fixture();
  assert.equal(app.enable(false).enabled, false); assert.equal(app.timers.size, 0);
  app.enable();
  for (let i = 0; i < 10; i++) app.run('readClientTelemetry({enabled:true,idleFPS:30})');
  assert.equal(app.timers.size, 1);
  app.advance(20000); app.emit('pointermove'); app.advance(29999);
  assert.equal(app.ticker.maxFPS, 240);
  app.advance(1); assert.equal(app.ticker.maxFPS, 30); assert.equal(app.timers.size, 0);
  app.emit('keydown'); assert.equal(app.ticker.maxFPS, 240); assert.equal(app.timers.size, 1);
  app.focus(false); assert.equal(app.ticker.maxFPS, 30); assert.equal(app.timers.size, 0);
  app.focus(true); assert.equal(app.ticker.maxFPS, 240);
  app.run('configureAdaptiveFPS({enabled:true,idleFPS:15,inactive:true})');
  assert.equal(app.ticker.maxFPS, 15); assert.equal(app.timers.size, 0);
  app.run('configureAdaptiveFPS({enabled:true,idleFPS:15,inactive:false})');
  assert.equal(app.ticker.maxFPS, 240); assert.equal(app.timers.size, 1);
  app.enable(false); assert.equal(app.timers.size, 0);
  assert.equal([...app.listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0), 0);
});

test('idle ceiling never raises a lower cap and uncapped resumes correctly', () => {
  const app = fixture(20); app.enable(true, 60); app.focus(false);
  assert.equal(app.ticker.maxFPS, 20);
  assert.equal(app.run('changeFrameLimit(0)').maxFPS, 0); assert.equal(app.ticker.maxFPS, 60);
  app.focus(true); assert.equal(app.ticker.maxFPS, 0);
  app.context.document.hidden = true; app.emit('visibilitychange'); assert.equal(app.ticker.maxFPS, 60);
  app.enable(false); assert.equal(app.ticker.maxFPS, 0);
});

test('manual overrides, profile settings and restore retain active targets while idle', async () => {
  const app = fixture(); app.enable(); app.focus(false);
  assert.equal(app.run('changeFrameLimit(144)').maxFPS, 144); assert.equal(app.ticker.maxFPS, 30);
  assert.equal(app.run('readFoundry()').frameLimit, 144);
  assert.equal(app.run('changeFrameLimit(null)').maxFPS, 240); assert.equal(app.ticker.maxFPS, 30);
  await app.run('changeFoundrySettings({maxFPS:90})');
  assert.equal(app.values.maxFPS, 90); assert.equal(app.ticker.maxFPS, 30);
  app.focus(true); assert.equal(app.ticker.maxFPS, 90);
  app.focus(false); app.enable(false); assert.equal(app.ticker.maxFPS, 90);
});

test('external FPS changes and replacement canvases are respected without losing overrides', () => {
  const app = fixture(); app.enable(); app.focus(false);
  app.ticker.maxFPS = 120;
  app.run('changeFrameLimit(165)'); app.focus(true); assert.equal(app.ticker.maxFPS, 165);
  app.values.maxFPS = 60; app.enable(); // No change to the registered setting means the override still wins.
  assert.equal(app.ticker.maxFPS, 165);
  app.values.maxFPS = 90; app.enable(); assert.equal(app.ticker.maxFPS, 90);
  app.focus(false);
  const old = app.ticker; app.context.canvas.app.ticker = { maxFPS: 144, FPS: 140 };
  app.enable(); assert.equal(old.maxFPS, 90); assert.equal(app.ticker.maxFPS, 30);
  app.focus(true); assert.equal(app.ticker.maxFPS, 144);
});

test('missing canvases and unloaded worlds remove listeners and telemetry excludes disconnected time', () => {
  const app = fixture(); app.enable(); app.focus(false);
  const old = app.ticker; app.context.canvas.app.ticker = { FPS: 60 };
  assert.match(app.enable().error, /unavailable/); assert.equal(old.maxFPS, 240); assert.equal(app.timers.size, 0);
  app.context.canvas.app.ticker = old; app.context.game.ready = false;
  assert.equal(app.run('readClientTelemetry({enabled:true})').connection, 'loading');
  app.context.game.ready = true; app.context.game.socket.connected = false;
  const offline = app.run('readClientTelemetry({enabled:false})');
  assert.equal(offline.connection, 'offline'); assert.equal(offline.id, undefined);
  app.context.game.socket.connected = true;
  const online = app.run('readClientTelemetry({enabled:false})');
  assert.equal(online.id, 'world'); assert.equal(online.fps, 60);
});
