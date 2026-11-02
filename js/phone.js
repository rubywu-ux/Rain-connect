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
  setInterval(() => net.pub('hub/in', { type: 'hb', id: ME, w: innerWidth, h: innerHeight }), 3000);
  let pings = 0;
  setInterval(() => { if (pings++ < 6 || pings % 5 === 0) ping(); }, 2500);

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
      if (m.type === 'wind') R.addImpulse(m);
      if (m.type === 'tap') {
        R.addRipple(m); R.addImpulse({ kind: 'radial', x: m.x, y: m.y, s: 70, r: 120, t: m.t });
        const v = R.view;
        if (entered && m.x > v.x - 60 && m.x < v.x + R.worldW + 60 && m.y > v.y - 60 && m.y < v.y + R.worldH + 60)
          S.plip(clamp((m.x - v.x) / R.worldW, 0, 1), 0.3);
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
    const n = members.length;
    $('pill').textContent = n > 1 ? `${n} phones · one rain` : 'alone in the rain';
    $('pill').classList.toggle('lit', n > 1);
    if (n > before && m.seam) {
      // someone joined: light sweeps from the seam; every phone rings its own note, left to right
      R.addFlash({ x: m.seam.x, y: m.seam.y, t: T() });
      R.bright = 1.4;
      const minX = Math.min(...members.map(p => p.ox));
      const order = [...members].sort((a, b) => a.ox - b.ox || a.oy - b.oy).findIndex(p => p.id === ME);
      if (entered) S.chime(order + Math.floor(Math.random() * 2), (me.ox - minX) / 1400);
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
      S.chime(0, 0.2, 0.22);
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
      const ev = { type: 'wind', from: ME, x: w.x, y: w.y, dx: (e.clientX - q[0]) / len * 55, dy: (e.clientY - q[1]) / len * 55, r: 90, t: T() };
      R.addImpulse(ev); net.pub('g/' + gid, ev);
    }
  });
  function end(e) {
    if (!drag) return;
    const dur = performance.now() - drag.t0;
    const x = e.clientX, y = e.clientY;
    if (drag.moved < 10 && dur < 350) {
      const w = toWorld(x, y);
      const ev = { type: 'tap', from: ME, x: w.x, y: w.y, seed: Math.floor(Math.random() * 1e6), t: T() };
      R.addRipple(ev); R.addImpulse({ kind: 'radial', x: w.x, y: w.y, s: 70, r: 120, t: ev.t });
      net.pub('g/' + gid, ev);
      S.plip(x / innerWidth, 0.35);
    } else {
      const side = edgeOf(x, y);
      const q = drag.pts[0], dt = Math.max(1, performance.now() - q[2]);
      const vx = (x - q[0]) / dt, vy = (y - q[1]) / dt;
      const toward = { left: -vx, right: vx, top: -vy, bottom: vy }[side];
      if (side && toward > 0.15)
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
    if (!hubSeen || Date.now() - hubSeen > 12000) {           // no wall/hub: solo rain
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
  requestAnimationFrame(frame);

  if (RC.debug) window.__rc = { R, get members() { return members; }, get gid() { return gid; }, ME, net, T,
    freeze: t => { frozen = t; }, get clockOff() { return clockOff; } };
})();
