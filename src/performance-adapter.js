'use strict';

function clientFrameTarget(ticker) {
  const adaptive=globalThis[Symbol.for('foundry-client.adaptive')];
  return adaptive?.enabled && adaptive.ticker===ticker ? adaptive.target : ticker?.maxFPS;
}
function setClientFrameTarget(ticker,target) {
  const adaptive=globalThis[Symbol.for('foundry-client.adaptive')];
  if(adaptive?.enabled){adaptive.setTarget(target);if(adaptive.error)throw new Error(adaptive.error);}
  else {
    ticker.maxFPS=target;
    if(Math.abs(ticker.maxFPS-target)>0.01)throw new Error('The canvas did not accept that FPS limit.');
  }
}
function configureAdaptiveFPS(options) {
  const key=Symbol.for('foundry-client.adaptive');
  let state=globalThis[key];
  if(!options.enabled || !globalThis.game?.ready || !globalThis.game?.world?.id) {
    if(state){state.stop();delete globalThis[key];}
    return {enabled:false};
  }
  if(!globalThis.canvas?.app?.ticker || !Number.isFinite(canvas.app.ticker.maxFPS)) {
    if(state){state.stop();delete globalThis[key];}
    return {enabled:false,error:'Canvas FPS control is unavailable.'};
  }
  if(!state) {
    state={enabled:true,ticker:null,target:60,effective:null,lastActivity:performance.now(),timer:null,idle:false,error:'',core:undefined};
    const coreFPS=()=>{try{return globalThis.game?.settings?.get('core','maxFPS');}catch{return undefined;}};
    state.sync=()=>{
      const ticker=globalThis.canvas?.app?.ticker;
      if(!ticker || !Number.isFinite(ticker.maxFPS))return false;
      if(ticker!==state.ticker) {
        if(state.ticker && state.effective===state.ticker.maxFPS){try{state.ticker.maxFPS=state.target;}catch{/* Retired canvas. */}}
        state.ticker=ticker;state.target=ticker.maxFPS;state.effective=null;state.core=coreFPS();
      } else if(state.effective!==null && Math.abs(ticker.maxFPS-state.effective)>0.01) {
        state.target=ticker.maxFPS;state.effective=ticker.maxFPS;
      }
      const current=coreFPS();
      if(Number.isFinite(current) && current!==state.core){state.target=current;state.core=current;}
      return true;
    };
    state.apply=()=>{
      if(!state.sync())return;
      state.idle=state.nativeInactive || document.hidden || !document.hasFocus() || performance.now()-state.lastActivity>=state.idleMs;
      const target=state.idle ? Math.min(state.target===0?Infinity:state.target,state.idleFPS) : state.target;
      try {
        if(Math.abs(state.ticker.maxFPS-target)>0.01)state.ticker.maxFPS=target;
        state.effective=state.ticker.maxFPS;
        state.error=Math.abs(state.effective-target)>0.01?'Canvas rejected the adaptive FPS limit.':'';
      }catch(error){state.error=String(error.message||error);}
    };
    state.schedule=()=>{
      if(state.timer!==null)clearTimeout(state.timer);
      state.timer=null;
      if(!state.nativeInactive && !document.hidden && document.hasFocus() && performance.now()-state.lastActivity<state.idleMs) {
        state.timer=setTimeout(()=>{state.timer=null;state.apply();state.schedule();},Math.max(50,state.idleMs-(performance.now()-state.lastActivity)));
      }
    };
    state.touch=()=>{
      state.lastActivity=performance.now();
      if(state.idle){state.apply();state.schedule();}
    };
    state.visibility=()=>{state.lastActivity=performance.now();state.apply();state.schedule();};
    state.setTarget=target=>{
      if(!state.sync())throw new Error('Canvas FPS control is unavailable.');
      state.target=target;state.core=coreFPS();state.apply();
    };
    state.stop=()=>{
      if(state.timer!==null)clearTimeout(state.timer);
      for(const event of ['pointermove','pointerdown','wheel','keydown'])removeEventListener(event,state.touch);
      for(const event of ['focus','blur'])removeEventListener(event,state.visibility);
      document.removeEventListener('visibilitychange',state.visibility);
      state.sync();
      if(state.ticker){try{state.ticker.maxFPS=state.target;}catch{/* Unloaded canvas. */}}
      state.enabled=false;
    };
    for(const event of ['pointermove','pointerdown','wheel','keydown'])addEventListener(event,state.touch,{passive:true});
    for(const event of ['focus','blur'])addEventListener(event,state.visibility);
    document.addEventListener('visibilitychange',state.visibility);
    globalThis[key]=state;
  }
  state.idleFPS=[15,30,60].includes(options.idleFPS)?options.idleFPS:30;
  state.idleMs=30000;
  if(state.nativeInactive && !options.inactive)state.lastActivity=performance.now();
  state.nativeInactive=!!options.inactive;
  state.apply();state.schedule();
  return {enabled:true,idle:state.idle,targetFPS:state.target,effectiveFPS:state.effective,error:state.error};
}
function readClientTelemetry(options) {
  const adaptive=configureAdaptiveFPS(options),g=globalThis.game;
  const fps=globalThis.canvas?.app?.ticker?.FPS;
  const base={fps:typeof fps==='number'&&Number.isFinite(fps)?Math.round(fps):null,adaptive};
  if(g?.socket?.connected===false)return {...base,connection:'offline'};
  if(!g?.ready||!g.world?.id)return {...base,connection:'loading'};
  return {...base,id:String(g.world.id).slice(0,128),name:String(g.world.title||g.world.id).slice(0,100),worldError:String(globalThis[Symbol.for('foundry-client.world-settings')]?.error||'').slice(0,200)};
}
