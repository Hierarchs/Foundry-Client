'use strict';
const { chromium, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = process.env.FOUNDRY_NATIVE_TEST_EXE || path.join(root, 'native/target/debug/foundry-client.exe');

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function launch(data, options = {}) {
  const port = await freePort();
  const child = spawn(executable, [], { cwd: root, windowsHide: true, env: { ...process.env, FOUNDRY_CLIENT_TEST: '1', FOUNDRY_CLIENT_TEST_USER_DATA: data, FOUNDRY_CLIENT_DEBUG_PORT: String(port), FOUNDRY_CLIENT_UPDATE_TEST_URL: options.updateUrl || 'http://127.0.0.1:9' }, stdio: ['ignore','pipe','pipe'] });
  let output = '';
  child.stdout.on('data', d => { output += d; }); child.stderr.on('data', d => { output += d; });
  let browser;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`Rust app exited ${child.exitCode}: ${output}`);
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500 }); break; } catch { await delay(100); }
  }
  if (!browser) { child.kill(); throw new Error(`Could not connect to native test driver: ${output}`); }
  const context = browser.contexts()[0];
  let page;
  await expect.poll(() => {
    page = context.pages().find(p => p.url().includes('foundry.localhost/index.html'));
    return !!page;
  }).toBe(true);
  page.on('pageerror', e => process.stderr.write(`Native UI: ${e.message}\n`));
  await page.waitForFunction(() => !!window.client);
  await expect(page.getByRole('heading', { name:'Join a session', exact:true })).toBeVisible();
  return {
    browser, context, page, child, get output() { return output; },
    async close() {
      await page.evaluate(() => { window.client.invoke('close').catch(() => {}); }).catch(() => {});
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
      if (child.exitCode === null) child.kill();
      await browser.close().catch(() => {});
    }
  };
}

const world = `<!doctype html><title>Native integration world</title><style>body{background:#151d29;color:#ddd;font:20px system-ui;padding:40px}canvas{width:400px;height:200px}</style><h1>Native integration world</h1><button id="popout">Detach sheet</button><canvas id="map"></canvas><script>
const values=JSON.parse(localStorage.getItem('settings')||'{"performanceMode":2,"maxFPS":60,"pixelRatioResolutionScaling":true}');
const definitions=new Map([['core.performanceMode',{scope:'client',type:Number,choices:{0:'Low',1:'Medium',2:'High'}}],['core.maxFPS',{scope:'client',type:Number,range:{min:0,max:120}}],['core.pixelRatioResolutionScaling',{scope:'client',type:Boolean}]]);
window.game={ready:true,version:'14.368',world:{id:'native-world',title:'Native integration world'},socket:{connected:true},settings:{settings:definitions,get:(_,k)=>values[k],set:async(_,k,v)=>{await new Promise(r=>setTimeout(r,20));values[k]=v;localStorage.setItem('settings',JSON.stringify(values));return v}}};
const gl=document.querySelector('#map').getContext('webgl2');
window.canvas={app:{ticker:{FPS:58,maxFPS:60},renderer:{gl}}};
if(gl){gl.clearColor(.12,.18,.22,1);gl.clear(gl.COLOR_BUFFER_BIT)}
document.querySelector('#popout').onclick=()=>{const w=window.open('about:blank','sheet');window.detached=w;if(w)w.document.body.textContent='Detached native sheet';};
document.cookie='native-cookie=kept; Max-Age=86400; SameSite=Lax';
</script>`;

async function verify() {
  const server = http.createServer((_req,res) => {res.setHeader('Content-Type','text/html'); res.end(world);});
  // A different loopback address exercises HTTP outside the old localhost-only
  // allowlist without exposing the fixture on a physical network interface.
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.2',resolve);});
  const base = `http://127.0.0.2:${server.address().port}`;
  const data = path.join(root,'.test-data',`native-${Date.now()}`);
  fs.mkdirSync(data,{recursive:true});
  // Exercise migration from an existing Electron-format saved session.
  fs.writeFileSync(path.join(data,'client-settings.json'),JSON.stringify({sessions:[{id:'legacy-id',name:'Imported campaign',url:`${base}/join?invite=kept`,profile:'balanced',lastJoined:null}],preferences:{backgroundThrottle:true,keepAwake:false,allowMedia:false,preferDedicatedGpu:true,autoCheckUpdates:false},backups:{}}));
  let application;
  try {
    application = await launch(data);
    let {page,context} = application;
    const state = await page.evaluate(() => window.client.invoke('state'));
    if (state.runtime.backend !== 'rust') throw new Error('Rust host was not running.');
    await expect(page.locator('.session-card')).toHaveCount(1);
    await expect(page.locator('#engine-label')).toHaveText('GPU acceleration active');
    await page.screenshot({path:path.join(root,'test-results/native-launcher.png')});
    await page.getByLabel('Game join link').fill('javascript:alert(1)');
    await page.locator('#save-only').click();
    await expect(page.locator('#form-error')).toContainText('HTTPS');
    await page.getByLabel('Game join link').fill(`${base}/second`);
    await page.getByLabel('Session name').fill('Second campaign');
    await page.locator('#save-only').click();
    await expect(page.locator('.session-card')).toHaveCount(2);
    await page.getByRole('button',{name:'Join Imported campaign',exact:true}).click();
    let game;
    await expect.poll(() => { game=context.pages().find(p=>p.url().startsWith(base+'/join'));return !!game;}).toBe(true);
    await game.waitForFunction(()=>game?.ready);
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.playtime.tracking)),{timeout:12000}).toBe(true);
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.playtime.totalSeconds)),{timeout:12000}).toBeGreaterThanOrEqual(5);
    await game.evaluate(()=>{game.ready=false;});
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.playtime.tracking)),{timeout:12000}).toBe(false);
    const counted=await page.evaluate(()=>window.client.invoke('state').then(s=>s.playtime.totalSeconds));
    await game.evaluate(()=>{game.ready=true;game.socket.connected=false;});
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.playtime.totalSeconds))).toBe(counted);
    await game.evaluate(()=>{game.socket.connected=true;});
    await expect(page.locator('#library-toggle')).toHaveText('Sessions');
    await expect(page.locator('#launcher')).toBeHidden();
    const isolation=await game.evaluate(()=>({bridge:typeof window.client,node:typeof require,ipc:typeof window.ipc,webgl:!!canvas.app.renderer.gl}));
    expect(isolation).toEqual({bridge:'undefined',node:'undefined',ipc:'undefined',webgl:true});
    await page.locator('#live-fps').click();
    await expect(page.locator('#live-fps')).toHaveText('58 FPS');
    await page.locator('#quick-performance').click();
    await page.locator('#frame-limit').selectOption('240');
    await page.locator('#apply-frame-limit').click();
    await expect(page.locator('#frame-limit-result')).toContainText('240 FPS');
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(240);
    await page.locator('#frame-limit').selectOption('0');
    await page.locator('#apply-frame-limit').click();
    await expect(page.locator('#frame-limit-result')).toContainText('Uncapped canvas');
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(0);
    await page.locator('#restore-frame-limit').click();
    await expect(page.locator('#frame-limit-result')).toContainText('restored');
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(60);
    await page.locator('input[name="performance-profile"][value="efficiency"]').check();
    await page.locator('#apply-profile').click();
    await expect(page.locator('#profile-result')).toContainText('Efficiency applied (3 settings)');
    expect(await game.evaluate(()=>JSON.parse(localStorage.getItem('settings')))).toEqual({performanceMode:0,maxFPS:30,pixelRatioResolutionScaling:false});
    // Applying asynchronous settings and their backups must survive a restart.
    await application.close(); application = await launch(data); ({page,context}=application);
    expect((await page.evaluate(()=>window.client.invoke('state'))).playtime.totalSeconds).toBeGreaterThanOrEqual(counted);
    expect((await page.evaluate(()=>window.client.invoke('state'))).playtime.tracking).toBe(false);
    await page.getByRole('button',{name:'Join Imported campaign',exact:true}).click();
    await expect.poll(()=>{game=context.pages().find(p=>p.url().startsWith(base+'/join'));return !!game;}).toBe(true);
    await game.waitForFunction(()=>game?.ready);
    await expect(page.locator('#library-toggle')).toHaveText('Sessions');
    await expect(page.locator('#launcher')).toBeHidden();
    expect(await game.evaluate(()=>JSON.parse(localStorage.getItem('settings')).maxFPS)).toBe(30);
    expect(await game.evaluate(()=>document.cookie)).toContain('native-cookie=kept');
    await page.locator('#quick-performance').click();
    await page.locator('#restore-profile').click();
    await expect(page.locator('#profile-result')).toContainText('Original rendering settings restored');
    expect(await game.evaluate(()=>game.settings.get('core','maxFPS'))).toBe(60);
    await page.locator('#resume').click();
    await game.locator('#popout').click();
    expect(await game.evaluate(()=>({exists:!!window.detached,body:window.detached?.document.body.textContent,bridge:typeof window.detached?.client})))
      .toEqual({exists:true,body:'Detached native sheet',bridge:'undefined'});
    // WebView2 pop-outs retain the opener's browser context; Playwright does not
    // expose them through its default context. Inspect the native CDP target.
    const targets = await application.browser.newBrowserCDPSession();
    const popupTarget = (await targets.send('Target.getTargets')).targetInfos.find(t=>t.url==='about:blank');
    expect(popupTarget).toBeTruthy();
    await page.evaluate(()=>window.client.invoke('test-layout',{}));
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('test-layout').then(p=>p[0]?.width))).toBe(760);
    const savedPlacement=(await page.evaluate(()=>window.client.invoke('test-layout')))[0];
    await game.evaluate(()=>window.detached.close());
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('test-layout').then(p=>p.length))).toBe(0);
    await game.locator('#popout').click();
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('test-layout').then(p=>p[0]?.width))).toBe(savedPlacement.width);
    expect((await page.evaluate(()=>window.client.invoke('test-layout')))[0].height).toBe(savedPlacement.height);
    await expect.poll(()=>JSON.parse(fs.readFileSync(path.join(data,'client-settings.json'),'utf8')).layouts && Object.keys(JSON.parse(fs.readFileSync(path.join(data,'client-settings.json'),'utf8')).layouts).length).toBeGreaterThan(1);
    await page.locator('#library-toggle').click();
    await page.getByRole('button',{name:'Session library',exact:true}).click();
    await page.getByRole('button',{name:'Join Second campaign',exact:true}).click();
    await expect.poll(async()=> (await targets.send('Target.getTargets')).targetInfos.some(t=>t.targetId===popupTarget.targetId)).toBe(false);
    await expect.poll(()=>context.pages().filter(p=>p.url().startsWith(base)).length).toBe(1);
    await expect(page.locator('#library-toggle')).toHaveText('Sessions');
    await expect(page.locator('#launcher')).toBeHidden();
    await page.locator('#library-toggle').click();
    await expect(page.locator('#disconnect')).toBeVisible();
    await page.locator('#disconnect').click();
    await expect.poll(()=>context.pages().filter(p=>p.url().startsWith(base)).length).toBe(0);
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await page.locator('#clear-cache').click();
    await expect(page.locator('#cache-result')).toContainText('Asset cache cleared');
    await page.getByRole('button',{name:'Session library',exact:true}).click();
    await page.getByRole('button',{name:'Edit Imported campaign',exact:true}).click();
    const unavailable = await freePort();
    await page.getByLabel('Game join link').fill(`http://127.0.0.1:${unavailable}`);
    await page.locator('#save-session').uncheck();
    await page.locator('#join-button').click();
    await expect(page.locator('#connection-message')).toContainText('Connection failed');
    await expect(page.locator('#retry')).toBeVisible();
    await page.locator('#disconnect').click();
    const diagnostic=await page.evaluate(()=>window.client.invoke('diagnostics'));
    await application.close();application=await launch(data);({page,context}=application);
    await page.getByRole('button',{name:'Join Imported campaign',exact:true}).click();
    await expect.poll(()=>{game=context.pages().find(p=>p.url().startsWith(base+'/join'));return !!game;}).toBe(true);
    await game.waitForFunction(()=>game?.ready);
    await game.locator('#popout').click();
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('test-layout').then(p=>p[0]?.width))).toBe(savedPlacement.width);
    expect((await page.evaluate(()=>window.client.invoke('test-layout')))[0].height).toBe(savedPlacement.height);
    console.log(JSON.stringify({nativeIntegration:'passed',runtime:state.runtime,diagnostic},null,2));
  } catch(error) {
    console.error('Native integration failure:',error);
    if(application) {
      console.error('Native process output:',application.output);
      console.error('Native exit:',application.child.exitCode,application.child.signalCode);
      console.error('Native pages:',application.browser.contexts().map(c=>c.pages().map(p=>p.url())));
      console.error('Native targets:',await application.browser.newBrowserCDPSession().then(s=>s.send('Target.getTargets')).catch(()=>null));
      console.error('Native state:',await application.page.evaluate(()=>window.client.invoke('state')).catch(()=>null));
    }
    throw error;
  } finally { if(application)await application.close();await new Promise(resolve=>server.close(resolve)); }
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={launch};
