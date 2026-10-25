'use strict';
const { expect } = require('@playwright/test');
const { launch, world } = require('./test-native.cjs');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');
async function verify() {
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(world); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = path.join(root, '.test-data', `performance-${Date.now()}`); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'client-settings.json'), JSON.stringify({ sessions: [{ id: 'game', name: 'Campaign', url: base + '/join', profile: 'balanced', lastJoined: null }], preferences: { autoCheckUpdates: false } }));
  let app;
  try {
    app = await launch(data);
    const { page, context } = app;
    await page.evaluate(() => window.client.invoke('test-performance', { focusMain: true }));
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Join Campaign', exact: true }).click();
    let game; await expect.poll(() => { game = context.pages().find(p => p.url() === base + '/join'); return !!game; }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.client.invoke('state').then(s => s.world?.ready)), { timeout: 12000 }).toBe(true);
    await page.locator('#live-fps').click(); await expect(page.locator('#live-fps')).toHaveText('58 FPS');
    await page.evaluate(() => {
      window.hiddenPanelMutations = 0;
      const observer = new MutationObserver(records => { window.hiddenPanelMutations += records.length; });
      for (const id of ['playtime-worlds', 'session-list', 'runtime-details', 'cache-session']) observer.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true });
    });
    const before = await page.evaluate(() => window.client.invoke('test-performance'));
    await expect.poll(() => page.evaluate(() => window.client.invoke('test-performance').then(s => s.reads)), { timeout: 10000 }).toBeGreaterThanOrEqual(before.reads + 2);
    const after = await page.evaluate(() => window.client.invoke('test-performance'));
    expect(after.installs).toBe(before.installs);
    expect(await page.evaluate(() => window.hiddenPanelMutations)).toBe(0);
    expect(await page.evaluate(() => diagnosticTimer)).toBeNull();
    await page.locator('#quick-performance').click();
    await page.locator('#frame-limit').selectOption('240'); await page.locator('#apply-frame-limit').click();
    await expect(page.locator('#frame-limit-result')).toContainText('240 FPS');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await expect(page.locator('#pref-adaptiveFps')).not.toBeChecked();
    await expect(page.locator('#pref-economizePopouts')).toBeChecked();
    await page.locator('#pref-idleFps').selectOption('15'); await page.locator('#pref-adaptiveFps').check();
    await expect.poll(() => game.evaluate(() => canvas.app.ticker.maxFPS), { timeout: 12000 }).toBe(15);
    await expect(page.locator('#adaptive-status')).toContainText('restores 240 FPS');
    await expect(page.locator('#playtime-worlds')).toContainText('Native integration world');
    await page.locator('#resume').click(); await game.locator('#map').click();
    await expect.poll(() => game.evaluate(() => canvas.app.ticker.maxFPS)).toBe(240);
    await game.evaluate(() => { const adaptive = globalThis[Symbol.for('foundry-client.adaptive')]; adaptive.lastActivity -= 31000; adaptive.apply(); });
    expect(await game.evaluate(() => canvas.app.ticker.maxFPS)).toBe(15);
    await game.locator('#map').click(); expect(await game.evaluate(() => canvas.app.ticker.maxFPS)).toBe(240);
    await page.locator('#quick-performance').click(); await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await page.locator('#pref-adaptiveFps').uncheck();
    await expect.poll(() => game.evaluate(() => globalThis[Symbol.for('foundry-client.adaptive')] === undefined), { timeout: 12000 }).toBe(true);
    expect(await game.evaluate(() => canvas.app.ticker.maxFPS)).toBe(240);
    await expect(page.locator('#adaptive-status')).toHaveText('Adaptive FPS is off.');
    expect(errors).toEqual([]);
    console.log('Performance integration passed: combined sampling, one runtime installation, no hidden panel rebuilds, idle/input FPS restoration and preferences.');
  } catch (error) {
    if (app) {
      console.error('Performance state:', await app.page.evaluate(() => window.client.invoke('state')).catch(() => null));
      for (const game of app.context.pages().filter(p => p.url().startsWith(base))) console.error('Adaptive canvas:', await game.evaluate(() => { const a = globalThis[Symbol.for('foundry-client.adaptive')]; return { focused: document.hasFocus(), hidden: document.hidden, fps: canvas.app.ticker.maxFPS, adaptive: a && { enabled: a.enabled, idle: a.idle, error: a.error, target: a.target } }; }).catch(() => null));
    }
    throw error;
  } finally { if (app) await app.close(); await new Promise(resolve => server.close(resolve)); }
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
