(() => {
  'use strict';
  const q = (id) => document.getElementById(id);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        console.warn('[pwa] service worker registration failed:', error);
      });
    });
  }

  /* elements */
  const elMain = q('main');
  const elPing = q('ping');
  const elJitter = q('jitter');
  const elPeak = q('peak');
  const elPeakUl = q('peak-ul');
  const elMainUl = q('main-ul');
  const elBytes = q('bytes-disp');
  const elStreamId = q('stream-id');
  const btnRun = q('run');
  const lblRun = q('run-lbl');
  const elTime = q('time');
  const elDate = q('date');
  const elContacts = q('contacts');
  const elLinkStatus = q('link-status');
  const elGeoCountry = q('geo-country');
  const elGeoCity = q('geo-city');
  const elGeoOrg = q('geo-org');
  const elGeoIp4 = q('geo-ip4');
  const elGeoIp6 = q('geo-ip6');
  const elGeoAsn = q('geo-asn');
  const elGeoCoord = q('geo-coord');
  const elGaugePct = q('gauge-pct');
  const elGaugeRing = q('gauge-ring');
  const elGaugePctUl = q('gauge-pct-ul');
  const elGaugeRingUl = q('gauge-ring-ul');
  const elScopeV = q('scope-v');
  const elBarDl = q('b-eng');
  const elBarUl = q('b-ul');
  const elBarSig = q('b-sys');
  const elBarJit = q('b-wpn');
  const elBarQlty = q('b-fuel');
  const elWavePanel = q('wave-panel');
  const elDebug = q('debug');

  const setDebug = (msg) => { if (elDebug) elDebug.textContent = msg; };

  const DL_URL = 'https://dza.mooo.com/download';
  const UL_URL = 'https://dza.mooo.com/upload';
  const UL_SIZE = 25 * 1024 * 1024;
  let busy = false;
  let pingStore = 0;
  let jitterStore = 0;
  let lastMb = 0;
  let fetchOk = true;
  let bytes = 0;
  let totalSize = 25000000;
  let mbpsPeak = 0;
  let dlLast = '0.00';
  let ulSamples = [];
  let ulPeak = 0;
  let ulEma = 0;
  const UL_WINDOW_SEC = 2.0;
  const UL_EMA_ALPHA = 0.15;

  /* stream id */
const sid = Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')
  ).join(':');
  elStreamId.textContent = sid;

  setInterval(() => {
    const now = new Date();
    elTime.textContent = now.toISOString().slice(11, 19).replace(/:/g, ' : ');
    elDate.textContent = now.toISOString().slice(0, 10).replace(/-/g, '.');
  }, 1000);

  /* background canvas */
  (function bg() {
    const c = q('bg');
    const ctx = c.getContext('2d');
    let t = 0;
    function resize() { c.width = innerWidth; c.height = innerHeight; }
    addEventListener('resize', resize);
    resize();

    function draw() {
      const w = c.width, h = c.height;
      t += 0.003; ctx.clearRect(0, 0, w, h);
      const gap = 40;

      ctx.strokeStyle = 'rgba(0, 229, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += gap) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += gap) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

      ctx.strokeStyle = 'rgba(180, 77, 255, 0.1)';
      for (let x = 0; x < w; x += gap) {
        const off = Math.sin(t + x * 0.01) * 22;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + off, h); ctx.stroke();
      }
      requestAnimationFrame(draw);
    }
    requestAnimationFrame(draw);
  })();

  /* tunnel canvas */
  const tunnel = q('tunnel');
  const tctx = tunnel.getContext('2d');
  let tAngle = 0;

  function resizeTunnel() {
    const r = tunnel.getBoundingClientRect();
    tunnel.width = r.width;
    tunnel.height = r.height;
  }
  window.addEventListener('resize', resizeTunnel);
  resizeTunnel();

  function drawTunnel(active = false) {
    const w = tunnel.width, h = tunnel.height;
    const cx = w / 2, cy = h / 2;
    tctx.clearRect(0, 0, w, h);

    const rings = 10;
    for (let i = 0; i < rings; i++) {
      const progress = (i / rings + tAngle) % 1;
      const r = progress * Math.min(w, h) * 0.5;
      const alpha = active ? 0.5 - progress * 0.4 : 0.15 - progress * 0.1;
      tctx.beginPath();
      tctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      tctx.strokeStyle = `rgba(0, 229, 255, ${alpha})`;
      tctx.lineWidth = 1;
      tctx.stroke();
    }

    if (active) {
      tAngle += 0.015;
      if (tAngle > 1) tAngle = 0;
    }
  }

  /* waveform */
  const wave = q('wave');
  const wctx = wave.getContext('2d');
  const wVals = [];

  function resizeWave() {
    const r = wave.getBoundingClientRect();
    wave.width = r.width;
    wave.height = 80;
  }
  window.addEventListener('resize', resizeWave);
  resizeWave();

  function drawWave() {
    const w = wave.width, h = wave.height;
    wctx.clearRect(0, 0, w, h);
    const rawMax = Math.max(...wVals.slice(-40), 1);
    const maxVal = Math.max(rawMax, 5);
    const scale = (h - 6) / maxVal;
    wctx.strokeStyle = 'rgba(0, 229, 255, 0.55)';
    wctx.lineWidth = 1.2;
    wctx.beginPath();
    for (let i = 0; i < wVals.length; i++) {
      const x = (i / (wVals.length - 1)) * w;
      const y = h - 4 - (wVals[i] * scale);
      if (i === 0) wctx.moveTo(x, y); else wctx.lineTo(x, y);
    }
    wctx.stroke();
    wctx.fillStyle = 'rgba(0, 229, 255, 0.08)';
    wctx.lineTo(((wVals.length - 1) / (wVals.length - 1)) * w, h);
    wctx.lineTo(0, h);
    wctx.closePath();
    wctx.fill();
  }

  function tickWave() {
    const v = lastMb;
    wVals.push(v);
    if (wVals.length > 120) wVals.shift();
  }

  /* animation loop */
  let animId;
  function loop() {
    if (busy) tickWave();
    drawTunnel(busy);
    drawWave();
    animId = requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* gauge */
  function setGauge(pct, ring, txt) {
    pct = Math.min(100, Math.max(0, pct));
    const circ = 314;
    if (!ring) ring = elGaugeRing;
    if (!txt) txt = elGaugePct;
    if (ring) ring.style.strokeDashoffset = circ - (pct / 100) * circ;
    if (txt) txt.textContent = Math.round(pct) + '%';
  }

  /* force validation: measure-only + invalid inputs + ml = versionISH preventor; skip real API calls */
  function runValidation() {
    console.log('[metadata] no external data sent from runValidation');
  }

/* geo */
   async function initGeo(timeout = 3000) {
     let ipv4 = null;
     let ipv6 = null;
     let city = null;
     let country = null;
     let org = null;
     let asn = null;
     let coord = null;

     const endpoints = [
       { url: 'https://free.freeipapi.com/api/json', parse: d => ({
         ip: d.ipAddress, city: d.cityName, country: d.countryCode, org: d.asnOrganization || null,
         lat: d.latitude, lon: d.longitude, asn: d.asn || null
       }) },
       { url: 'https://ipinfo.io/json', parse: d => ({
         ip: d.ip, city: d.city, country: d.country, org: d.org || null,
         lat: d.loc ? d.loc.split(',')[0] : null, lon: d.loc ? d.loc.split(',')[1] : null, asn: d.org ? d.org.split(' ')[0] : null
       }) },
     ];

     const results = await Promise.allSettled(
       endpoints.map(ep => dlAsync(ep.url, { mode: 'cors', cache: 'no-store' }, timeout).then(res => res ? res.json() : null).then(data => data ? ep.parse(data) : null))
     );

     for (const r of results) {
       if (r.status !== 'fulfilled' || !r.value) continue;
       const parsed = r.value;
       const altIp = parsed.ip;
       if (altIp && altIp !== '0.0.0.0') {
         if (altIp.includes(':')) ipv6 = altIp;
         else ipv4 = altIp;
       }
       if (parsed.city && !city) {
         city = parsed.city;
         country = parsed.country;
         org = parsed.org;
         asn = parsed.asn;
         coord = parsed.lat && parsed.lon ? `${parsed.lat}, ${parsed.lon}` : null;
       }
     }

// Update UI with all values
      elGeoIp4.textContent = ipv4 || '---';
      elGeoIp6.textContent = ipv6 || '---';
      elGeoAsn.textContent = (asn || org || '---').toUpperCase().slice(0, 22);
      elGeoCoord.textContent = coord || '---';
      elGeoCity.textContent = (city || 'UNKNOWN').toUpperCase();
      elGeoCountry.textContent = (country || '---').toUpperCase();
      elGeoOrg.textContent = (org || '---').toUpperCase().slice(0, 28);
      elContacts.textContent = (ipv4 || ipv6) ? '1 NODE' : 'AWAITING';
      elLinkStatus.textContent = (ipv4 || ipv6) ? 'ONLINE' : 'SEARCHING';
      elLinkStatus.className = (ipv4 || ipv6) ? 'ok' : '';
    }

  /* ping/jitter */
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function measurePing() {
    return new Promise((resolve) => {
      const t0 = performance.now();
      fetch('https://www.google.com/favicon.ico', { mode: 'no-cors', cache: 'no-store' })
        .then(() => resolve(performance.now() - t0))
        .catch(() => resolve(0));
    });
  }

  async function computeJitter() {
    const s = [];
    for (let i = 0; i < 4; i++) { s.push(await measurePing()); await wait(70); }
    const diffs = s.slice(1).map((v, i) => Math.abs(v - s[i]));
    const j = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const a = s.reduce((x, y) => x + y, 0) / s.length;
    return { avgPing: a, jitter: j };
  }

  function fmt(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(2) + ' MB';
  }

  async function dlAsync(url, opts, timeout = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function setBar(el, pct) {
    if (!el) return;
    pct = Math.min(100, Math.max(0, pct));
    el.style.width = pct + '%';
  }

  function clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

  function timeoutPromise(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function tryDl(url, timeout = 3000) {
    try {
      const res = await timeoutPromise(
        fetch(url, { mode: 'cors', cache: 'no-store' }),
        timeout
      );
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      return res;
    } catch (e) {
      return null;
    }
  }

  async function runDL() {
    console.log('[DL] runDL called');
    if (elMainUl) elMainUl.textContent = '--';
    if (elMain) elMain.textContent = '--';
    if (elBytes) elBytes.classList.remove('bytes-hide');
    const endpoints = [
      { url: DL_URL, name: 'DZA' },
    ];

    for (const ep of endpoints) {
      lastMb = 0;
      wVals.length = 0;
      const res = await tryDl(ep.url, 3000);
      if (!res) continue;

      const start = performance.now();
      const reader = res.body.getReader();
      let peak = 0;
      bytes = 0;
      const samples = [];
      fetchOk = true;
      let timedOut = false;

      while (true) {
        let chunk;
        try {
          chunk = await timeoutPromise(reader.read(), 3000);
        } catch (e) {
          fetchOk = false;
          timedOut = true;
          lastMb = 0;
          wVals.length = 0;
          break;
        }
        const { done, value } = chunk;
        if (done) break;
        if (!value || value.byteLength === 0) {
          fetchOk = false;
          timedOut = true;
          lastMb = 0;
          wVals.length = 0;
          break;
        }
        bytes += value.length;
        const t = (performance.now() - start) / 1000;
        if (t <= 0) continue;
        const mbps = (bytes * 8) / (t * 1e6);
        if (elBytes) elBytes.textContent = (bytes / 1e6).toFixed(1) + ' MB / ' + (totalSize / 1e6).toFixed(0) + ' MB';
        const showSpeed = t > 0.5 && bytes > 200 * 1024;
        if (showSpeed) {
          if (elScopeV) elScopeV.textContent = mbps.toFixed(2) + ' MBIT/S';
          lastMb = mbps;
          if (t > 0.25 && bytes > 50 * 1024) elMain.textContent = mbps.toFixed(2);
          console.log('[DL][raw]', mbps.toFixed(2), 'Mbps | bytes', bytes, '| t', t.toFixed(2), 's');
        }

        const progress = Math.min(100, (bytes / totalSize) * 100);
        setGauge(progress);
        if (elBarDl) setBar(elBarDl, progress);
        if (elBarSig) setBar(elBarSig, fetchOk ? progress : 50);
        if (pingStore > 0) {
          const jitScoreLive = clamp(100 - (jitterStore / pingStore) * 200, 0, 100);
          if (elBarJit) setBar(elBarJit, jitScoreLive);
          if (elBarQlty) setBar(elBarQlty, clamp(progress * 0.7 + jitScoreLive * 0.3, 0, 100));
        } else if (elBarQlty) {
          setBar(elBarQlty, progress);
        }

        if (t > 0.5) {
          if (mbps > peak) peak = mbps;
          elPeak.textContent = peak.toFixed(2);
          samples.push(mbps);
        }
      }

      if (timedOut) continue;
      if (bytes < 400 * 1024) {
        lastMb = 0;
        wVals.length = 0;
        continue;
      }

      const total = (performance.now() - start) / 1000;
      const avgMbps = total > 0 ? (bytes * 8) / (total * 1e6) : 0;

      let dlStability = 0;
      if (samples.length > 2) {
        const last5 = samples.slice(-5);
        const avg = last5.reduce((a, b) => a + b, 0) / last5.length;
        const variance = last5.reduce((s, v) => s + ((v - avg) ** 2), 0) / last5.length;
        dlStability = clamp(100 - Math.sqrt(variance) * 10, 0, 100);
      }
      const integrityScore = fetchOk ? clamp((bytes / totalSize) * 100, 0, 100) : 50;
      const jitScore = pingStore > 0 ? clamp(100 - (jitterStore / pingStore) * 200, 0, 100) : 0;
      const qlty = clamp((dlStability * 0.35) + (integrityScore * 0.25) + (jitScore * 0.2) + (clamp(mbpsPeak || 0, 0, 100) * 0.2), 0, 100);

      setBar(elBarDl, integrityScore);
      setBar(elBarSig, integrityScore);
      setBar(elBarJit, jitScore);
      setBar(elBarQlty, qlty);
      if (elBytes) elBytes.classList.add('bytes-hide');

      return { avg: avgMbps, source: ep.name };
    }

    elLinkStatus.textContent = 'NO DL';
    elLinkStatus.className = 'err';
    throw new Error('DL_TIMEOUT');
  }

async function runUL() {
  console.log('[UL] runUL called');
  if (elMainUl) elMainUl.textContent = '--';
  if (elMain) elMain.textContent = dlLast || '0.00';
  if (elPeakUl) elPeakUl.textContent = '--';
  if (elBarUl) setBar(elBarUl, 0);
  ulSamples.length = 0;
  ulEma = 0;
  ulPeak = 0;
  if (elBytes) elBytes.classList.remove('bytes-hide');

  const payload = new Uint8Array(UL_SIZE);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', UL_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    const start = performance.now();
    let timedOut = false;
    let settled = false;
    let lastLoaded = 0;
    let lastTime = start;
    const settle = (fn) => () => { if (!settled) { settled = true; fn(); } };

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const now = performance.now();
      const loaded = e.loaded;
      lastLoaded = loaded;
      lastTime = now;

      if (elBarUl) setBar(elBarUl, loaded / UL_SIZE * 100);
      const progress = Math.min(100, (loaded / UL_SIZE) * 100);
      setGauge(progress, elGaugeRingUl, elGaugePctUl);
      if (elBytes) elBytes.textContent = (loaded / 1e6).toFixed(1) + ' MB / ' + (UL_SIZE / (1024 * 1024)).toFixed(0) + ' MB';

      if (loaded >= UL_SIZE && !settled) {
        console.log('[UL] upload complete via onprogress');
        clearTimeout(timer);
        settled = true;
        const total = (now - start) / 1000;
        const avgMbps = total > 0 ? (loaded * 8) / (total * 1e6) : 0;
        elMainUl.textContent = avgMbps.toFixed(2);
        elMain.textContent = dlLast || '0.00';
        if (avgMbps > ulPeak && elPeakUl) {
          ulPeak = avgMbps;
          elPeakUl.textContent = ulPeak.toFixed(2);
        }
        if (elBytes) elBytes.classList.add('bytes-hide');
        resolve(avgMbps);
        return;
      }

      const t = (now - start) / 1000;
      if (t > 0.5) {
        const mbps = (loaded * 8) / (t * 1e6);
        const showSpeed = mbps > 0 && loaded > 100 * 1024;
        if (showSpeed) {
          if (elScopeV) elScopeV.textContent = mbps.toFixed(2) + ' MBIT/S';
          lastMb = mbps;
          elMainUl.textContent = mbps.toFixed(2);
          if (mbps > ulPeak) {
            ulPeak = mbps;
            elPeakUl.textContent = ulPeak.toFixed(2);
          }
          console.log('[UL][raw]', mbps.toFixed(2), 'Mbps | loaded', loaded, '| t', t.toFixed(2), 's');
        }
      }
    };

    const timer = setTimeout(() => {
      console.log('[UL] timer timeout, aborting');
      timedOut = true;
      xhr.abort();
      settle(() => reject(new Error('UL_TIMEOUT')))();
    }, 30000);

    xhr.onload = () => {
      console.log('[UL] onload fired', 'status:', xhr.status, 'timedOut:', timedOut, 'settled already:', settled);
      clearTimeout(timer);
      if (settled) {
        console.log('[UL] onload ignored, already resolved via onprogress');
        return;
      }
      settled = true;
      const total = (lastTime - start) / 1000;
      const avgMbps = total > 0 ? (lastLoaded * 8) / (total * 1e6) : 0;
      console.log('[UL] resolve via onload (using last progress)', avgMbps.toFixed(2));
      elMainUl.textContent = avgMbps.toFixed(2);
      elMain.textContent = dlLast || '0.00';
      if (elBytes) elBytes.classList.add('bytes-hide');
      resolve(avgMbps);
    };

    xhr.onerror = () => {
      console.log('[UL] onerror fired', 'settled:', settled);
      clearTimeout(timer);
    };

    xhr.onabort = () => {
      console.log('[UL] onabort fired', 'timedOut:', timedOut, 'settled:', settled);
      clearTimeout(timer);
    };

    xhr.onloadend = () => {
      console.log('[UL] onloadend', 'timedOut:', timedOut, 'settled:', settled);
    };

    xhr.send(payload);
  });
}

  /* run */
  btnRun.addEventListener('click', async () => {
    console.log('[run] click, busy=', busy);
    if (busy) return;
    busy = true;
    btnRun.disabled = true;
    lblRun.textContent = 'PROCESSING';
    setDebug('WAIT INIT_GEO');
    if (elMain) elMain.textContent = '--';
    if (elMainUl) elMainUl.textContent = '--';
if (elPeakUl) elPeakUl.textContent = '--';
     ulSamples.length = 0;
     ulEma = 0;
     ulPeak = 0;
    elPing.textContent = '--';
    elJitter.textContent = '--';
    elPeak.textContent = '--';
    elBytes.textContent = '0 MB / 25 MB';
    if (elBarDl) setBar(elBarDl, 0);
    if (elBarSig) setBar(elBarSig, 0);
    if (elBarJit) setBar(elBarJit, 0);
    if (elBarUl) setBar(elBarUl, 0);
    if (elBarQlty) setBar(elBarQlty, 0);
    setGauge(0);
    setGauge(0, elGaugeRingUl, elGaugePctUl);
    if (elWavePanel) elWavePanel.classList.remove('wave-live');
elScopeV.textContent = '0.00 MBIT/S';
     elGeoCountry.textContent = '---';
     elGeoCity.textContent = '---';
     elGeoOrg.textContent = '---';
     elGeoIp4.textContent = '---';
     elGeoIp6.textContent = '---';
     elGeoAsn.textContent = '---';
     elGeoCoord.textContent = '---';
     elContacts.textContent = 'AWAITING';

    try {
      console.log('[run] step 1: initGeo');
      await initGeo();
      console.log('[run] step 1 done');

      await wait(250);

      try {
      console.log('[run] step 2: computeJitter');
        setDebug('WAIT PING/JITTER');
      const { avgPing, jitter } = await computeJitter();
        pingStore = avgPing;
        jitterStore = jitter;
        elPing.textContent = avgPing.toFixed(0);
        elJitter.textContent = jitter.toFixed(1);
        console.log('[run] step 2 done', 'ping=', avgPing.toFixed(0), 'jitter=', jitter.toFixed(1));
      } catch (e) {
        console.log('[run] step 2 failed:', e && e.message);
        pingStore = 0;
        jitterStore = 0;
      }

if (elWavePanel) elWavePanel.classList.add('wave-live');
       console.log('[run] step 3: runDL');
       const dl = await runDL();
      console.log('[run] step 3 done', 'dl=', dl.avg.toFixed(2), 'source=', dl.source);
      elLinkStatus.textContent = 'ONLINE';
      elLinkStatus.className = 'ok';
      elMain.textContent = dl.avg.toFixed(2);
      elContacts.textContent = dl.source;
      dlLast = dl.avg.toFixed(2);

      try {
      const ulAvg = await runUL();
      elMainUl.textContent = ulAvg.toFixed(2);
          console.log('[run] step 4 done', 'ul=', ulAvg.toFixed(2));
        } catch (eUl) {
          console.log('[run] step 4 failed:', eUl && eUl.message);
          // DL already succeeded; keep UL error state from runUL
        }

      console.log('[run] complete');
      elMain.textContent = dl.avg.toFixed(2);
      setGauge(100);
    } catch (e) {
      console.log('[run] outer catch:', e && e.message);
      lblRun.textContent = 'RETRY';
      elLinkStatus.textContent = 'ERROR';
      elLinkStatus.className = 'err';
      elContacts.textContent = '---';
    } finally {
      console.log('[run] finally, busy=false');
      busy = false;
      btnRun.disabled = false;
      lblRun.textContent = 'INITIALIZE LINK';
    }
  });

})();
