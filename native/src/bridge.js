(() => {
  if (window.top !== window || location.href !== 'https://foundry.localhost/index.html') return;
  let sequence = 0;
  const pending = new Map(), subscribers = new Set();
  window.__clientReply = ({id, result, error}) => {
    const item = pending.get(id);
    if (!item) return;
    pending.delete(id); clearTimeout(item.timer);
    if (error) item.reject(new Error(error)); else item.resolve(result);
  };
  window.__clientState = state => { for (const callback of subscribers) callback(state); };
  window.client = Object.freeze({
    invoke(action, payload = null) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The client operation timed out.')); }, 30000);
        pending.set(id, {resolve, reject, timer});
        window.ipc.postMessage(JSON.stringify({id, action, payload}));
      });
    },
    onState(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }
  });
})();
