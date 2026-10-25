'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const adapter = require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/foundry-adapter.js'),'utf8');
const { readScript, settingsScript } = require('../src/foundry.cjs');

function mockGame(options = {}) {
  const values = { performanceMode: 2, maxFPS: 60, pixelRatioResolutionScaling: true };
  const writes = [];
  const definitions = new Map([
    ['core.performanceMode', { scope: 'client', type: Number, choices: { 0: 'Low', 1: 'Medium', 2: 'High' }, requiresReload: true }],
    ['core.maxFPS', { scope: options.worldFPS ? 'world' : 'client', type: Number, range: { min: 0, max: 120 } }],
    ['core.pixelRatioResolutionScaling', { scope: 'client', type: Boolean }]
  ]);
  const context = vm.createContext({ game: { ready: true, version: '14.368', settings: { settings: definitions, get: (_ns, key) => values[key], set: async (_ns, key, value) => { if (options.fail === key) throw new Error('fail'); writes.push([key, value]); values[key] = value; } } }, canvas: { app: { ticker: { FPS: 59.8 }, renderer: { gl: { texImage3D() {} } } } }, Number, Boolean });
  context.canvas.app.ticker.maxFPS = 60;
  return { values, writes, context };
}
test('diagnostics report real canvas values without creating a WebGL context', () => {
  const game = mockGame();
  const report = vm.runInContext(readScript(), game.context);
  assert.equal(report.fps, 60); assert.equal(report.webgl, 'WebGL 2'); assert.equal(report.version, '14.368'); assert.equal(game.writes.length, 0);
  assert.equal(vm.runInNewContext(readScript()).ready, false);
});
test('240 FPS and uncapped overrides are reversible and leave stored Foundry settings untouched', () => {
  const game=mockGame();
  const cap=limit=>vm.runInContext(adapter+';changeFrameLimit('+JSON.stringify(limit)+')',game.context);
  assert.equal(cap(240).maxFPS,240);
  assert.equal(cap(0).maxFPS,0);
  assert.equal(cap(null).maxFPS,60);
  assert.equal(game.values.maxFPS,60);
  assert.throws(()=>cap(999),/supported FPS/);
  game.context.canvas.app.ticker={FPS:60};
  assert.throws(()=>cap(240),/supported canvas/);
});
test('profiles skip world settings and unsupported keys', async () => {
  const game = mockGame({ worldFPS: true });
  const changed = await vm.runInContext(settingsScript({ performanceMode: 0, maxFPS: 30, pixelRatioResolutionScaling: false, dangerous: true }), game.context);
  assert.equal(game.values.performanceMode, 0); assert.equal(game.values.maxFPS, 60); assert.equal(game.values.pixelRatioResolutionScaling, false);
  assert.equal(changed.applied.length, 2); assert.ok(changed.skipped.includes('maxFPS')); assert.ok(changed.reload);
});
test('remembered world settings reapply on scene ready and restore original values', async () => {
  const sample=mockGame(),handlers=new Set();sample.context.game.world={id:'world'};
  sample.context.Hooks={on:(_name,fn)=>handlers.add(fn),off:(_name,fn)=>handlers.delete(fn)};
  const run=options=>vm.runInContext(adapter+';configureWorldSettings('+JSON.stringify(options)+')',sample.context);
  await run({settings:{performanceMode:0,maxFPS:30},fps:240});
  assert.equal(sample.values.maxFPS,30);assert.equal(sample.context.canvas.app.ticker.maxFPS,240);assert.equal(handlers.size,1);
  sample.context.canvas.app.ticker={maxFPS:30,FPS:30};sample.values.maxFPS=60;
  for(const fn of handlers)await fn();
  assert.equal(sample.values.maxFPS,30);assert.equal(sample.context.canvas.app.ticker.maxFPS,240);
  await run({settings:{performanceMode:2,maxFPS:60},fps:null,forget:true,restoreFPS:60});
  assert.equal(sample.values.maxFPS,60);assert.equal(sample.context.canvas.app.ticker.maxFPS,60);assert.equal(handlers.size,0);
});
test('settings rollback if an intermediate write fails', async () => {
  const game = mockGame({ fail: 'maxFPS' });
  await assert.rejects(vm.runInContext(settingsScript({ performanceMode: 0, maxFPS: 30 }), game.context), /restored/);
  assert.equal(game.values.performanceMode, 2); assert.equal(game.values.maxFPS, 60);
});
test('profiles reject invalid choice values and never apply before the world is ready', async () => {
  const game = mockGame();
  await assert.rejects(vm.runInContext(settingsScript({ performanceMode: 99, maxFPS: 500 }), game.context), /supported client/);
  game.context.game.ready = false;
  await assert.rejects(vm.runInContext(settingsScript({ maxFPS: 30 }), game.context), /Join a Foundry world/);
});
