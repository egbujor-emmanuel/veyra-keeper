async (page) => {
  const ctx = page.context();
  if (!ctx.__vkBound) {
    await ctx.exposeBinding('__vkRpc', async (_src, payload) => {
      const r = await fetch('http://127.0.0.1:8787', { method: 'POST', body: payload });
      return await r.text();
    });
    await ctx.addInitScript(() => {
      const listeners = {};
      const provider = {
        isMetaMask: true, chainId: '0x61', selectedAddress: null,
        async request({ method, params }) {
          const out = JSON.parse(await window.__vkRpc(JSON.stringify({ method, params })));
          if (out.error) { const e = new Error(out.error.message); e.code = out.error.code; throw e; }
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') provider.selectedAddress = out.result[0];
          return out.result;
        },
        on(ev, fn) { (listeners[ev] ||= []).push(fn); return provider; },
        removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return provider; },
        isConnected() { return true; },
        enable() { return provider.request({ method: 'eth_requestAccounts' }); },
      };
      window.ethereum = provider;
      const info = { uuid: 'b6c1d0a2-6c3e-4f5a-9d1e-7a2b3c4d5e6f', name: 'MetaMask', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'io.metamask' };
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    });
    page.on('dialog', (d) => d.accept());
    ctx.__vkBound = true;
  }
  await page.goto('https://marque.trade/builders/claim');
  await page.waitForTimeout(6000);
  return (await page.locator('main').innerText()).slice(0, 2500);
}
