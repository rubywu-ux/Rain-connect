/* Rain Connect — wall page. Shows the big rain, and is also the HUB:
 * it keeps the clock, groups phones that are swiped together, counts joins,
 * and fetches + shares the live world rain snapshot. Keep exactly one wall open. */
(() => {
  const $ = id => document.getElementById(id);
  const R = new RainRenderer($('rain'), { scale: 1.6, detail: +(new URLSearchParams(location.search).get('detail') || 0.6) });
  /* ---------------- the wall IS the world's rain: one plume for every place where it is raining now,
     placed like a map (east-west across, north-south down), sized by how hard it is raining there */
  // the world sits centred: 180W..180E across, 80N..60S down (the poles are left out)
  const siteX = u => R.view.x + (0.07 + 0.86 * u) * R.worldW;
  const latV = v => clamp(((90 - v * 180) * -1 + 80) / 140, 0, 1);      // v (0 = N pole) -> 0..1 between 80N and 60S
  const siteY = v => R.view.y + (0.16 + 0.58 * latV(v)) * R.worldH;
  let siteInfo = new Map();        // site id -> {lat, lon, mm, code, where, words}
  let art = 0, lastArt = 1;        // art mode: 0 = the map of plumes, 1..N = ART_MODES (see setArt)
  const NART = typeof ART_MODES !== 'undefined' ? ART_MODES.length : 0;
  function buildSites(s) {
    const out = [];
    siteInfo = new Map();
    (s.pts || []).forEach((p, idx) => {
      const [lat, lon, mm, code] = p;
      if (!isRaining(mm, code)) return;
      const id = 5000 + idx, u = (lon + 180) / 360, v = (90 - lat) / 180;
      out.push({ id, x: siteX(u), y: siteY(v), k: rainStrength(mm, code), u, v });
      siteInfo.set(id, { lat, lon, mm, code, idx });
    });
    out.sort((a, b) => b.k - a.k);
    const sites = out.slice(0, 60);
    R.sites = sites;
  }
  /* the ghost of the world: every 2° of land as a faint dot, in the same map the plumes hang from */
  function buildGhost() {
    const g = document.createElement('canvas'); g.width = Math.round(innerWidth / 2); g.height = Math.round(innerHeight / 2);
    const x = g.getContext('2d'), k = g.width / R.w;
    x.fillStyle = '#fff';
    for (let r = 0; r < 90; r++) for (let c = 0; c < 180; c++) {
      if (!LAND_MASK[r * 180 + c]) continue;
      const lat = 89 - r * 2, lon = -179 + c * 2;
      if (lat < -60 || lat > 80) continue;          // leave the poles out: they would be long bands
      const px = (siteX((lon + 180) / 360) - R.view.x) * R.scale * k, py = (siteY((90 - lat) / 180) - R.view.y) * R.scale * k;
      x.fillRect(px, py, 1, 1);
    }
    R.ghost = g; R.ghostVer = (R.ghostVer || 0) + 1;
  }
  buildGhost();
  addEventListener('resize', () => { if (snap) buildSites(snap); buildGhost(); });
  const nameOf = id => { const i = siteInfo.get(id); if (!i) return null; if (!i.where) { i.where = placeName(i.lat, i.lon).where; i.words = rainWords(i.mm, i.code); } return i; };
  /* a quiet caption beside a plume: what kind of rain, and where */
  function tag(site, text, sub, strong) {
    const el = document.createElement('div');
    el.className = 'site-tag' + (strong ? ' strong' : '');
    el.innerHTML = `<b>${text}</b>${sub ? `<small>${sub}</small>` : ''}`;
    const x = (site.x - R.view.x) * R.scale, y = (site.y - R.view.y) * R.scale;
    el.style.left = Math.min(innerWidth - innerWidth * 0.24 - 20, Math.max(20, x + 18)) + 'px';
    el.style.top = Math.min(innerHeight * 0.62, Math.max(innerHeight * 0.12, y - 10)) + 'px';
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    setTimeout(() => { el.classList.remove('on'); setTimeout(() => el.remove(), 1600); }, strong ? 6000 : 5000);
  }
  function tagSite(site, strong, who) {
    if (art) return;                  // art mode: no words on the wall
    const i = nameOf(site.id); if (!i) return;
    tag(site, `${i.words} ${i.where}`, who || 'right now', strong);
  }

  /* ---------------- the rain remembers: stains where it has rained, kept across reloads, fading over a day */
  R.enableMemory();
  R.bottomFade = 0.55; R.haze = 0.04; R.breathe = true; R.noBoltLines = true;   // a sky to fall from, and a slow pulse with the rain             // the plumes thin out toward the bottom: the numbers and the QR sit on quieter ground
  try {
    const m = JSON.parse(localStorage.getItem('rc_memory2') || 'null');
    if (m && Date.now() - m.t < 24 * 3600e3) {
      const img = new Image();
      img.onload = () => { R.memory.getContext('2d').drawImage(img, 0, 0, R.memory.width, R.memory.height); R.fadeMemory(Math.min(0.9, (Date.now() - m.t) / (24 * 3600e3))); };
      img.src = m.img;
    }
  } catch (e) {}
  setInterval(() => {
    if (!R.memoryDirty) return;
    R.memoryDirty = false;
    try { localStorage.setItem('rc_memory2', JSON.stringify({ t: Date.now(), img: R.memory.toDataURL('image/png') })); } catch (e) {}
  }, 60e3);
  setInterval(() => R.fadeMemory(0.03), 10 * 60e3);   // about a day for a stain to disappear
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
  function drawQR() {
    try {
      const qr = qrcode(0, 'M'); qr.addData(phoneUrl.href); qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      const svg = $('qr').querySelector('svg');
      svg.querySelectorAll('rect').forEach(r => r.setAttribute('fill', `rgb(${PAL.bg})`));
      svg.querySelectorAll('path').forEach(p => p.setAttribute('fill', `rgb(${PAL.ink})`));
    } catch (e) { $('qr').textContent = phoneUrl.href; }
  }
  drawQR();
  addEventListener('inkchange', () => { drawQR(); R.fresh = true; });

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
    if (st === 'online') pubArt();
  });
  net.sub('hub/in');
  net.sub('g/+');
  net.sub('weather');          // from TouchDesigner: how the mist is moving
  net.connect();

  const groupMembers = g => [...clients.values()].filter(c => c.gid === g);
  const bornAt = Date.now();
  setInterval(() => { const t = document.querySelector('.wall-title'); if (t) t.classList.toggle('rest', Date.now() - bornAt > 60000 && Date.now() - lastPhone < 120000); }, 1000);
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
    if (topic === 'weather') return onWeather(m);
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
    if (m.type === 'ix') ixIn(m, c);
    if (m.type === 'look') look(m, c);
  }
  /* a phone tapped a raining place on its map: the wall points at the same place. On the rain map a bloom and a
     caption by its plume; in Umbrellas that person's umbrella lights up in the phone's colour, and the caption
     names the place. */
  function look(m, c) {
    lastPhone = Date.now();
    const st = R.sites && R.sites.find(z => z.id === m.site); if (!st) return;
    const col = c ? c.color : m.c;
    if (art) { R.artLook = { site: st.id, col, t: T() }; const i = nameOf(st.id); if (i) artNote(`${i.where} · ${i.words}`, col); return; }
    R.addRipple({ x: st.x, y: st.y + 30, t: T(), seed: (m.site * 7) % 1000 + 1, k: 1.1, c: col }); R.bright = Math.max(R.bright, 0.6);
    tagSite(st, true, 'someone is looking at this rain'); lastTag = Date.now();
  }
  /* ---------------- test panel on the phones (js/lab.js): interaction ideas for the art modes.
     Steady controls (a bird you fly, a walker, a held finger) keep their latest message in R.ixLive;
     one-off gestures (a drawn shape, a swipe) also go to R.ixEv. The art modes read both (ixOf). */
  R.ixLive = new Map(); R.ixEv = [];
  function ixIn(m, c) {
    lastPhone = Date.now();
    const e = Object.assign({}, m, { col: c.color, at: T() });
    R.ixLive.set(m.id + ':' + m.k, e);
    if (m.once) { R.ixEv.push(e); R.ixEv = R.ixEv.filter(o => e.at - o.at < 12); }
    for (const [key, o] of R.ixLive) if (e.at - o.at > 20) R.ixLive.delete(key);
  }
  // the phones show the panel for the view the wall is on
  function pubArt() { try { net.pub('art', { n: art, name: art ? ART_MODES[art - 1].name : 'map', at: Date.now() }, true); } catch (e) {} }
  setInterval(pubArt, 5000);

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
      S.setStorm(Math.max(level, mistStorm));
    }
    if (level > 0 && Math.random() < (0.3 + level * 2.2) * 0.25) {
      const strike = { seed: Math.floor(Math.random() * 1e9), u: +(0.08 + Math.random() * 0.84).toFixed(3), power: +(0.45 + 0.55 * level * Math.random()).toFixed(2) };
      net.pub('strike', strike);
      net.pub('td', Object.assign({ type: 'strike' }, strike));
      R.addBolt(Object.assign({ t: T() }, strike));
      S.thunder(strike.power, 0);
    }
  }, 250);
  const tickStorm = () => { R.storm += (Math.max(stormLevel, mistStorm) - R.storm) * 0.04; requestAnimationFrame(tickStorm); };
  requestAnimationFrame(tickStorm);

  /* ---------------- mist weather (wall only). TouchDesigner watches the mist through the webcam and
     sends w = 0 (no mist) .. 1 (mist thrown about). The wall answers with the weather:
       calm  (w < 0.25): the rain stops, the room brightens to light mode, leaves rustle, small birds
       rain  (0.25-0.6): the usual rain, dark
       storm (w > 0.6):  gusts of wind, darker, the rain leans; louder the harder the mist moves
     Nothing here goes to the phones: their rain, music and breath storm are untouched. */
  /* art modes (wall only): no map, no numbers, no labels. Same live data underneath, drawn as one of
     several pictures (js/artmodes.js). n = 0 is the map view; true = the last mode used, false = off. */
  function setArt(n) {
    if (n === true) n = lastArt || 1; else if (n === false || n == null) n = 0;
    n = clamp(Math.round(+n) || 0, 0, NART);
    if (n !== art && R.cv.width) crossfade();                                      // the last picture lingers over the new one
    art = n; if (n) lastArt = n;
    const mode = n ? ART_MODES[n - 1] : null;
    try { localStorage.setItem('rc_art', String(n)); } catch (e) {}
    document.body.classList.toggle('art', n > 0);
    $('art').classList.toggle('on', n > 0);
    $('art').textContent = mode ? mode.title.toLowerCase() : 'rain map';
    // modes with their own dark palette keep it in the light theme too: the page's vignette would tint their edges
    const vig = document.querySelector('.vignette'); if (vig) vig.style.opacity = mode && mode.dark ? '0' : '';
    R.hideUnder = n > 0;              // the stippled map and the stains belong to the map view
    R.art = n > 0; R.artIdx = n;      // the renderer draws the art mode instead of the map of plumes
    R._artSt = null; R._pc = null; R.fresh = true;
    if (mode && mode.dark && INK) setInk(false);                                 // the art is light on black; so is the page around it
    if (!mode && light !== INK) { turnTo = light; if (!turnRaf) { turnLast = performance.now(); turnRaf = requestAnimationFrame(turnStep); } }
    if (snap) buildSites(snap);
    if (typeof pubArt === 'function') pubArt();
    artLine();
  }
  /* the one line of words the art keeps: what the picture is made of */
  function artLine() {
    const el = $('artline'); if (!el) return;
    if (!art || !snap) { el.classList.remove('on'); return; }
    el.innerHTML = `right now <b>${snap.pct.toFixed(1)}%</b> of Earth is under rain<i>each umbrella is a place where it is raining · live from Open-Meteo</i>`;
    el.classList.add('on');
  }
  /* what the picture tells us: a place whose umbrella the wind took, someone who found shelter under a phone's.
     A quiet caption, and a soft note in that phone's colour. */
  let lastNote = 0;
  function artEvents() {
    const evs = R.artEv; if (!evs || !evs.length) return;
    R.artEv = [];
    const now = Date.now();
    for (const ev of evs) {
      const i = nameOf(ev.site); if (!i) continue;
      if (ev.kind === 'shelter') {
        const at = RainSound.nextPulse(T()), u = clamp(ev.u == null ? 0.5 : ev.u, 0, 1);
        if (ev.c != null) S.voice(ev.c, RainSound.noteFor(ev.c, u, at), at, T(), 0.16 * duckN(), u);
        if (now - lastNote > 3500) { lastNote = now; artNote(`someone from ${i.where} found shelter`, ev.c); }
      } else if (ev.kind === 'lost' && now - lastNote > 5000) { lastNote = now; artNote(`${i.where} · ${i.words}, an umbrella lost to the wind`); }
    }
  }
  function artNote(text, c) {
    const el = $('artnote'); if (!el) return;
    el.textContent = text; el.style.color = c != null ? `rgb(${colorOf(c)})` : '';
    el.classList.add('on'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('on'), 5200);
  }
  const duckN = () => 1 / Math.sqrt(Math.max(1, clients.size / 3));        // many phones: each note a little softer
  setInterval(artEvents, 250);
  setInterval(() => { R.quiet = clients.size ? 0 : clamp((Date.now() - lastPhone - 45000) / 45000, 0, 1); }, 1000);
  // A / Z step through the three views: the rain map (0), then each art mode, then the map again
  const cycleArt = (d = 1) => setArt(((art + (d < 0 ? -1 : 1)) % (NART + 1) + NART + 1) % (NART + 1));
  // the switch lives here on the wall (button / W key); TouchDesigner's Mist toggle can flip it too
  let mistOn = false, wTarget = 0, w = 0, mistStorm = 0, light = true, lastGust = 0, lastMistBolt = 0, baseDensity = 1.2, mistSeen = 0;
  try { mistOn = localStorage.getItem('rc_mist') === '1'; } catch (e) {}
  let eT = 0, xT = 0, yT = 0;      // for the art modes: how hard the mist moves right now, and where in the pot (-1..1)
  function onWeather(m) {
    if (!m || typeof m !== 'object') return;
    if (m.set != null) setMist(!!m.set);
    if (m.w != null) { mistSeen = Date.now(); wTarget = clamp(+m.w, 0, 1); }
    if (m.e != null) eT = clamp(+m.e || 0, 0, 1);
    if (m.x != null) xT = clamp(+m.x || 0, -1, 1);
    if (m.y != null) yT = clamp(+m.y || 0, -1, 1);
    if (mistOn && S.ctx) R.mistE = Math.max(R.mistE, eT);    // a blow shows at once; it settles in the loop below
  }
  function setMist(on) {
    mistOn = on;
    try { localStorage.setItem('rc_mist', on ? '1' : '0'); } catch (e) {}
    $('mist').classList.toggle('on', on);
  }
  // light <-> dark: the picture slowly turns over (about 3.5 s) while it keeps moving, instead of a flash.
  // The two palettes are close to each other's negative, so the canvas is inverted with a CSS filter,
  // eased 0 -> 1; at the end the palette is swapped and the pixels already drawn are inverted for real,
  // so nothing jumps. If the weather turns back half way, it turns back from where it is.
  const TURN_MS = 3500;
  let turnP = 0, turnTo = null, turnRaf = 0, turnLast = 0;
  function turnStep(now) {
    if (art && (ART_MODES[art - 1].dark || ART_MODES[art - 1].turn === 'dissolve')) {   // switched to a picture that changes on its own
      turnP = 0; R.cv.style.filter = ''; if (turnTo !== INK) setInk(turnTo); turnRaf = 0; return;
    }
    const dt = Math.min(100, now - turnLast); turnLast = now;
    turnP = clamp(turnP + (turnTo !== INK ? 1 : -1) * dt / TURN_MS, 0, 1);
    const k = turnP * turnP * (3 - 2 * turnP);
    document.documentElement.classList.toggle('ink', turnP > 0.5 ? !INK : INK);   // titles and numbers cross over half way
    if (turnP >= 1) {
      const c = R.ctx;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'difference'; c.fillStyle = '#fff';
      c.fillRect(0, 0, R.cv.width, R.cv.height); c.restore();
      setInk(turnTo); R.fresh = false; turnP = 0; R.cv.style.filter = '';
    } else R.cv.style.filter = k > 0.002 ? `invert(${k.toFixed(3)})` : '';
    turnRaf = turnP > 0 || turnTo !== INK ? requestAnimationFrame(turnStep) : 0;
  }
  // colourful pictures that follow the theme (Rain Garden) would turn to their complementary colours
  // while inverting: those dissolve instead (the last frame fades out over the new one)
  let xfade = null;
  function crossfade() {                                        // keep the current frame and let it fade over whatever comes next
    if (!xfade) {
      xfade = document.createElement('canvas'); xfade.setAttribute('aria-hidden', 'true');
      xfade.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;opacity:0';
      R.cv.after(xfade);
    }
    xfade.width = R.cv.width; xfade.height = R.cv.height;
    xfade.style.width = R.cv.style.width || '100vw'; xfade.style.height = R.cv.style.height || '100vh';
    xfade.getContext('2d').drawImage(R.cv, 0, 0);
    xfade.style.transition = 'none'; xfade.style.opacity = '1';
    void xfade.offsetWidth;
    xfade.style.transition = 'opacity 2.2s cubic-bezier(.45,0,.55,1)'; xfade.style.opacity = '0';
  }
  function dissolve(on) {
    if (!xfade) {
      xfade = document.createElement('canvas'); xfade.setAttribute('aria-hidden', 'true');
      xfade.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;opacity:0';
      R.cv.after(xfade);
    }
    xfade.width = R.cv.width; xfade.height = R.cv.height;
    xfade.style.width = R.cv.style.width || '100vw'; xfade.style.height = R.cv.style.height || '100vh';
    xfade.getContext('2d').drawImage(R.cv, 0, 0);
    xfade.style.transition = 'none'; xfade.style.opacity = '1';
    void xfade.offsetWidth;
    setInk(on);
    xfade.style.transition = 'opacity 3s cubic-bezier(.45,0,.55,1)'; xfade.style.opacity = '0';
  }
  function setLight(on) {
    on = true;                                                      // fog, always: the weather shows as density and motion, not light and dark
    if (on === light) return;
    light = on;
    turnTo = on;
    const mode = art ? ART_MODES[art - 1] : null;
    if (mode && mode.dark) return;                                  // that picture keeps its own black: the page stays with it
    if (mode && mode.turn === 'dissolve') {
      if (turnRaf) { cancelAnimationFrame(turnRaf); turnRaf = 0; turnP = 0; R.cv.style.filter = ''; }
      if (on !== INK) dissolve(on);
      return;
    }
    if (!turnRaf) { turnLast = performance.now(); turnRaf = requestAnimationFrame(turnStep); }
  }
  setInterval(() => {
    const now = Date.now();
    // ?debug: window.__mistOverride = {w, e, x, y} stands in for TouchDesigner (tests)
    const ov = RC.debug && window.__mistOverride;
    if (ov) { mistSeen = now; wTarget = clamp(+ov.w || 0, 0, 1); eT = clamp(+ov.e || 0, 0, 1); xT = clamp(+ov.x || 0, -1, 1); yT = clamp(+ov.y || 0, -1, 1); }
    if (mistOn && now - mistSeen > 20000) { wTarget = 0.4; eT = 0; }   // TouchDesigner went quiet: fall back to plain rain
    w += (wTarget - w) * 0.12;
    const active = (mistOn || !!ov) && S.ctx;
    const calm = active ? clamp((0.25 - w) / 0.25, 0, 1) : 0;
    mistStorm = active ? clamp((w - 0.6) / 0.4, 0, 1) : 0;
    // the art modes read the mist directly (0 when the mist switch is off)
    R.mistW = active ? w : 0;
    R.mistE += ((active ? eT : 0) - R.mistE) * 0.6;
    R.mistX += (xT - R.mistX) * 0.5; R.mistY += (yT - R.mistY) * 0.5;
    setLight(active && (light ? w < 0.3 : w < 0.18));
    // the rain fades out / back in, smoothly; in art mode it never fully stops, so the picture stays alive
    R.presence += (Math.max(art ? 0.45 : 0, 1 - calm) - R.presence) * 0.08;
    S.setRain(rainLevel * (1 - calm) * (1 + 0.6 * mistStorm));
    S.setCalm(calm);
    if (!blowers.size || stormLevel < mistStorm) S.setStorm(Math.max(stormLevel, mistStorm));
    if (mistStorm > 0.05 && now - lastGust > 2600 - 1200 * mistStorm && Math.random() < 0.35) { lastGust = now; S.gust(0.25 + 0.5 * mistStorm * Math.random()); }
    // mist storm: lightning across the wall and deep, rolling thunder (wall only, phones never see it)
    if (mistStorm > 0.08 && now - lastMistBolt > 900 && Math.random() < 0.04 + 0.2 * mistStorm) {
      lastMistBolt = now;
      const b = { seed: Math.floor(Math.random() * 1e9), u: +(0.06 + Math.random() * 0.88).toFixed(3), power: +(0.4 + 0.6 * mistStorm * (0.5 + 0.5 * Math.random())).toFixed(2),
                  across: Math.random() < 0.55, t: T() };
      R.addBolt(b);
      S.thunder(b.power, 0, 1.35);        // sound starts with the flash: deep, crisp, loud, different each time
      net.pub('td', { type: 'strike', source: 'mist', u: b.u, power: b.power });
    }
    $('mist').textContent = !mistOn ? 'mist · off' : `mist · ${w < 0.25 ? 'calm' : w < 0.6 ? 'rain' : 'storm'}`;
  }, 250);
  let rainLevel = 0.25;

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
    const st = m.type === 'tap' && m.site != null && R.sites ? R.sites.find(z => z.id === m.site) : null;
    if (st) { R.addRipple({ x: st.x, y: st.y + 30, t: T(), seed: m.seed || 1, k: 0.9 }); R.bright = Math.max(R.bright, 0.6); tagSite(st, true, 'someone here is holding this rain'); lastTag = Date.now(); }
    if (m.type === 'tap' && !st) R.addRipple({ x, y, t: T(), seed: m.seed || 1, k: 0.8, c: m.c });
    if (m.type === 'tap') { S.plip(clamp(x / R.worldW, 0, 1), 0.18); { const at = RainSound.nextPulse(T()); S.voice(m.c, RainSound.noteFor(m.c, clamp(x / R.worldW, 0, 1), at), at, T(), 0.2 * duckN(), clamp(x / R.worldW, 0, 1)); } }
    if (m.type === 'wind') { R.addImpulse({ x, y, dx: m.dx * 0.8, dy: m.dy * 0.8, r: 70, t: T() }); R.addTrail({ x, y, t: T(), c: m.c }); }
    // simple feed for TouchDesigner: positions 0..1 on the wall
    if (m.type === 'tap' || m.type === 'wind')
      net.pub('td', { type: m.type, u: +clamp(x / R.worldW, 0, 1).toFixed(3), v: +clamp(y / R.worldH, 0, 1).toFixed(3),
                      du: m.dx ? +(m.dx / 55).toFixed(2) : 0, dv: m.dy ? +(m.dy / 55).toFixed(2) : 0, n: mem.length, c: m.c });
  }
  let lastJoinColor = null;
  function wallJoin(g, n) {
    const a = anchor(g);
    R.addRipple({ x: a.x, y: a.y, t: T(), seed: Math.random() * 1e6 | 0, k: 1.6, c: lastJoinColor });
    R.bright = 0.8;
    lastPhone = Date.now();
    S.chime(n - 1, 0, 0.26);
    net.pub('td', { type: 'join', n, u: +clamp(a.x / R.worldW, 0, 1).toFixed(3), v: +clamp(a.y / R.worldH, 0, 1).toFixed(3), online: clients.size });
  }

  /* ---------------- live world rain: fetch, show, share with phones */
  let snap = null;
  function setSnap(s) {
    snap = s; M.setSnapshot(s);
    $('pct').textContent = s.pct.toFixed(1); artLine();
    $('meta').textContent = `measured at ${s.n} places across Earth · live from Open-Meteo · ${fmtTime(s.t)}`;
    rainLevel = clamp(s.pct / 30, 0, 1);
    S.setRain(rainLevel);
    baseDensity = 1;
    R.density = baseDensity;
    R.snapPts = s.pts;               // every sample point, for the art modes
    buildSites(s);
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
  // (the old outline map no longer fades in: the stippled world under the plumes is the map now)

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
  let duck = 1, lastTag = 0;
  setInterval(() => {
    const quiet = (Date.now() - lastPhone) / 1000;
    const target = quiet < 4 ? 0 : 1;
    duck += (target - duck) * (target < duck ? 0.6 : 0.06);
    if (!snap || !S.ctx || S.ctx.state !== 'running' || duck < 0.04) return;
    const sites = R.sites || [];
    if (!sites.length || R.presence < 0.3 || Math.random() > 0.14 + snap.pct / 100) return;
    const site = sites[Math.floor(Math.random() * sites.length)], info = siteInfo.get(site.id);
    const lat = info ? info.lat : 0, mm = info ? info.mm : 0.3;
    const ci = lat >= 0 ? 2 : 4;                         // north: glass, south: felt piano
    const at = RainSound.nextPulse(T());
    S.voice(ci, RainSound.noteFor(ci, site.u, at), at, T(), 0.16 * duck * (0.6 + 0.4 * Math.min(1, (mm || 0.3) / 4)), site.u);
    // and a quiet bloom right where that place's rain is falling
    R.addRipple({ x: site.x, y: site.y + 30, t: at, seed: Math.floor(Math.random() * 1e6), k: 0.35 + 0.3 * site.k, echo: true });
    if (Date.now() - lastTag > 22000 && Math.random() < 0.5) { lastTag = Date.now(); tagSite(site); }
  }, MUSIC.pulse * 1000);
  addEventListener('keydown', e => {
    if (e.key === 'f') document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
    if (e.key === 'w') setMist(!mistOn);
    if (e.key === 'a') cycleArt();                                     // map -> 1 -> 2 -> map
    if (e.key === 'z') cycleArt(-1);                                   // back the other way
    if (/^[0-9]$/.test(e.key) && +e.key <= NART) setArt(+e.key);       // 0 = the rain map, 1..N pick a mode
    if (e.key === 'Escape' || e.key === 'x') setArt(0);                         // Esc / X = art off
  });
  function frame() {
    const t = T();
    R.draw(t);
    if (mapOn) {
      const r = $('map').getBoundingClientRect();
      M.draw(t, r.width, r.height, Math.min(devicePixelRatio || 1, 2));
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  $('mist').onclick = () => setMist(!mistOn);
  $('art').onclick = () => setArt(art >= NART ? 0 : art + 1);       // the button: modes, then off again
  window.__wall = { setArt, cycleArt, setMist, get art() { return art; }, get mist() { return mistOn; } };   // TouchDesigner flips these
  try { const a = +(localStorage.getItem('rc_art') || 0); if (a > 0) setArt(a); } catch (e) {}       // old '1' / '0' still work
  setMist(mistOn);
  if (RC.debug) window.__hub = { clients, exits, net, R, S, setMist, setSnap, tagSite, nameOf, get w() { return w; }, get light() { return light; }, get joins() { return joins; } };
})();
