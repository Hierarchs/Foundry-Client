'use strict';
const { _electron: electron, expect } = require('@playwright/test');
const path = require('node:path');
(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const application = await electron.launch({ executablePath: path.resolve('release/win-unpacked/Foundry Client.exe'), env });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Join a session', exact: true })).toBeVisible();
    const state = await page.evaluate(() => window.client.invoke('state'));
    const webgl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    if (!webgl2) throw new Error('This machine could not create the WebGL 2 context required by Foundry.');
    const gpu = await page.evaluate(() => window.client.invoke('diagnostics').then(d => d.gpu));
    const startupFlags = await application.evaluate(({ app }) => ({ gpuDisabled: app.commandLine.hasSwitch('disable-gpu'), dedicatedGPU: app.commandLine.hasSwitch('force_high_performance_gpu') }));
    console.log(JSON.stringify({ packaged: await application.evaluate(({ app }) => app.isPackaged), version: state.runtime, webgl2, startupFlags, gpu }));
    await page.screenshot({ path: path.resolve('test-results/packaged-launcher.png') });
    await page.setViewportSize({ width: 960, height: 680 });
    await expect(page.locator('#join-button')).toBeVisible();
    await page.screenshot({ path: path.resolve('test-results/launcher-small.png') });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Horizontal overflow at minimum window size.');
    console.log('Packaged client smoke check passed.');
  } finally { await application.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
