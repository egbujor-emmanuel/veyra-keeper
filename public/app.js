// VEYRA Keeper landing page: live gauge and ledger from the agent's own endpoints.
// All data is rendered with textContent / createElement; nothing from the network is parsed as HTML.
(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const hasGsap = typeof window.gsap !== 'undefined'
  const TESTNET_TX = 'https://testnet.bscscan.com/tx/'
  const $ = (id) => document.getElementById(id)

  document.documentElement.classList.add('js')

  // ---- motion: Lenis synced to GSAP's ticker, skipped entirely for reduced motion
  if (hasGsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger)
  if (hasGsap && !reduceMotion && window.Lenis) {
    const lenis = new Lenis({ autoRaf: false, lerp: 0.12 })
    lenis.on('scroll', ScrollTrigger.update)
    gsap.ticker.add((time) => lenis.raf(time * 1000))
    gsap.ticker.lagSmoothing(0)
    document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
      const target = document.querySelector(a.getAttribute('href'))
      if (target) { e.preventDefault(); lenis.scrollTo(target, { offset: -64 }) }
    }))
  }

  function heroIntro() {
    if (!hasGsap || reduceMotion) return
    const tl = gsap.timeline({ defaults: { ease: 'expo.out', duration: 0.9 } })
    tl.from('.eyebrow', { y: 12, opacity: 0 })
      .from('h1', { y: 24, opacity: 0 }, '-=0.7')
      .from('.lede, .ctas, .facts', { y: 16, opacity: 0, stagger: 0.08 }, '-=0.6')
      .from('.gauge', { y: 28, opacity: 0, rotate: -0.6 }, '-=0.8')
  }

  // Content stays visible by default; only rows still below the fold animate in as they arrive,
  // so crawlers, screenshots and a failed script all see the full page.
  function revealOnScroll(nodes) {
    if (!hasGsap || reduceMotion || !window.ScrollTrigger) return
    const below = nodes.filter((n) => n.getBoundingClientRect().top > window.innerHeight)
    gsap.set(below, { y: 18 })
    ScrollTrigger.batch(below, {
      start: 'top 95%',
      once: true,
      onEnter: (batch) => gsap.to(batch, { y: 0, duration: 0.8, ease: 'expo.out', stagger: 0.07 }),
    })
  }

  // ---- data
  async function getJson(path, timeoutMs) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const r = await fetch(path, { signal: ctrl.signal, cache: 'no-store' })
      if (!r.ok) throw new Error(`${path} answered ${r.status}`)
      return await r.json()
    } finally {
      clearTimeout(timer)
    }
  }

  const bnbPrice = (tick) => Math.pow(1.0001, -tick) // token0 USDT, token1 WBNB: USDT per tBNB
  const fmtPrice = (p) => p.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
  const widthPct = (lo, hi) => ((Math.pow(1.0001, (hi - lo) / 2) - 1) * 100).toFixed(2)
  const shortHash = (h) => `${h.slice(0, 6)}…${h.slice(-4)}`

  function el(tag, props = {}, children = []) {
    const n = document.createElement(tag)
    Object.entries(props).forEach(([k, v]) => { if (k === 'text') n.textContent = v; else n.setAttribute(k, v) })
    children.forEach((c) => n.append(c))
    return n
  }

  // ---- gauge
  function drawGauge(decision) {
    const scale = $('scale')
    const pos = decision.position
    const tick = decision.poolTick
    $('r-tick').textContent = String(tick)
    $('r-target').textContent = `±${decision.targetPct}%`
    $('v-head').textContent = decision.act ? 'Next cycle: re-centre.' : 'Holding.'
    $('v-body').textContent = decision.reason.charAt(0).toUpperCase() + decision.reason.slice(1) + '.'

    if (!pos) {
      scale.dataset.state = 'error'
      $('scale-msg').textContent = 'No position open right now; the next keeper cycle opens one.'
      $('r-range').textContent = 'none'
      $('r-width').textContent = '—'
      return
    }

    const lo = Number(pos.tickLower)
    const hi = Number(pos.tickUpper)
    const inRange = tick >= lo && tick < hi
    // Price rises left to right: plot -tick so BNB's USDT price increases rightwards.
    const xs = [-hi, -lo, -tick]
    const span = Math.max(...xs) - Math.min(...xs)
    const pad = span * 0.45 + 60
    const min = Math.min(...xs) - pad
    const max = Math.max(...xs) + pad
    const pct = (v) => ((v - min) / (max - min)) * 100

    const band = $('band')
    const price = $('price')
    band.style.left = `${pct(-hi)}%`
    band.style.width = `${pct(-lo) - pct(-hi)}%`
    price.style.left = `${pct(-tick)}%`
    $('band-label').textContent = `range ${fmtPrice(bnbPrice(hi))} – ${fmtPrice(bnbPrice(lo))}`
    $('price-tag').textContent = `${fmtPrice(bnbPrice(tick))} USDT`
    $('ax-lo').textContent = fmtPrice(bnbPrice(-min))
    $('ax-hi').textContent = fmtPrice(bnbPrice(-max))
    $('r-range').textContent = `${lo} → ${hi}`
    $('r-width').textContent = `±${widthPct(lo, hi)}%`
    scale.dataset.state = inRange ? 'ok' : 'out'
    $('scale').setAttribute('aria-label', `Range ${fmtPrice(bnbPrice(hi))} to ${fmtPrice(bnbPrice(lo))} USDT per tBNB; pool price ${fmtPrice(bnbPrice(tick))}, ${inRange ? 'inside' : 'outside'} the range.`)

    if (hasGsap && !reduceMotion) {
      gsap.fromTo(band, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 1.1, ease: 'expo.out', delay: 0.2 })
      gsap.fromTo(price, { y: -18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, ease: 'back.out(2)', delay: 0.75 })
    }
  }

  function gaugeError(message) {
    $('scale').dataset.state = 'error'
    $('scale-msg').textContent = message
    $('v-head').textContent = 'Live reading unavailable.'
    $('v-body').textContent = 'The ledger below still shows every action taken.'
  }

  // ---- ledger
  function drawLedger(status) {
    const list = $('actions')
    list.replaceChildren()
    const actions = [...(status.actions || [])].reverse()
    const txCount = status.onchain?.transactions ?? 0
    const days = status.onchain?.days?.length ?? 0
    $('ledger-sum').textContent = `${txCount} transaction${txCount === 1 ? '' : 's'} · ${days} day${days === 1 ? '' : 's'} · agent #${status.agentId ?? '—'}`
    if (!actions.length) {
      list.append(el('li', { class: 'placeholder', text: 'No on-chain actions yet. The keeper acts on its next cycle.' }))
      return
    }
    for (const a of actions) {
      const at = new Date(a.at)
      const when = el('div', { class: 'when' }, [
        el('b', { text: at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) }),
        `${at.toISOString().slice(11, 16)} UTC`,
      ])
      const title = a.kind === 'open' ? `Opened range ${a.tickLower} → ${a.tickUpper}` : `Re-centred to ${a.tickLower} → ${a.tickUpper}`
      const txs = el('ul', { class: 'txs' }, a.txs.map((t) => el('li', {}, [
        el('a', { href: TESTNET_TX + t.hash, target: '_blank', rel: 'noopener' }, [el('span', { text: t.label }), shortHash(t.hash)]),
      ])))
      const body = el('div', {}, [
        el('h3', {}, [el('span', { class: 'kind', text: a.kind }), title]),
        el('p', { class: 'why', text: `${a.reason.charAt(0).toUpperCase()}${a.reason.slice(1)}. Width ±${a.targetPct}% at pool tick ${a.poolTick}; position #${a.tokenId}.` }),
        txs,
      ])
      list.append(el('li', {}, [when, body]))
    }
    revealOnScroll([...list.children])
  }

  function ledgerError(message, retry) {
    const list = $('actions')
    const btn = el('button', { type: 'button', class: 'copy', text: 'Retry' })
    btn.style.position = 'static'
    btn.addEventListener('click', retry)
    list.replaceChildren(el('li', { class: 'placeholder err' }, [`${message} `, btn]))
    $('ledger-sum').textContent = 'unavailable'
  }

  function setLive(state, text) {
    $('live').dataset.state = state
    $('live-text').textContent = text
  }

  async function loadStatus() {
    try {
      const status = await getJson('/api/status', 20000)
      drawLedger(status)
      setLive('up', 'Answering')
    } catch (e) {
      ledgerError('Could not read the action log.', loadStatus)
      setLive('down', 'Unreachable')
    }
  }

  async function loadGauge() {
    try {
      const { decision } = await getJson('/api/keeper', 60000)
      drawGauge(decision)
    } catch (e) {
      gaugeError(e.name === 'AbortError' ? 'The chain read took too long. Reload to try again.' : 'Could not read the pool just now.')
    }
  }

  // ---- copy button
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent)
      b.textContent = 'Copied'
    } catch {
      b.textContent = 'Select and copy'
    }
    setTimeout(() => { b.textContent = 'Copy' }, 1800)
  }))

  heroIntro()
  revealOnScroll([...document.querySelectorAll('.rule-list li, .code, .links')])
  loadStatus()
  loadGauge()
})()
