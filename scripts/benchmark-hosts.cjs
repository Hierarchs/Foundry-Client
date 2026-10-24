'use strict';
const { _electron: electron }=require('@playwright/test');
const { launch: launchNative }=require('./test-native.cjs');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const root=path.resolve(__dirname,'..');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)];};
const fixture=`<!doctype html><title>Host overhead fixture</title><style>body{margin:0;background:#17202c}canvas{width:100vw;height:100vh}</style><canvas></canvas><script>const gl=document.querySelector('canvas').getContext('webgl2');if(gl){gl.clearColor(.1,.15,.2,1);gl.clear(gl.COLOR_BUFFER_BIT)};window.game={ready:true,version:'14.368'};window.canvas={app:{renderer:{gl}}};</script>`;
async function launchElectron(data) {
  const env={...process.env,FOUNDRY_CLIENT_TEST:'1',FOUNDRY_CLIENT_TEST_USER_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
  const app=await electron.launch({args:[root],cwd:root,env});
  const page=await app.firstWindow();await page.waitForFunction(()=>!!window.client);
  return{page,close:()=>app.close()};
}
async function samples(page) {
  const collected=[];
  for(let i=0;i<5;i++){await wait(600);collected.push(await page.evaluate(()=>window.client.invoke('diagnostics')));}
  return{memoryMB:median(collected.map(s=>s.memoryMB)),cpuPercent:median(collected.map(s=>s.cpuPercent)),processCount:median(collected.map(s=>s.processCount))};
}
async function main(){
  const server=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${server.address().port}/world`;
  const runs=[];
  try{
    for(const backend of ['rust','electron','electron','rust','rust','electron']){
      const data=path.join(root,'.test-data',`benchmark-${backend}-${Date.now()}`);
      const app=backend==='rust'?await launchNative(data):await launchElectron(data);
      try{
        await wait(1500);
        const launcher=await samples(app.page);
        const runtime=await app.page.evaluate(()=>window.client.invoke('state').then(s=>s.runtime));
        await app.page.evaluate(url=>window.client.invoke('connect',{url,name:'Overhead test',profile:'balanced'}),url);
        await wait(1800);
        const game=await samples(app.page);
        runs.push({backend,runtime,launcher,game});
        console.log(JSON.stringify(runs.at(-1)));
      }finally{await app.close();}
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
  const summary={};
  for(const backend of ['rust','electron']){
    const selected=runs.filter(r=>r.backend===backend);summary[backend]={};
    for(const scenario of ['launcher','game'])summary[backend][scenario]=Object.fromEntries(['memoryMB','cpuPercent','processCount'].map(key=>[key,median(selected.map(r=>r[scenario][key]))]));
  }
  const report={method:'Three alternating runs per backend, fresh browser profiles, same 1440×940 launcher and local static WebGL 2 page. Each scenario warms up, then takes five samples 600 ms apart. Figures are medians of run medians. Memory sums process working sets (shared pages may be counted more than once). Test-driver/CDP attached to both. The Rust host is an optimized release with static CRT. Electron uses the same launcher and Electron 45.0.0. This measures wrapper overhead, not Foundry V14 gameplay or FPS.',summary,runs};
  fs.mkdirSync(path.join(root,'benchmarks'),{recursive:true});
  fs.writeFileSync(path.join(root,'benchmarks/host-overhead.json'),JSON.stringify(report,null,2)+'\n');
  console.log('SUMMARY',JSON.stringify(summary,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
