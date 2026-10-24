'use strict';
const { expect } = require('@playwright/test');
const { launch } = require('./test-native.cjs');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const installed = require('../package.json').version;
const newer = '99.10.0';
const base = 'https://github.com/Hierarchs/Foundry-Client/releases';
function release(version, portable = false) {
  const name = portable ? `Foundry-Client-Rust-${version}-x64.zip` : `Foundry-Client-Rust-Setup-${version}-x64.exe`;
  return {tag_name:`v${version}`,draft:false,prerelease:false,assets:[{name,state:'uploaded',browser_download_url:`${base}/download/v${version}/${name}`}]};
}
async function verify() {
  let reply = {status:200,body:release(newer)}, held = null, hold = true, requests = 0;
  const server = http.createServer((req,res) => {
    requests++;
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers['user-agent']).toContain(`Foundry-Client/${installed}`);
    const respond = () => {
      if(reply.status === 0) {res.destroy();return;}
      res.writeHead(reply.status,{'Content-Type':'application/json',...(reply.status === 302 ? {Location:'http://127.0.0.1:9'} : {})});
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    };
    if (hold) held = respond; else respond();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const options = {updateUrl:`http://127.0.0.1:${server.address().port}/latest`};
  const data = path.join(root,'.test-data',`updates-${Date.now()}`);
  fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'client-settings.json'),JSON.stringify({sessions:[],preferences:{autoCheckUpdates:false},backups:{}}));
  let app;
  try {
    app = await launch(data,options);
    let page = app.page;
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.locator('#update-version')).toHaveText(`Installed version ${installed}`);
    expect(requests).toBe(0);
    await page.locator('#check-updates').click();
    await expect.poll(()=>!!held).toBe(true);
    await expect(page.locator('#check-updates')).toBeDisabled();
    // The HTTP response remains pending while the UI and native RPC still work.
    const during = await page.evaluate(()=>window.client.invoke('state'));
    expect(during.updates.status).toBe('checking');
    await page.evaluate(()=>Promise.all([window.client.invoke('check-updates'),window.client.invoke('check-updates')]));
    expect(requests).toBe(1);
    hold=false;held();held=null;
    await expect(page.locator('#update-status')).toContainText(`${newer} is available`);
    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#download-update')).toHaveText('Download installer');
    expect(await page.evaluate(()=>window.client.invoke('open-update','download'))).toBe(release(newer).assets[0].browser_download_url);
    expect(await page.evaluate(()=>window.client.invoke('open-update','release'))).toBe(`${base}/tag/v${newer}`);
    expect(await page.evaluate(()=>window.client.invoke('open-update','file:///C:/evil.exe').then(()=>false,()=>true))).toBe(true);
    fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
    await page.screenshot({path:path.join(root,'test-results','update-checker.png')});
    async function check(status,body,expected) {
      reply={status,body};
      await page.locator('#check-updates').click();
      await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.updates.status))).toBe(expected);
      await expect(page.locator('#check-updates')).toBeEnabled();
    }
    await check(200,release(installed),'upToDate');
    await expect(page.locator('#download-update')).toBeHidden();
    await expect(page.locator('#update-banner')).toBeHidden();
    await check(200,release('0.1.0'),'upToDate');
    await check(404,{},'noRelease');
    await expect(page.locator('#update-status')).toContainText('No public stable release');
    await check(429,{},'error');
    await expect(page.locator('#update-status')).toContainText('limiting update checks');
    await check(302,{},'error');
    await expect(page.locator('#update-status')).toContainText('update service is unavailable');
    await check(0,{},'error');
    await expect(page.locator('#update-status')).toContainText('Check your connection');
    await check(200,'invalid json','error');
    const unsafe=release(newer);unsafe.assets[0].browser_download_url='https://evil.example/installer.exe';
    await check(200,unsafe,'available');
    await expect(page.locator('#download-update')).toBeHidden();
    await check(200,release(newer,true),'available');
    await expect(page.locator('#download-update')).toHaveText('Download portable ZIP');
    await page.locator('#pref-autoCheckUpdates').check();
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.preferences.autoCheckUpdates))).toBe(true);
    await app.close();
    const before=requests;reply={status:200,body:release(newer)};
    app=await launch(data,options);page=app.page;
    await expect(page.locator('#update-banner')).toBeVisible();
    expect(requests).toBe(before+1);
    await page.locator('#review-update').click();
    await expect(page.locator('#update-panel')).toBeVisible();
    await expect(page.locator('#pref-autoCheckUpdates')).toBeChecked();
    await page.locator('#pref-autoCheckUpdates').uncheck();
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.preferences.autoCheckUpdates))).toBe(false);
    await app.close();
    const disabled=requests;
    app=await launch(data,options);
    expect((await app.page.evaluate(()=>window.client.invoke('state'))).updates.status).toBe('idle');
    expect(requests).toBe(disabled);
    console.log(JSON.stringify({updateIntegration:'passed',requests,manual:true,startupPreference:true,versionChecks:true,restrictedDownloads:true}));
  } finally {if(held){hold=false;held();}if(app)await app.close();await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
