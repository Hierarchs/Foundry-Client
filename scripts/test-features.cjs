'use strict';
const {expect}=require('@playwright/test');
const {launch,world}=require('./test-native.cjs');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
async function verify(){
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(world);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const data=path.join(root,'.test-data',`features-${Date.now()}`);fs.mkdirSync(data,{recursive:true});
  fs.writeFileSync(path.join(data,'client-settings.json'),JSON.stringify({sessions:[
    {id:'friday',name:'Friday campaign',url:base+'/join',profile:'balanced',group:'Friday',favorite:false,lastJoined:null},
    {id:'other',name:'Other campaign',url:base+'/other',profile:'balanced',group:'Saturday',favorite:false,lastJoined:null}
  ],preferences:{autoCheckUpdates:false},backups:{}}));
  let app;
  try{
    app=await launch(data);let {page,context}=app;
    await page.getByRole('button',{name:'Favorite Friday campaign',exact:true}).click();
    await page.locator('#favorites-only').check();await expect(page.locator('.session-card')).toHaveCount(1);
    await page.locator('#session-search').fill('Saturday');await expect(page.locator('#session-no-matches')).toBeVisible();
    await page.locator('#favorites-only').uncheck();await page.locator('#session-search').fill('');
    await page.locator('#session-group-filter').selectOption('Saturday');await expect(page.locator('.session-card')).toHaveCount(1);
    await expect(page.getByRole('heading',{name:'Other campaign',exact:true})).toBeVisible();
    await page.locator('#session-group-filter').selectOption('');
    await page.getByRole('button',{name:'Edit Friday campaign',exact:true}).click();
    await page.locator('#session-group').fill('Weekly');await page.locator('#save-only').click();
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.sessions.find(x=>x.id==='friday').group))).toBe('Weekly');
    await page.getByRole('button',{name:'Join Friday campaign',exact:true}).click();
    let game;await expect.poll(()=>{game=context.pages().find(p=>p.url()===base+'/join');return !!game;}).toBe(true);
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.world?.ready)),{timeout:12000}).toBe(true);
    await page.locator('#quick-performance').click();
    await page.getByRole('button',{name:'Preferences',exact:true}).click();
    await page.locator('#hud-compact').check();await page.locator('#hud-showTime').uncheck();await page.locator('#hud-showTitle').uncheck();
    await page.locator('#hud-focusKey').selectOption('H');await page.locator('#hud-libraryKey').selectOption('O');
    await expect(page.locator('#library-toggle')).toHaveAttribute('title', /Ctrl\+Shift\+O/);
    await expect(page.locator('body')).toHaveClass(/hud-compact/);await expect(page.locator('#live-playtime')).toBeHidden();
    await expect(page.locator('#active-title')).toBeHidden();
    await page.keyboard.press('Control+Shift+O');await expect(page.locator('#page-sessions')).toBeVisible();
    await page.keyboard.press('Control+Shift+H');await expect(page.locator('body')).toHaveClass(/focus-mode/);
    await page.keyboard.press('Control+Shift+H');await expect(page.locator('body')).not.toHaveClass(/focus-mode/);
    await page.locator('#quick-performance').click();
    await page.locator('input[name="performance-profile"][value="efficiency"]').check();
    await page.locator('#frame-limit').selectOption('240');await page.locator('#save-world-settings').click();
    await expect(page.locator('#world-settings-result')).toContainText('saved and applied');
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(240);
    expect(await game.evaluate(()=>game.settings.get('core','performanceMode'))).toBe(0);
    await game.evaluate(async()=>{canvas.app.ticker={FPS:60,maxFPS:60};await game.settings.set('core','performanceMode',2);await Hooks.callAll('canvasReady');});
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(240);
    expect(await game.evaluate(()=>game.settings.get('core','performanceMode'))).toBe(0);
    await Promise.all([game.waitForEvent('load'),page.locator('#reload-game').click()]);
    await expect.poll(()=>game.evaluate(()=>canvas?.app?.ticker?.maxFPS),{timeout:12000}).toBe(240);
    const hud=(await page.evaluate(()=>window.client.invoke('state'))).hud;expect(hud.focusKey).toBe('H');
    const crashed=app;crashed.child.kill();
    await expect.poll(()=>!crashed.browser.isConnected(),{timeout:15000}).toBe(true);app=null;
    app=await launch(data);({page,context}=app);
    await expect(page.locator('#recovery-banner')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/hud-compact/);
    expect((await page.evaluate(()=>window.client.invoke('state'))).sessions.find(s=>s.id==='friday').favorite).toBe(true);
    await page.locator('#recover-session').click();
    await expect.poll(()=>{game=context.pages().find(p=>p.url()===base+'/join');return !!game;}).toBe(true);
    await expect.poll(()=>game.evaluate(()=>canvas?.app?.ticker?.maxFPS),{timeout:12000}).toBe(240);
    await game.evaluate(()=>{game.socket.connected=false;});
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.status.phase)),{timeout:12000}).toBe('offline');
    await expect(page.locator('#reconnect-game')).toBeVisible();
    await Promise.all([game.waitForEvent('load'),page.locator('#reconnect-game').click()]);
    await expect.poll(()=>page.evaluate(()=>window.client.invoke('state').then(s=>s.status.phase)),{timeout:12000}).toBe('connected');
    await expect.poll(()=>game.evaluate(()=>canvas?.app?.ticker?.maxFPS),{timeout:12000}).toBe(240);
    await page.locator('#quick-performance').click();await page.locator('#forget-world-settings').click();
    await expect(page.locator('#world-settings-result')).toContainText('original values restored');
    expect(await game.evaluate(()=>canvas.app.ticker.maxFPS)).toBe(60);
    expect(await game.evaluate(()=>game.settings.get('core','performanceMode'))).toBe(2);
    await page.locator('#disconnect').click();
    expect((await page.evaluate(()=>window.client.invoke('state'))).recovery).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(data,'client-settings.json'),'utf8')).recovery).toBeNull();
    console.log(JSON.stringify({featureIntegration:'passed',organization:true,hud:true,rememberedWorlds:true,sceneReload:true,crashRecovery:true,reconnect:true}));
  }finally{if(app)await app.close();await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)verify().catch(error=>{console.error(error);process.exitCode=1;});
