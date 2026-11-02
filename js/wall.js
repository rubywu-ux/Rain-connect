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
  function echo(g, m) {
    if (!m || !clients.size) return;
    const a = anchor(g), mem = groupMembers(g);
    if (!mem.length) return;
    const minX = Math.min(...mem.map(c => c.ox)), minY = Math.min(...mem.map(c => c.oy));
    const x = a.x + (m.x - minX) * 0.45, y = a.y + (m.y - minY) * 0.3;
    if (m.type === 'tap') { R.addRipple({ x, y, t: T(), seed: m.seed || 1, k: 0.8, c: m.c }); S.plip(clamp(x / R.worldW, 0, 1), 0.18); { const at = RainSound.nextPulse(T()); S.voice(m.c, RainSound.noteFor(m.c, clamp(x / R.worldW, 0, 1), at), at, T(), 0.12, clamp(x / R.worldW, 0, 1)); } }
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
  $('start').onclick = () => { S.start(); if (snap) S.setRain(clamp(snap.pct / 30, 0, 1)); $('start').remove(); };
  if (TDMODE) $('start').remove();
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
