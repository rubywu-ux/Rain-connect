/* Rain Connect — phone page */
(() => {
  const ME = uid();
  const $ = id => document.getElementById(id);
  const rainCv = $('rain'), mapCv = $('map');
  const R = new RainRenderer(rainCv, { scale: 1 });
  const M = new WorldMap(mapCv);
  const S = new RainSound();

  /* ---------------- state */
  let clockOff = 0, bestRtt = 1e9;            // hub clock - local clock (ms)
  let hubSeen = 0;
  let gid = ME;
  let members = [{ id: ME, ox: 0, oy: 0, w: innerWidth, h: innerHeight, num: 1 }];
  let entered = false;
  let stormTarget = 0, stormN = 0, pillDots = '';
  function updatePill() {
    const n = members.length;
    const txt = stormN >= 2 ? `≋ ${stormN} blowing · storm` : n > 1 ? `${n} phones · one rain` : 'alone in the rain';
    $('pill').innerHTML = pillDots + txt;
  }
  let myColor = Math.floor(hash(parseInt(ME, 36) | 0) * 8);   // until the wall assigns one
  /* everyone's notes: their own instrument, the shared chord, on the shared pulse; softer in bigger groups */
  function play(ci, u, tEvent, level) {
    const now = T(), at = RainSound.nextPulse(Math.max(tEvent || now, now - 0.05));
    const vol = 0.5 * level / Math.sqrt(Math.max(1, members.length));   // melodies up front
    S.voice(ci, RainSound.noteFor(ci, clamp(u, 0, 1), at), at, now, vol, clamp(u, 0, 1));
  }
  let lastDragNote = 0;
  let snap = null;

  const hubNow = () => Date.now() + clockOff;
  let frozen = null;                           // debug only: freeze time for screenshots
  const T = () => frozen != null ? frozen : (hubNow() - EPOCH) / 1000;
  const mine = () => members.find(m => m.id === ME) || members[0];

  /* ---------------- network */
  const net = new Net(onMsg, st => { if (st === 'online') hello(); });
  net.sub('c/' + ME);
  net.sub('g/' + gid);
  net.sub('rainnow');
  net.sub('stats');
  net.sub('storm');
  net.sub('strike');
  net.connect();

  function hello() { net.pub('hub/in', { type: 'hello', id: ME, w: innerWidth, h: innerHeight }); ping(); }
  function ping() { net.pub('hub/in', { type: 'ping', id: ME, t0: Date.now() }); }
  setInterval(() => net.pub('hub/in', { type: 'hb', id: ME, gid, n: members.length, w: innerWidth, h: innerHeight }), 3000);
  setInterval(ping, 4000);

  function onMsg(topic, m) {
    if (topic === 'c/' + ME) {
      hubSeen = Date.now();
      if (m.type === 'pong') {
        const t1 = Date.now(), rtt = t1 - m.t0;
        if (rtt < bestRtt + 40) { bestRtt = Math.min(bestRtt, rtt); clockOff = m.hub - (m.t0 + t1) / 2; }
      } else if (m.type === 'assign') {
        applyGroup(m);
      }
    } else if (topic === 'g/' + gid) {
      if (m.from === ME) return;
      if (m.type === 'wind') { R.addImpulse(m); R.addTrail({ x: m.x, y: m.y, t: m.t, c: m.c }); if (m.note && entered) play(m.c, m.u, m.t, 0.25); }
      if (m.type === 'tap') {
        R.addRipple(m); R.addImpulse({ kind: 'radial', x: m.x, y: m.y, s: 70, r: 120, t: m.t });
        const v = R.view;
        const inView = m.x > v.x - 60 && m.x < v.x + R.worldW + 60 && m.y > v.y - 60 && m.y < v.y + R.worldH + 60;
        // a tap on someone else's screen also echoes here, at the same spot, in their colour
        if (!inView && m.u != null)
          R.addRipple({ x: v.x + m.u * R.worldW, y: v.y + m.v * R.worldH, t: m.t, seed: m.seed + 7, c: m.c, k: 0.6, echo: true });
        if (entered) play(m.c, m.u != null ? m.u : 0.5, m.t, inView ? 0.55 : 0.3);
        if (inView && m.site != null && snap && snap.pts && snap.pts[m.site - 5000]) {
          const p = snap.pts[m.site - 5000];
          showDrop({ lat: p[0], lon: p[1], mm: p[2], code: p[3] }, m.x - v.x, m.y - v.y, m.c, false);
        }
      }
    } else if (topic === 'storm') {
      // shared storm: 2+ people blowing anywhere
      stormTarget = m.level || 0;
      if (entered) S.setStorm(stormTarget);
      stormN = m.n || 0;
      updatePill();
    } else if (topic === 'strike') {
      if (!entered) return;
      R.addBolt({ u: m.u, seed: m.seed, power: m.power, t: T() });
      S.thunder(m.power, 0);
    } else if (topic === 'rainnow') {
      setSnap(m);
    } else if (topic === 'stats') {
      if (m.joins) $('shared').textContent = `Rain shared between ${m.joins} phone${m.joins === 1 ? '' : 's'} so far · ${m.online} here now`;
    }
  }

  function applyGroup(m) {
    const before = members.length;
    if (m.gid !== gid) { net.unsub('g/' + gid); gid = m.gid; net.sub('g/' + gid); }
    members = m.members;
    const me = mine();
    R.view.x = me.ox; R.view.y = me.oy;
    R.floor = Math.max(...members.map(p => p.oy + p.h));
    // joined phones share one horizontal river through the middle of the group
    R.river = members.length > 1 ? {
      cy: members.reduce((a, p) => a + p.oy + p.h / 2, 0) / members.length,
      since: m.since ? (m.since - EPOCH) / 1000 : T(), speed: 150,
    } : null;
    const n = members.length;
    myColor = me.color != null ? me.color : myColor;
    document.documentElement.style.setProperty('--me', colorOf(myColor));
    const dots = [...members].sort((a, b) => a.ox - b.ox || a.oy - b.oy)
      .map(p => `<i class="dot${p.id === ME ? ' me' : ''}" style="--c:${colorOf(p.color)}"></i>`).join('');
    pillDots = dots; updatePill();
    $('pill').classList.toggle('lit', n > 1);
    if (n > before && m.seam) {
      // someone joined: light sweeps from the seam; every phone rings its own note, left to right
      const jm = members.find(p => p.id === m.joined);
      R.addFlash({ x: m.seam.x, y: m.seam.y, t: T(), c: jm ? jm.color : null });
      R.bright = 1.4;
      const minX = Math.min(...members.map(p => p.ox));
      const order = [...members].sort((a, b) => a.ox - b.ox || a.oy - b.oy).findIndex(p => p.id === ME);
      if (entered) { const now = T(); play(myColor, (order + 0.5) / members.length, now + (me.ox - minX) / 1400, 0.9); }
      if (navigator.vibrate) navigator.vibrate(30);
    }
  }

  /* ---------------- a drop with a name: a tap holds the rain that is falling somewhere real.
     The joined screens are a little map (east-west across, north-south down); the tap picks the
     raining place nearest that spot and says where it is. */
  function nearestRain(wx, wy) {
    if (!snap || !snap.pts) return null;
    const minX = Math.min(...members.map(p => p.ox)), maxX = Math.max(...members.map(p => p.ox + p.w));
    const minY = Math.min(...members.map(p => p.oy)), maxY = Math.max(...members.map(p => p.oy + p.h));
    const lon = clamp((wx - minX) / Math.max(1, maxX - minX), 0, 1) * 360 - 180;
    const lat = 90 - clamp((wy - minY) / Math.max(1, maxY - minY), 0, 1) * 180;
    let best = null, bd = 1e9;
    snap.pts.forEach((p, idx) => {
      if (!isRaining(p[2], p[3])) return;
      let dl = Math.abs(p[1] - lon); if (dl > 180) dl = 360 - dl;
      const d = (dl / 360) ** 2 + ((p[0] - lat) / 180) ** 2;
      if (d < bd) { bd = d; best = { idx, lat: p[0], lon: p[1], mm: p[2], code: p[3] }; }
    });
    return best;
  }
  let dropEl = null;
  function showDrop(r, sx, sy, col, mine) {
    if (!r) return;
    if (dropEl) dropEl.remove();
    const el = dropEl = document.createElement('div');
    el.className = 'drop-tag';
    if (col != null) el.style.color = `rgb(${colorOf(col)})`;
    el.innerHTML = `<b>${rainWords(r.mm, r.code)} ${placeName(r.lat, r.lon).where}</b><small>${mine ? 'your drop is falling there now' : 'someone is holding this rain'}</small>`;
    el.style.left = clamp(sx - 115, 10, innerWidth - 240) + 'px';
    el.style.top = clamp(sy - 110, 60, innerHeight - 140) + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 1000); }, 4200);
  }

  /* ---------------- live rain snapshot */
  function setSnap(s) {
    if (!s || !s.pts) return;
    snap = s; M.setSnapshot(s); cacheSet(s);
    $('pct').textContent = s.pct.toFixed(1);
    $('meta').innerHTML = `${s.raining} of ${s.n} evenly spread points on Earth report rain<br>live from Open-Meteo · ${fmtTime(s.t)}`;
    S.setRain(clamp(s.pct / 30, 0, 1));
    R.density = 0.75 + clamp(s.pct / 25, 0, 1) * 0.6;
  }
  setTimeout(async () => {
    if (snap) return;
    const c = cacheGet();
    if (c) { setSnap(c); return; }
    try { setSnap(await fetchRainNow()); }
    catch (e) { $('meta').textContent = 'live rain data is unavailable right now'; $('pct').textContent = '—'; }
  }, 5000);

  /* ---------------- enter / map toggle */
  $('enter').onclick = () => {
    S.start();
    if (snap) S.setRain(clamp(snap.pct / 30, 0, 1));
    $('world').classList.add('hidden');
    $('hud').classList.remove('hidden');
    if (!entered) {
      $('hint').classList.remove('hidden');
      setTimeout(() => $('hint').classList.add('hidden'), 9000);
      S.startPad(T);
      play(myColor, 0.4, T() + 0.3, 0.8);
      try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) {}
    }
    entered = true;
    $('enter').textContent = 'Back to the rain';
  };
  $('globe').onclick = () => { $('world').classList.remove('hidden'); $('hud').classList.add('hidden'); };

  /* ---------------- breath: blow into the phone (opt-in, uses the microphone) */
  let mic = null;
  $('wind').onclick = async () => {
    if (mic) { mic.stream.getTracks().forEach(t => t.stop()); mic = null; $('wind').classList.remove('on', 'blowing'); return; }
    try {
      S.start();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const src = S.ctx.createMediaStreamSource(stream), an = S.ctx.createAnalyser();
      an.fftSize = 1024; src.connect(an);
      mic = { stream, an, td: new Float32Array(an.fftSize), fd: new Float32Array(an.frequencyBinCount), floor: 0.01, hot: 0, last: 0, blowing: false };
      $('wind').classList.add('on');
    } catch (e) { $('wind').textContent = '×'; setTimeout(() => { $('wind').textContent = '≋'; }, 1500); }
  };
  setInterval(() => {
    if (!mic) return;
    const { an, td, fd } = mic;
    an.getFloatTimeDomainData(td); an.getFloatFrequencyData(fd);
    let sum = 0; for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
    const rms = Math.sqrt(sum / td.length);
    // blowing = loud, broadband and low-heavy (speech is more tonal/mid); measured against the room
    const binHz = S.ctx.sampleRate / an.fftSize;
    let low = 0, all = 0, lsum = 0, psum = 0, nb = 0;
    for (let i = 1; i < fd.length; i++) {
      const hz = i * binHz, p = Math.pow(10, fd[i] / 10);
      all += p; if (hz < 700) low += p;
      if (hz > 60 && hz < 2500) { lsum += Math.log(p + 1e-12); psum += p; nb++; }
    }
    const lowRatio = all ? low / all : 0;
    // breath is noisy (flat spectrum); voices, hums and music are tonal (peaky spectrum)
    const flat = nb && psum > 0 ? Math.exp(lsum / nb) / (psum / nb) : 0;
    const thr = Math.max(0.045, mic.floor * 4);
    const candidate = rms > thr && lowRatio > 0.5 && flat > 0.12;
    if (RC.debug) window.__mic = { rms: +rms.toFixed(3), low: +lowRatio.toFixed(2), flat: +flat.toFixed(3), thr: +thr.toFixed(3) };
    mic.hot = candidate ? mic.hot + 1 : Math.max(0, mic.hot - 2);
    if (!candidate && !mic.blowing) mic.floor = mic.floor * 0.97 + rms * 0.03;
    const was = mic.blowing;
    mic.blowing = mic.hot >= 3;
    $('wind').classList.toggle('blowing', mic.blowing);
    if (mic.blowing) {
      const strength = clamp((rms - thr) / 0.25, 0.1, 1);
      const now = performance.now();
      if (!was) S.gust(strength);
      if (now - mic.last > 300) {
        mic.last = now;
        net.pub('hub/in', { type: 'blow', id: ME, c: myColor, s: +strength.toFixed(2) });
        // your own breath pushes the strands across your screen
        const t = T(), v = R.view;
        R.addImpulse({ x: v.x + R.worldW * (0.2 + Math.random() * 0.6), y: v.y + R.worldH * 0.75, dx: (Math.random() - 0.5) * 60, dy: -70 * strength, r: 220, t });
      }
    }
  }, 50);

  /* ---------------- touch: tap, drag (wind), edge swipes (connect) */
  const EDGE = 30;
  let drag = null, lastSend = 0;
  const toWorld = (x, y) => ({ x: x + R.view.x, y: y + R.view.y });
  function edgeOf(x, y) {
    const w = innerWidth, h = innerHeight;
    const d = [['left', x], ['right', w - x], ['top', y], ['bottom', h - y]].sort((a, b) => a[1] - b[1])[0];
    return d[1] <= EDGE ? d[0] : null;
  }
  rainCv.addEventListener('pointerdown', e => {
    if (!entered) return;
    rainCv.setPointerCapture(e.pointerId);
    drag = { x0: e.clientX, y0: e.clientY, t0: performance.now(), pts: [[e.clientX, e.clientY, performance.now()]], moved: 0 };
    const side = edgeOf(e.clientX, e.clientY);
    if (side) net.pub('hub/in', { type: 'enter', id: ME, side, pos: side === 'left' || side === 'right' ? e.clientY : e.clientX });
  });
  rainCv.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = drag.pts[drag.pts.length - 1];
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    drag.moved += Math.hypot(dx, dy);
    drag.pts.push([e.clientX, e.clientY, performance.now()]);
    if (drag.pts.length > 6) drag.pts.shift();
    const now = performance.now();
    if (now - lastSend > 60 && Math.hypot(dx, dy) > 1) {
      lastSend = now;
      const q = drag.pts[0], len = Math.hypot(e.clientX - q[0], e.clientY - q[1]) || 1;
      const w = toWorld(e.clientX, e.clientY);
      const ev = { type: 'wind', from: ME, c: myColor, x: w.x, y: w.y, dx: (e.clientX - q[0]) / len * 55, dy: (e.clientY - q[1]) / len * 55, r: 90, t: T(),
                   u: +(e.clientX / innerWidth).toFixed(3) };
      if (now - lastDragNote > 340) { lastDragNote = now; ev.note = 1; play(myColor, ev.u, ev.t, 0.5); }
      R.addImpulse(ev); R.addTrail({ x: w.x, y: w.y, t: ev.t, c: myColor }); net.pub('g/' + gid, ev);
    }
  });
  function end(e) {
    if (!drag) return;
    const dur = performance.now() - drag.t0;
    const x = e.clientX, y = e.clientY;
    if (drag.moved < 10 && dur < 350) {
      const w = toWorld(x, y);
      const ev = { type: 'tap', from: ME, c: myColor, x: w.x, y: w.y, u: x / innerWidth, v: y / innerHeight,
                   seed: Math.floor(Math.random() * 1e6), t: T() };
      const rain = nearestRain(w.x, w.y);
      if (rain) { ev.site = 5000 + rain.idx; showDrop(rain, x, y, myColor, true); }
      R.addRipple(ev); R.addImpulse({ kind: 'radial', x: w.x, y: w.y, s: 70, r: 120, t: ev.t });
      net.pub('g/' + gid, ev);
      S.plip(x / innerWidth, 0.08);
      play(myColor, ev.u, ev.t, 1);
    } else {
      const side = edgeOf(x, y);
      // finger left the screen through an edge after travelling toward it
      const toward = { left: drag.x0 - x, right: x - drag.x0, top: drag.y0 - y, bottom: y - drag.y0 }[side];
      if (side && toward > 40)
        net.pub('hub/in', { type: 'exit', id: ME, side, pos: side === 'left' || side === 'right' ? y : x });
    }
    drag = null;
  }
  rainCv.addEventListener('pointerup', end);
  rainCv.addEventListener('pointercancel', end);
  addEventListener('resize', () => {
    const me = mine(); me.w = innerWidth; me.h = innerHeight;
    net.pub('hub/in', { type: 'hb', id: ME, w: innerWidth, h: innerHeight });
  });
  document.addEventListener('gesturestart', e => e.preventDefault());

  /* ---------------- render loop */
  function frame() {
    const t = T();
    if (!hubSeen || Date.now() - hubSeen > 15000) {           // no wall/hub: solo rain
      if (members.length > 1 || gid !== ME) applyGroup({ gid: ME, members: [{ id: ME, ox: 0, oy: 0, w: innerWidth, h: innerHeight, num: 1 }] });
      R.floor = innerHeight;
    }
    R.storm += (stormTarget - R.storm) * 0.04;
    R.draw(t);
    if (!$('world').classList.contains('hidden')) {
      const r = mapCv.getBoundingClientRect();
      M.draw(t, r.width, r.height, Math.min(devicePixelRatio || 1, 2));
    }
    requestAnimationFrame(frame);
  }
  R.floor = innerHeight;
  document.documentElement.style.setProperty('--me', colorOf(myColor));
  requestAnimationFrame(frame);

  if (RC.debug) window.__rc = { R, get members() { return members; }, get gid() { return gid; }, ME, net, T,
    freeze: t => { frozen = t; }, get clockOff() { return clockOff; } };
})();
