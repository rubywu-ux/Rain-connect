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
      }
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
    $('pill').innerHTML = dots + (n > 1 ? `${n} phones · one rain` : 'alone in the rain');
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
