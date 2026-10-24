'use strict';
const { test, expect, _electron: electron } = require('@playwright/test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
let server, base;

// An integration fixture exercises the wrapper. This is not a licensed Foundry
// server and cannot substitute for a real-world V14 + Sqyre compatibility run.
const fixture = `<!doctype html><title>Integration world</title><style>body{background:#1a202a;color:#ddd;font:20px system-ui;padding:40px}</style><h1>Integration world</h1><button id="popout">Detach sheet</button><script>
const values=JSON.parse(localStorage.getItem('settings')||'{"performanceMode":2,"maxFPS":60,"pixelRatioResolutionScaling":true}');
const definitions=new Map([['core.performanceMode',{scope:'client',type:Number,choices:{0:'Low',1:'Medium',2:'High'}}],['core.maxFPS',{scope:'client',type:Number,range:{min:0,max:120}}],['core.pixelRatioResolutionScaling',{scope:'client',type:Boolean}]]);
window.game={ready:true,version:'14.368',settings:{settings:definitions,get:(_,k)=>values[k],set:async(_,k,v)=>{values[k]=v;localStorage.setItem('settings',JSON.stringify(values));return v}}};
window.canvas={app:{ticker:{FPS:58},renderer:{gl:{texImage3D(){}}}}};
document.querySelector('#popout').onclick=()=>{const w=window.open('about:blank','sheet');w.document.body.textContent='Detached sheet';};
document.cookie='foundry-test=kept; SameSite=Lax';
</script>`;

test.beforeAll(async () => {
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(fixture); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function launch(directory) {
  const env = { ...process.env, FOUNDRY_CLIENT_TEST: '1', FOUNDRY_CLIENT_TEST_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [root], cwd: root, env });
  app.process().stderr.on('data', data => process.stderr.write(data));
  let page;
  try { page = await app.firstWindow(); }
  catch (error) { await app.close().catch(() => {}); throw error; }
  await page.waitForFunction(() => !!window.client);
  await expect(page.getByRole('heading', { name: 'Join a session', exact: true })).toBeVisible();
  return { app, page };
}
async function gameContents(app) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => w.getURL().startsWith('http://127.0.0.1')).length);
}

test('session library, game isolation, profiles, popouts, and persistence', async () => {
  const data = path.join(root, '.test-data', `integration-${Date.now()}`);
  let { app, page } = await launch(data);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.screenshot({ path: path.join(root, 'test-results', 'launcher.png') });
    await page.getByLabel('Game join link').fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();
    await expect(page.locator('#form-error')).toContainText('HTTPS');
    await page.getByLabel('Game join link').fill(`${base}/join?invite=private`);
    await page.getByLabel('Session name').fill('Friday campaign');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Friday campaign', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'New session', exact: false }).click();
    await page.getByLabel('Game join link').fill(`${base}/second`);
    await page.getByLabel('Session name').fill('Saturday campaign');
    await page.getByRole('button', { name: 'Save only', exact: true }).click();
    await expect(page.locator('.session-card')).toHaveCount(2);

    await page.getByRole('button', { name: 'Join Friday campaign', exact: true }).click();
    await expect.poll(() => gameContents(app)).toBe(1);
    await expect.poll(() => page.evaluate(() => window.client.invoke('diagnostics').then(d => d.foundry?.ready))).toBe(true);
    const security = await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1'));
      const p = wc.getLastWebPreferences();
      return { nodeIntegration: p.nodeIntegration, contextIsolation: p.contextIsolation, sandbox: p.sandbox, webSecurity: p.webSecurity, preload: p.preload || null };
    });
    expect(security).toEqual({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: null });
    expect(await app.evaluate(async ({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1')).executeJavaScript('typeof window.client+":"+typeof require'))).toBe('undefined:undefined');
    await page.locator('#live-fps').click();
    await expect(page.locator('#live-fps')).toHaveText('58 FPS');
    await page.locator('#live-fps').click();
    await page.locator('#quick-performance').click();
    await expect(page.getByRole('heading', { name: 'Rendering profiles' })).toBeVisible();
    await expect(page.locator('#metric-fps')).toHaveText('58');
    await page.locator('input[name="performance-profile"][value="efficiency"]').check();
    await page.getByRole('button', { name: 'Apply to current world' }).click();
    await expect(page.locator('#profile-result')).toContainText('Efficiency applied (3 settings)');
    const values = await app.evaluate(async ({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1')).executeJavaScript('JSON.parse(localStorage.getItem("settings"))'));
    expect(values).toEqual({ performanceMode: 0, maxFPS: 30, pixelRatioResolutionScaling: false });
    await page.getByRole('button', { name: 'Restore original settings' }).click();
    await expect(page.locator('#profile-result')).toContainText('Original rendering settings restored');
    await app.evaluate(async ({ webContents }) => webContents.getAllWebContents().find(w => w.getURL().startsWith('http://127.0.0.1')).executeJavaScript('document.querySelector("#popout").click()'));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await page.getByRole('button', { name: 'Session library' }).click();
    await page.getByRole('button', { name: 'Join Saturday campaign', exact: true }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect.poll(() => gameContents(app)).toBe(1);
    await page.locator('#library-toggle').click();
    await page.locator('#disconnect').click();
    await expect(page.locator('#game-tools')).toBeHidden();
    await expect.poll(() => gameContents(app)).toBe(0);
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    await page.locator('#pref-keepAwake').uncheck();
    await expect.poll(() => page.evaluate(() => window.client.invoke('state').then(s => s.preferences.keepAwake))).toBe(false);
    await page.locator('#clear-cache').click();
    await expect(page.locator('#cache-result')).toContainText('Asset cache cleared');
    await page.getByRole('button', { name: 'Session library', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Friday campaign', exact: true }).click();
    await page.getByLabel('Game join link').fill(`${base}/one-off`);
    await page.locator('#save-session').uncheck();
    await page.locator('#join-button').click();
    await expect.poll(() => page.evaluate(() => window.client.invoke('state').then(s => s.active?.url))).toBe(`${base}/one-off`);
    await page.locator('#library-toggle').click();
    await page.locator('#disconnect').click();
    expect(errors).toEqual([]);
    await app.close();
    ({ app, page } = await launch(data));
    await expect(page.locator('.session-card')).toHaveCount(2);
    const saved = await page.evaluate(() => window.client.invoke('state'));
    expect(saved.sessions.find(s => s.name === 'Friday campaign').url).toContain('?invite=private');
    expect(saved.preferences.keepAwake).toBe(false);
  } finally { await app.close(); }
});

test('unreachable host returns a recoverable error and releases the game on disconnect', async () => {
  const data = path.join(root, '.test-data', `failure-${Date.now()}`);
  const { app, page } = await launch(data);
  try {
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    await page.getByLabel('Game join link').fill(`http://127.0.0.1:${port}`);
    await page.getByRole('button', { name: 'Join session', exact: false }).click();
    await expect(page.locator('#connection-message')).toContainText('Connection failed');
    await expect(page.locator('#retry')).toBeVisible();
    await page.locator('#disconnect').click();
    await expect(page.locator('#game-tools')).toBeHidden();
    await expect.poll(() => gameContents(app)).toBe(0);
  } finally { await app.close(); }
});
