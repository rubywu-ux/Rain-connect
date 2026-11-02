/* Rain Connect — wall page. Shows the big rain, and is also the HUB:
 * it keeps the clock, groups phones that are swiped together, counts joins,
 * and fetches + shares the live world rain snapshot. Keep exactly one wall open. */
(() => {
  const $ = id => document.getElementById(id);
  const R = new RainRenderer($('rain'), { scale: 1.6 });
  const M = new WorldMap($('map'));
  const S = new RainSound();
  const T = () => (Date.now() - EPOCH) / 1000;
  R.floor = null;
  // the wall stays black & white: colours are only for the phones
  ['addRipple', 'addTrail', 'addFlash'].forEach(k => { const f = R[k].bind(R); R[k] = e => f(Object.assign({}, e, { c: null })); });
  // ?td : running inside TouchDesigner's Web Render TOP -> no click-to-start, TD makes the sound
  const TDMODE = new URLSearchParams(location.search).has('td');

  /* ---------------- QR to the phone page */
  const phoneUrl = new URL('./', location.href);
  if (RC.base.split('/').pop() !== 'gallery') phoneUrl.searchParams.set('room', RC.base.split('/').pop());
  new URLSearchParams(location.search).get('broker') && phoneUrl.searchParams.set('broker', RC.broker);
  if (INK) phoneUrl.searchParams.set('ink', '');
  try {
    const qr = qrcode(0, 'M'); qr.addData(phoneUrl.href); qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const svg = $('qr').querySelector('svg');
    svg.querySelectorAll('rect').forEach(r => r.setAttribute('fill', `rgb(${PAL.bg})`));
    svg.querySelectorAll('path').forEach(p => p.setAttribute('fill', `rgb(${PAL.ink})`));
  } catch (e) { $('qr').textContent = phoneUrl.href; }

  /* ---------------- hub state */
  const clients = new Map();   // id -> {id,w,h,gid,ox,oy,num,seen}
  let joins = +(localStorage.getItem('rc_joins') || 0);
  let nextNum = 1;
  const exits = [];            // recent edge exits {id, side, pos, at}
  const anchors = new Map();   // gid -> wall position for echoes
  const since = new Map();     // gid -> when it first had 2+ phones (river start)
  const blowers = new Map();   // id -> {at, s}: phones blowing right now

  const net = new Net(onMsg, st => {
    $('netdot').classList.toggle('ok', st === 'online');
    if (st === 'online' && snap) net.pub('rainnow', snap, true);
  });
  net.sub('hub/in');
  net.sub('g/+');
  net.connect();

  const groupMembers = g => [...clients.values()].filter(c => c.gid === g);
  function sendAssign(g, extra = {}) {
    const mem = groupMembers(g).map(c => ({ id: c.id, ox: c.ox, oy: c.oy, w: c.w, h: c.h, num: c.num, color: c.color }));
    if (mem.length > 1 && !since.has(g)) since.set(g, Date.now());
    if (mem.length < 2) since.delete(g);
    for (const c of groupMembers(g)) net.pub('c/' + c.id, { type: 'assign', gid: g, members: mem, since: since.get(g), ...extra });
  }
  function stats() {
    const gs = new Set([...clients.values()].map(c => c.gid));
    const largest = Math.max(0, ...[...gs].map(g => groupMembers(g).length));
    net.pub('stats', { joins, online: clients.size, groups: gs.size, largest }, true);
  }

  function onMsg(topic, m) {
    if (topic === 'hub/in') return hub(m);
    if (topic.startsWith('g/')) return echo(topic.slice(2), m);
  }

  function hub(m) {
    if (!m || !m.id) return;
    let c = clients.get(m.id);
    if (m.type === 'ping') { net.pub('c/' + m.id, { type: 'pong', t0: m.t0, hub: Date.now() }); }
    if (!c && (m.type === 'hello' || m.type === 'hb')) {
      // give each phone a colour nobody online is using (8 colours, then they repeat)
      const used = new Set([...clients.values()].map(o => o.color));
      let col = 0; while (used.has(col) && col < 8) col++;
      c = { id: m.id, w: m.w || 390, h: m.h || 844, gid: m.id, ox: 0, oy: 0, num: nextNum++, color: col < 8 ? col : (nextNum % 8), seen: Date.now() };
      clients.set(m.id, c);
      joins++; try { localStorage.setItem('rc_joins', joins); } catch (e) {}
      sendAssign(c.gid);
      wallJoin(c.gid, 1);
      stats();
      return;
    }
    if (!c) return;
    c.seen = Date.now();
    if (m.type === 'hello') sendAssign(c.gid);
    // phone's picture of its group drifted (lost message, wall restarted): resend it
    if (m.type === 'hb' && (m.gid !== c.gid || m.n !== groupMembers(c.gid).length)) sendAssign(c.gid);
    if ((m.type === 'hb' || m.type === 'hello') && m.w && (m.w !== c.w || m.h !== c.h)) { c.w = m.w; c.h = m.h; sendAssign(c.gid); }
    if (m.type === 'exit' || m.type === 'enter') swipe(m);
    if (m.type === 'blow') { blowers.set(m.id, { at: Date.now(), s: m.s || 0.5 }); lastPhone = Date.now(); }
  }

  /* A swipe that leaves phone A's edge and lands on phone B's opposite edge
     within ~1.5 s joins B (and everyone already with B) to A's group.
     Messages can arrive in either order, so both halves wait in `exits`. */
  const OPP = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
  function swipe(m) {
    const now = Date.now();
    if (RC.debug) console.log('swipe', m.type, m.id, m.side, Math.round(m.pos), now % 100000, JSON.stringify(exits.map(e => [e.kind, e.id, e.side, now - e.at])));
    while (exits.length && now - exits[0].at > 2500) exits.shift();
    let best = null;
    for (const o of exits) {
      if (o.kind === m.type || o.id === m.id || OPP[o.side] !== m.side) continue;
      const p = clients.get(o.id), q = clients.get(m.id);
      if (!p || !q || p.gid === q.gid) continue;
      const dt = now - o.at;
      if (dt < 1500 && (!best || dt < best.dt)) best = { o, dt };
    }
    if (!best) { exits.push({ kind: m.type, id: m.id, side: m.side, pos: m.pos, at: now }); return; }
    exits.splice(exits.indexOf(best.o), 1);
    const ex = m.type === 'exit' ? m : best.o, en = m.type === 'enter' ? m : best.o;
    link(clients.get(ex.id), ex, clients.get(en.id), en);
  }
  function link(a, e, b, m) {
    // where B must sit (in A's group coordinates) so the swipe line is continuous
    let nx, ny;
    if (e.side === 'right') { nx = a.ox + a.w; ny = a.oy + e.pos - m.pos; }
    if (e.side === 'left') { nx = a.ox - b.w; ny = a.oy + e.pos - m.pos; }
    if (e.side === 'bottom') { ny = a.oy + a.h; nx = a.ox + e.pos - m.pos; }
    if (e.side === 'top') { ny = a.oy - b.h; nx = a.ox + e.pos - m.pos; }
    const dx = nx - b.ox, dy = ny - b.oy, oldG = b.gid;
    for (const c of groupMembers(oldG)) { c.ox += dx; c.oy += dy; c.gid = a.gid; }
    const seam = e.side === 'right' ? { x: a.ox + a.w, y: a.oy + e.pos } :
                 e.side === 'left' ? { x: a.ox, y: a.oy + e.pos } :
                 e.side === 'bottom' ? { x: a.ox + e.pos, y: a.oy + a.h } : { x: a.ox + e.pos, y: a.oy };
    sendAssign(a.gid, { seam, joined: b.id });
    lastJoinColor = b.color;
    anchors.delete(oldG);
    wallJoin(a.gid, groupMembers(a.gid).length);
    stats();
  }

  /* ---------------- breath storm: 2+ people blowing at once (anywhere) = storm + lightning;
     more people = louder storm, more lightning. Strikes are shared so every screen flashes together. */
  let stormLevel = 0, stormN = 0, lastStormPub = 0;
  setInterval(() => {
    const now = Date.now();
    for (const [id, b] of blowers) if (now - b.at > 900) blowers.delete(id);
    const n = blowers.size;
    const avg = n ? [...blowers.values()].reduce((a, b) => a + b.s, 0) / n : 0;
    const level = n < 2 ? 0 : Math.min(1, 0.22 + (n - 2) * 0.18 + avg * 0.12);
    if (n !== stormN || Math.abs(level - stormLevel) > 0.02 || now - lastStormPub > 1500) {
      stormN = n; stormLevel = level; lastStormPub = now;
      net.pub('storm', { n, level: +level.toFixed(2) });
      net.pub('td', { type: 'storm', n, level: +level.toFixed(2) });
      S.setStorm(level);
    }
    if (level > 0 && Math.random() < (0.3 + level * 2.2) * 0.25) {
      const strike = { seed: Math.floor(Math.random() * 1e9), u: +(0.08 + Math.random() * 0.84).toFixed(3), power: +(0.45 + 0.55 * level * Math.random()).toFixed(2) };
      net.pub('strike', strike);
      net.pub('td', Object.assign({ type: 'strike' }, strike));
      R.addBolt(Object.assign({ t: T() }, strike));
      S.thunder(strike.power, 0.25 + hash(strike.seed + 3) * 0.9);
    }
  }, 250);
  const tickStorm = () => { R.storm += (stormLevel - R.storm) * 0.04; requestAnimationFrame(tickStorm); };
  requestAnimationFrame(tickStorm);

  // forget phones that closed the page
  setInterval(() => {
    const now = Date.now(), touched = new Set();
    for (const c of [...clients.values()]) if (now - c.seen > 10000) { clients.delete(c.id); touched.add(c.gid); }
    touched.forEach(g => groupMembers(g).length ? sendAssign(g) : anchors.delete(g));
    if (touched.size) stats();
  }, 2000);
  setInterval(stats, 10000);

  /* ---------------- echoes of phone activity on the wall */
  function anchor(g) {
    if (!anchors.has(g)) anchors.set(g, { x: (0.12 + Math.random() * 0.76) * R.worldW, y: (0.18 + Math.random() * 0.45) * R.worldH });
    return anchors.get(g);
  }
  let lastPhone = -1e9;                // ms; any phone tap / drag / join
  function echo(g, m) {
    lastPhone = Date.now();
    if (!m || !clients.size) return;
    const mem = groupMembers(g);
    if (!mem.length) return;
    // map the phone (or the whole row of joined phones) onto the full wall:
    // left of the phones = left of the wall, top = top
    const minX = Math.min(...mem.map(c => c.ox)), minY = Math.min(...mem.map(c => c.oy));
    const maxX = Math.max(...mem.map(c => c.ox + c.w)), maxY = Math.max(...mem.map(c => c.oy + c.h));
    const gu = clamp((m.x - minX) / Math.max(1, maxX - minX), 0, 1), gv = clamp((m.y - minY) / Math.max(1, maxY - minY), 0, 1);
    const x = R.view.x + (0.05 + 0.9 * gu) * R.worldW, y = R.view.y + (0.08 + 0.84 * gv) * R.worldH;
    if (m.type === 'tap') { R.addRipple({ x, y, t: T(), seed: m.seed || 1, k: 0.8, c: m.c }); S.plip(clamp(x / R.worldW, 0, 1), 0.18); { const at = RainSound.nextPulse(T()); S.voice(m.c, RainSound.noteFor(m.c, clamp(x / R.worldW, 0, 1), at), at, T(), 0.2, clamp(x / R.worldW, 0, 1)); } }
    if (m.type === 'wind') { R.addImpulse({ x, y, dx: m.dx * 0.8, dy: m.dy * 0.8, r: 70, t: T() }); R.addTrail({ x, y, t: T(), c: m.c }); }
    // simple feed for TouchDesigner: positions 0..1 on the wall
    if (m.type === 'tap' || m.type === 'wind')
      net.pub('td', { type: m.type, u: +clamp(x / R.worldW, 0, 1).toFixed(3), v: +clamp(y / R.worldH, 0, 1).toFixed(3),
                      du: m.dx ? +(m.dx / 55).toFixed(2) : 0, dv: m.dy ? +(m.dy / 55).toFixed(2) : 0, n: mem.length, c: m.c });
  }
  let lastJoinColor = null;
  function wallJoin(g, n) {
    const a = anchor(g);
    R.addFlash({ x: a.x, y: a.y, t: T(), c: lastJoinColor });
    R.addRipple({ x: a.x, y: a.y, t: T(), seed: Math.random() * 1e6 | 0, k: 1.4 });
    R.bright = 1.2;
    lastPhone = Date.now();
    S.chime(n - 1, 0, 0.26);
    net.pub('td', { type: 'join', n, u: +clamp(a.x / R.worldW, 0, 1).toFixed(3), v: +clamp(a.y / R.worldH, 0, 1).toFixed(3), online: clients.size });
  }

  /* ---------------- live world rain: fetch, show, share with phones */
  let snap = null;
  function setSnap(s) {
    snap = s; M.setSnapshot(s);
    $('pct').textContent = s.pct.toFixed(1);
    $('meta').textContent = `${s.raining} of ${s.n} evenly spread points on Earth report rain · Open-Meteo · ${fmtTime(s.t)}`;
    S.setRain(clamp(s.pct / 30, 0, 1));
    R.density = 0.9 + clamp(s.pct / 25, 0, 1) * 0.6;
    net.pub('rainnow', s, true);
  }
  async function refresh() {
    try { const s = await fetchRainNow(); cacheSet(s); setSnap(s); }
    catch (e) { const c = cacheGet(); if (c) setSnap(c); else $('meta').textContent = 'live rain data unavailable — retrying'; }
  }
  const cached = cacheGet();
  if (cached) setSnap(cached);
  if (!cached || Date.now() - cached.t > 10 * 60e3) refresh();
  setInterval(refresh, RC.refreshMin * 60e3);

  // the map fades in every 90 s for 20 s
  let mapOn = false;
  setInterval(() => { mapOn = true; $('wallmap').classList.add('on'); setTimeout(() => { mapOn = false; $('wallmap').classList.remove('on'); }, 20000); }, 90000);

  /* ---------------- start + loop */
  $('start').onclick = () => { S.start(); if (snap) S.setRain(clamp(snap.pct / 30, 0, 1)); S.startPad(T); $('start').remove(); };
  if (TDMODE) {
    // inside TouchDesigner: no overlay; sound starts at once, or on the first click TouchDesigner sends
    $('start').remove();
    const kick = () => { S.start(); if (snap) S.setRain(clamp(snap.pct / 30, 0, 1)); S.startPad(T); };
    kick();
    addEventListener('pointerdown', kick); addEventListener('click', kick); addEventListener('keydown', kick);
  }

  /* ---------------- auto music: the world's rain, played softly where it is raining right now.
     It pauses while phones are playing and comes back after a few quiet seconds. */
  let duck = 1;
  setInterval(() => {
    const quiet = (Date.now() - lastPhone) / 1000;
    const target = quiet < 4 ? 0 : 1;
    duck += (target - duck) * (target < duck ? 0.6 : 0.06);
    if (!snap || !S.ctx || S.ctx.state !== 'running' || duck < 0.04) return;
    const wet = snap.pts.filter(p => isRaining(p[2], p[3]));
    if (!wet.length || Math.random() > 0.14 + snap.pct / 100) return;
    const [lat, lon, mm] = wet[Math.floor(Math.random() * wet.length)];
    const u = (lon + 180) / 360, v = (90 - lat) / 180;
    const ci = lat >= 0 ? 2 : 4;                         // north: glass, south: felt piano
    const at = RainSound.nextPulse(T());
    S.voice(ci, RainSound.noteFor(ci, u, at), at, T(), 0.16 * duck * (0.6 + 0.4 * Math.min(1, (mm || 0.3) / 4)), u);
    // and a quiet bloom where that rain is falling (longitude across, latitude down)
    R.addRipple({ x: R.view.x + u * R.worldW, y: R.view.y + (0.12 + v * 0.76) * R.worldH, t: at, seed: Math.floor(Math.random() * 1e6), k: 0.45, echo: true });
  }, MUSIC.pulse * 1000);
  addEventListener('keydown', e => {
    if (e.key === 'f') document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    if (e.key === 'm') { mapOn = !mapOn; $('wallmap').classList.toggle('on', mapOn); }
  });
  function frame() {
    const t = T();
    R.draw(t);
    if (mapOn || $('wallmap').classList.contains('on')) {
      const r = $('map').getBoundingClientRect();
      M.draw(t, r.width, r.height, Math.min(devicePixelRatio || 1, 2));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  if (RC.debug) window.__hub = { clients, exits, net, R, get joins() { return joins; } };
})();
