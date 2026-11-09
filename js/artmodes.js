/* Connect the Rain — the wall's art mode: Umbrellas. No map: the same live data (where it is raining
 * right now, and the mist weather from the webcam) drawn as a plaza of people under umbrellas, in the
 * rain map's own language of light on black. RainRenderer._drawArt (common.js) calls draw(R, c, E) with
 *   T, dt        shared time in s, seconds since the last frame (0..0.1)
 *   W, H, s, lw  screen size in CSS px, world->screen scale, base line width; dpr
 *   sites        raining places [{id, u, v, k}]  u = (lon+180)/360, v = (90-lat)/180, k = rain strength 0.12..1
 *   pts          all sample points [lat, lon, mm, code] (mm / code can be null); site.id = 5000 + its index here
 *   storm, pres  storm 0..1 (the mist blown about); how settled the mist is, 1 = usual rain .. 0 = calm
 *   mist, e      mist weather 0..1; how hard the mist moves right now 0..1
 *   mx, my       where in the pot the mist moves, -1..1: a breath from the left of the pot pushes things right
 *   fresh        first frame (clear everything); st: this mode's own state (reset on a switch)
 * It never stops raining here: calm mist is a gentle rain, a disturbed mist is a storm.
 * tapsOf(R, E) turns R.ripples into screen points; ixOf(R, E) gives what the phones are doing (js/lab.js);
 * the mode leaves notes for the wall in R.artEv (a place name to show, a note to play). */
const ART_MODES = (() => {
  const TAU = Math.PI * 2;
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const calmOf = E => clamp((1 - E.pres) / 0.55, 0, 1);     // 0 = raining as usual .. 1 = calm (the art mode never fully stops)
  const windX = E => clamp(-E.mx * 1.5, -1, 1);             // where the breath pushes: from the left of the pot -> to the right
  const windY = E => clamp(-E.my * 1.5, -1, 1);
  const rnd = Math.random;

  /* a soft round glow sprite, one per colour and size */
  const _glows = new Map();
  function glow(rgb, size = 64, mid = 0.22) {
    const key = rgb + '|' + size + '|' + mid;
    let g = _glows.get(key);
    if (g) return g;
    g = canvas(size, size);
    const x = g.getContext('2d'), r = size / 2, gr = x.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(0.12, `rgba(${rgb},0.75)`); gr.addColorStop(0.35, `rgba(${rgb},${mid})`);
    gr.addColorStop(0.7, `rgba(${rgb},${mid * 0.22})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, size, size);
    _glows.set(key, g);
    return g;
  }
  /* ================================================================ shared by the modes: the rain itself
     Shared by them: the kind of rain at a place (from its WMO code), the daylight easing in for the calm
     (light) theme, the lightning flicker, and the taps from phones as points on the screen. */
  const codeOf = (E, z) => { const p = E.pts[z.id - 5000]; return p && p[3] != null ? p[3] : null; };
  const rainKind = code => code == null ? 1 : code >= 95 ? 3 : code >= 80 ? 2 : code >= 61 ? 1 : code >= 51 ? 0 : 1;   // 0 drizzle, 1 rain, 2 showers, 3 thunderstorm
  const kindOf = (E, z) => rainKind(codeOf(E, z));
  const latOf = z => 90 - z.v * 180;
  const southOf = z => clamp((80 - latOf(z)) / 140, 0, 1);            // 0 = 80N (top / far) .. 1 = 60S (bottom / near)
  function flicker(R, T) {                         // how bright the lightning is right now (it flickers twice), and its bolt
    let f = 0, bb = null;
    for (const b of R.bolts) {
      const a = T - b.t; if (a < 0) continue;
      const v = (a < 0.07 ? 1 : a < 0.12 ? 0.25 : a < 0.2 ? 0.9 : Math.max(0, 1 - (a - 0.2) / 0.9)) * (b.power || 0.6);
      if (v > f) { f = v; bb = b; }
    }
    return [f, bb];
  }
  function newBolts(R, st, T) {                    // strikes that began since the last frame
    const seen = st.bseen || (st.bseen = new WeakSet()), out = [];
    for (const b of R.bolts) if (T >= b.t && !seen.has(b)) { seen.add(b); out.push(b); }
    return out;
  }
  /* taps from phones (and the wall's own soft notes, echo: true) as points on the screen, with how long ago.
     The wall blooms a tap on a raining place just under that place's plume, so such a tap knows its place. */
  function tapsOf(R, E) {
    const st = E.st, T = E.T, first = !st.tseen, seen = st.tseen || (st.tseen = new WeakSet()), all = [], fresh = [];
    for (const r of R.ripples) {
      if (T < r.t) continue;
      if (r._site === undefined) { r._site = null; for (const z of E.sites) if (Math.abs(z.x - r.x) < 0.5 && Math.abs(z.y + 30 - r.y) < 0.5) { r._site = z.id; break; } }
      const q = { x: (r.x - R.view.x) * E.s, y: (r.y - R.view.y) * E.s, age: T - r.t, k: r.k || 1, echo: !!r.echo, site: r._site, seed: r.seed || 1 };
      all.push(q);
      if (!seen.has(r)) { seen.add(r); if (!first) fresh.push(q); }
    }
    return { all, fresh };
  }
  /* the phones' test panel (js/lab.js, wall.js ixIn): what each phone is doing in this mode right now.
     live: the latest message from each phone per control (only those still on); fresh: one-off gestures
     (a drawn shape, a swipe) not seen before. */
  function ixOf(R, E, mode) {
    const st = E.st, seen = st.ixSeen || (st.ixSeen = new WeakSet()), live = [], fresh = [];
    if (!R.ixLive) return { live, fresh };
    for (const e of R.ixLive.values()) if (e.m === mode && e.on !== 0 && E.T - e.at < (e.keep ? 3.5 : 1.2)) live.push(e);
    for (const e of R.ixEv) if (e.m === mode && !seen.has(e)) { seen.add(e); if (E.T - e.at < 2) fresh.push(e); }
    return { live, fresh };
  }
  const ixCol = e => colorOf(e.col).split(',').map(Number);
  const note = (R, ev) => { (R.artEv || (R.artEv = [])).push(ev); if (R.artEv.length > 20) R.artEv.shift(); };
  /* ============================================================== Umbrellas
     A plaza in the rain, seen from a high window. Every place where it is raining right now is somebody
     crossing it under an umbrella: where they walk from where the place is (east-west across, north on the
     far side, south on the near one), the size and brightness of the umbrella from how hard it is raining
     there, the arcs inside it from the kind of rain (drizzle none, rain a few, showers more, a thunderstorm
     all). The mist in the pot is the weather over all of them: settled, a gentle rain; blown about, a storm
     that leans the umbrellas, turns the weak ones inside out and tears some away. Someone who loses theirs
     runs in under the umbrella of a phone that is here (js/lab.js): the only colour on the wall. */
  function umbCam(st, W, H) {
    const ph = 1.02, D = 21, F = W * 1.05, cp = Math.cos(ph), sp = Math.sin(ph), Cy = -D * cp, Cz = D * sp;
    st.P = (X, Y, Z, out) => { const dy = Y - Cy, dz = Z - Cz, zc = dy * cp - dz * sp, yc = dy * sp + dz * cp, k = F / zc; out[0] = W / 2 + X * k; out[1] = H / 2 - yc * k; out[2] = k; return out; };
    st.G = (sx, sy) => { const rx = (sx - W / 2) / F, ry = -(sy - H / 2) / F, dy = cp + ry * sp, dz = -sp + ry * cp, t = -Cz / dz; return [t * rx, Cy + t * dy]; };
  }
  /* the plaza drawn the way the map draws the world: a stipple of the floor (a dot where the slabs meet), the
     puddles as rings of dots like dried raindrops, the trees' crowns as clouds of dots. White on clear, tinted
     to the theme's ink; laid down faintly every frame like the map's ghost. */
  function umbGround(st, W, H, dpr) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), P = st.P, p = [0, 0, 0];
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#fff';
    const dot = (x, y, d, a) => { g.globalAlpha = a; g.fillRect(x - d / 2, y - d / 2, d, d); };
    for (let j = -12; j <= 24; j++) for (let i = -26; i <= 26; i++) {
      P(i * 0.8, j * 0.8 - 2, 0, p); if (p[0] < -4 || p[0] > W + 4 || p[1] < -4 || p[1] > H + 4) continue;
      const major = !(i & 1) && !(j & 1), k = clamp(p[2] / 55, 0.6, 1.5);
      dot(p[0], p[1], (major ? 1.7 : 1.1) * k, major ? 0.9 : 0.4);
    }
    st.puddles = [];
    for (let n = 0; n < 6; n++) {                                // puddles: a dense dotted shoreline, a faint stipple of surface
      const cx = n === 2 ? 3.5 : (hash(n * 7 + 1) - 0.5) * 18, cy = n === 2 ? -1 : -3 + hash(n * 7 + 2) * 10, r = n === 2 ? 1.7 : 0.8 + 1.4 * hash(n * 7 + 3);
      const rr = a => r * (1 + 0.35 * vnoise(Math.cos(a) * 1.5 + n * 3, Math.sin(a) * 1.5));
      st.puddles.push({ cx, cy, r, rr, n });
      for (let q = 0; q < 420 * r; q++) {
        const a = hash(n * 997 + q * 3) * TAU, edge = hash(n * 997 + q * 3 + 1) < 0.75, f = edge ? 0.94 + 0.08 * hash(n * 997 + q * 3 + 2) : Math.sqrt(hash(n * 997 + q * 3 + 2)) * 0.9;
        P(cx + Math.cos(a) * rr(a) * 1.5 * f, cy + Math.sin(a) * rr(a) * f, 0, p);
        dot(p[0], p[1], edge ? 1.5 : 1, edge ? 1 : 0.26);
      }
    }
    for (const t of st.trees) for (let q = 0; q < 900; q++) {   // crowns
      const a = hash(t.sd + q * 3) * TAU, f = Math.pow(hash(t.sd + q * 3 + 1), 0.35), x = t.x + Math.cos(a) * t.r * 0.9 * f, y = t.y + Math.sin(a) * t.r * 0.9 * f;
      dot(x, y, 0.9 + 1.2 * hash(t.sd + q * 3 + 2), 0.25 + 0.5 * f);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-in'; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgb(${PAL.ink})`; g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }
  const NPPL = 28;                                  // the heaviest raining places walk the plaza (sites come sorted by k)
  function umbPeople(st, E, W, H) {
    st.ref = E.sites;
    const old = new Map((st.ppl || []).map(q => [q.id, q])), out = [];
    for (const z of E.sites.slice(0, NPPL)) {
      const R = 0.42 + 0.5 * z.k;
      const [hx, hy] = st.G(W * (0.06 + 0.88 * z.u), H * (0.12 + 0.8 * southOf(z)));
      const q = old.get(z.id) || { id: z.id, x: hx, y: hy, vx: 0, vy: 0, hd: hash(z.id) * TAU, ph: hash(z.id + 1) * 9, tx: 0, ty: 0, tvx: 0, tvy: 0, io: 0, iot: 0, calmT: 0,
                                   sp: 0.5 + 0.45 * hash(z.id + 2), spin: hash(z.id + 3) * TAU, om: 0, o: E.fresh ? 1 : 0, lost: 0, th: 0.5 + 0.4 * hash(z.id + 4), gx: hx, gy: hy, gt: 0 };
      Object.assign(q, { hx, hy, R, kind: kindOf(E, z), k: z.k, u: z.u });
      out.push(q);
    }
    st.ppl = out;
  }
  const umbrellas = {
    name: 'umbrellas', title: 'Umbrellas', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E), dpr = E.dpr;
      if (st.W !== W || st.H !== H || !st.bgN) {
        st.W = W; st.H = H; umbCam(st, W, H);
        st.lamps = [[-7.5, 5.5], [0.5, 5.5], [8, 5.5], [-6, -2.6], [6.5, -2.6]];
        st.bgN = 1; st.gndKey = null;
        const rt = Math.min(W, H) * 0.26;
        st.trees = [[-0.02 * W, 0.18 * H, rt, 11], [1.03 * W, 0.62 * H, rt * 1.15, 47], [0.12 * W, 1.04 * H, rt * 0.9, 83]].map(([x, y, r, sd]) => ({ x, y, r, sd }));
        st.ref = null; st.fly = []; st.ppl = null;
      }
      if (st.ref !== E.sites) umbPeople(st, E, W, H);
      const day = 0, P = st.P, p = [0, 0, 0], q2 = [0, 0, 0], ppl = st.ppl;
      const [fl, fb] = flicker(R, T);
      // ---- the wind: the breath from the side it comes in, gusts in a storm
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, wdx = Math.abs(wx) > 0.12 ? wx : dir * 0.8, wdy = -wy * 0.8;
      const amt = (0.22 + 0.78 * (1 - calm)) * (1 + 1.5 * storm), wet = 1, openT = 1;   // it always rains here: gently when the mist is settled
      // startled by a strike: everybody jumps away from it; taps twirl umbrellas
      const strikes = newBolts(R, st, T);
      const tp = tapsOf(R, E);
      // ---- the phones (js/lab.js): a walker with the only coloured umbrella, a shower where a finger holds, a gust from a flick
      const ix = ixOf(R, E, 'umbrellas'), mine = st.mine || (st.mine = new Map()), shw = st.shw || (st.shw = new Map()), live = new Set();
      for (const ev of ix.live) {
        const [gx, gy] = st.G(clamp(ev.u, 0, 1) * W, clamp(ev.v, 0, 1) * H);
        if (ev.k === 'walk') {
          let q = mine.get(ev.id);
          if (!q && mine.size >= 12) continue;             // a crowd of phones: the first twelve walk, the rest still shower and gust
          if (!q) {
            const col = ixCol(ev); st.nid = (st.nid || 0) + 1;
            q = { id: 9000 + st.nid * 7, ctrl: 1, x: gx, y: gy, vx: 0, vy: 0, hd: 0, ph: 0, tx: 0, ty: 0, tvx: 0, tvy: 0, io: 0, iot: 0, calmT: 0, sp: 1, spin: 0, om: 0, o: 0, lost: 0, th: 0.75,
                  gt: 1e9, gx, gy, hx: gx, hy: gy, R: 0.85, kind: 3, k: 0.6, col, ci: ev.col };
            mine.set(ev.id, q);
          }
          q.gx = gx; q.gy = gy; q.key = ev.id; q.col = ixCol(ev); q.ci = ev.col; live.add(ev.id);
        } else if (ev.k === 'shower') {
          let o = shw.get(ev.id); if (!o) shw.set(ev.id, o = { x: gx, y: gy, a: 0 });
          o.x += (gx - o.x) * 0.3; o.y += (gy - o.y) * 0.3; o.on = T; o.col = ixCol(ev);
        }
      }
      for (const id of [...mine.keys()]) if (!live.has(id)) mine.delete(id);
      for (const [id, o] of shw) { const on = T - o.on < 0.4; o.a += ((on ? 1 : 0) - o.a) * (1 - Math.exp(-dt * (on ? 1.8 : 0.35))); if (!on && o.a < 0.02) shw.delete(id); }
      const gus = st.gus || (st.gus = []);
      for (const ev of ix.fresh) if (ev.k === 'gust') {
        const u = clamp(ev.u, 0, 1) * W, v = clamp(ev.v, 0, 1) * H, [x0, y0] = st.G(u, v), [x1, y1] = st.G(u + (ev.du || 0) * 40, v + (ev.dv || 0) * 40), dl = Math.hypot(x1 - x0, y1 - y0) || 1;
        gus.push({ x0, y0, dx: (x1 - x0) / dl, dy: (y1 - y0) / dl, s: clamp(ev.s || 0.6, 0.2, 1.4), t0: T, col: ixCol(ev) });
      }
      while (gus.length && T - gus[0].t0 > 5) gus.shift();
      const all = mine.size ? ppl.concat([...mine.values()]) : ppl;
      for (const q of all) {
        P(q.x, q.y, 2, p); const sx = p[0], sy = p[1];
        // a shower someone holds over this spot, and a gust's front passing through
        let lwq = 0; for (const o of shw.values()) lwq = Math.max(lwq, o.a * Math.exp(-((q.x - o.x) ** 2 + (q.y - o.y) ** 2) / 7));
        q.lw = lwq;
        let gg = 0, gdx = 0, gdy = 0;
        for (const g of gus) { const ag = T - g.t0, d = (q.x - g.x0) * g.dx + (q.y - g.y0) * g.dy, w = g.s * Math.exp(-(((d - (ag * 8 - 4)) / 2.4) ** 2)) * (1 - smoothstep(3.5, 5, ag)); gg += w; gdx += g.dx * w; gdy += g.dy * w; }
        const gw = Math.min(1, gg), qwx = gg > 0.01 ? lerp(wdx, gdx / gg, gw) : wdx, qwy = gg > 0.01 ? lerp(wdy, gdy / gg, gw) : wdy;
        const held = T - (q.guestT || -9) < 0.6;
        const G = e * (0.3 + 0.7 * Math.exp(-((sx - bxs) ** 2) / (0.2 * W * W))) * (0.85 + 0.15 * Math.sin(T * 7 + q.id)) + storm * (0.5 + 0.5 * vnoise(T * 0.9, q.id * 0.37)) + 0.9 * gg;
        // walking: toward a spot near home, a new one now and then
        if (!q.ctrl && !held && (T > q.gt || Math.hypot(q.gx - q.x, q.gy - q.y) < 0.4)) { q.gt = T + 6 + 8 * rnd(); const a = rnd() * TAU, r = 0.5 + 2.4 * Math.sqrt(rnd()); q.gx = q.hx + Math.cos(a) * r * 1.4; q.gy = q.hy + Math.sin(a) * r; }
        const dx = q.gx - q.x, dy = q.gy - q.y, dd = Math.hypot(dx, dy) + 1e-6, run = q.lost > T ? 2 : 1;
        const spd = q.ctrl ? 2.6 * Math.min(1, dd / 0.7) : q.sp * (0.8 + 0.5 * (1 - calm) + 0.9 * storm) * run * (1 + 0.8 * lwq) * (held ? 1.5 * Math.min(1, dd / 0.5) : 1);
        let ax = dx / dd * spd + qwx * G * 1.6, ay = dy / dd * spd + qwy * G * 1.6;
        if (sx < W * 0.04) ax += 1.5; if (sx > W * 0.96) ax -= 1.5; if (sy < H * 0.08) ay -= 1.5; if (sy > H * 0.96) ay += 1.5;
        for (const b of strikes) { const ux = q.x - ((b.u == null ? 0.5 : b.u) - 0.5) * 16, uy = q.y - 2, ud = Math.hypot(ux, uy) + 0.5; q.vx += ux / ud * 3.5 * (b.power || 0.6); q.vy += uy / ud * 3.5 * (b.power || 0.6); q.om += (rnd() - 0.5) * 14; q.tvx += (rnd() - 0.5) * 3; q.tvy += (rnd() - 0.5) * 3; }
        const kv = 1 - Math.exp(-dt * 2.5); q.vx += (ax - q.vx) * kv; q.vy += (ay - q.vy) * kv;
        q.x += q.vx * dt; q.y += q.vy * dt;
        const vm = Math.hypot(q.vx, q.vy);
        if (vm > 0.05) { let dh = Math.atan2(q.vy, q.vx) - q.hd; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); q.hd += dh * Math.min(1, dt * 4); }
        q.ph += dt * vm * 5;
        // the umbrella leans with the wind (a spring), and may blow inside out
        const lean = 0.95 * G * (1.25 - 0.35 * q.R);
        q.tvx += ((qwx * lean + 0.03 * Math.sin(q.ph) - q.tx) * 34 - q.tvx * 6) * dt; q.tvy += ((qwy * lean + 0.03 * Math.cos(q.ph * 0.5) - q.ty) * 34 - q.tvy * 6) * dt;
        q.tx = clamp(q.tx + q.tvx * dt, -0.9, 0.9); q.ty = clamp(q.ty + q.tvy * dt, -0.9, 0.9);
        if (G > q.th + 0.12 * (q.R - 0.5) && q.o > 0.5) { if (!q.iot) { q.om += (rnd() - 0.5) * 16; q.tvx += qwx * 4; q.tvy += qwy * 4; } q.iot = 1; q.calmT = T; }   // pop!
        else if (G < q.th * 0.45 && T - q.calmT > 1.4) q.iot = 0;
        q.io += (q.iot - q.io) * (1 - Math.exp(-dt * (q.iot > q.io ? 16 : 2.4)));
        // a storm tears a few out of people's hands
        if (storm > 0.3 && q.io > 0.9 && q.lost < T && st.fly.length < 3 && rnd() < dt * storm * 0.05) {
          q.lost = T + 9 + 6 * rnd(); q.o = 0; note(R, { kind: 'lost', site: q.id, u: sx / W });
          st.fly.push({ x: q.x, y: q.y, z: 2.2, vx: wdx * 5, vy: wdy * 5, vz: 2.5, cols: q.cols, rim: q.rim, R: q.R, spin: q.spin, om: 9 * (rnd() < 0.5 ? -1 : 1), tx: wdx * 0.6, ty: 0.5, t: T });
        } else if (!q.ctrl && gg > 0.5 && q.io > 0.8 && q.lost < T && st.fly.length < 10 && rnd() < dt * gg * 1.2) {   // ... and so does a strong gust
          q.lost = T + 12 + 6 * rnd(); q.o = 0; note(R, { kind: 'lost', site: q.id, u: sx / W });
          st.fly.push({ x: q.x, y: q.y, z: 2.2, vx: qwx * 6, vy: qwy * 6, vz: 2.5, wx: qwx, wy: qwy, cols: q.cols, rim: q.rim, R: q.R, spin: q.spin, om: 9 * (rnd() < 0.5 ? -1 : 1), tx: qwx * 0.6, ty: 0.5, t: T });
        }
        const ot = q.ctrl ? 1 : q.lost > T ? 0 : 1;
        q.o += (ot - q.o) * (1 - Math.exp(-dt * (ot > q.o ? 2.6 : 1.5)));           // calm: fold, then fade away; rain: fade in folded, then unfold
        // twirls
        for (const t of tp.fresh) {
          if (t.site === q.id) q.om += t.echo ? 2.6 : 11 * (hash(t.seed) < 0.5 ? -1 : 1);
          else if (!t.echo && t.site == null) { const [gx, gy] = st.G(t.x, t.y), d = Math.hypot(gx - q.x, gy - q.y); if (d < 3) { q.om += (3 - d) * 3; q.vx += (q.x - gx) / (d + 0.3) * 1.5; q.vy += (q.y - gy) / (d + 0.3) * 1.5; } }
        }
        q.om *= Math.exp(-dt * 0.7); q.om += (rnd() - 0.5) * storm * 30 * dt; q.spin += q.om * dt;
      }
      // sharing. Someone whose umbrella the wind took runs in under the nearest phone's umbrella in reach (up to
      // four under each) and walks along with it; after a while, or if that phone goes, they step out and open
      // their own again. The wall is told (a place name, a note in the phone's colour) when someone finds shelter.
      for (const m of mine.values()) m.ng = 0;
      const hostOk = m => mine.get(m.key) === m && m.o > 0.5;
      for (const q of ppl) {
        if (q.host && (!hostOk(q.host) || T - q.hostT > 24)) { q.host = null; q.lost = Math.min(q.lost, T + 1.2); }
        if (q.host) q.host.ng++;
      }
      for (const q of ppl) if (!q.host && q.lost > T + 1.5) {
        let best = null, bd = 7;
        for (const m of mine.values()) { const d = Math.hypot(m.x - q.x, m.y - q.y); if (hostOk(m) && m.ng < 4 && d < bd) { bd = d; best = m; } }
        if (best) { q.host = best; q.hostT = T; best.ng++; best.sl = (best.sl || 0) + 1; q.slot = best.sl; P(best.x, best.y, 2, p); note(R, { kind: 'shelter', site: q.id, c: best.ci, u: p[0] / W }); }
      }
      for (const q of ppl) if (q.host) {
        const m = q.host, a = q.slot * 2.4 + 0.7, r = 0.42 + 0.06 * (q.slot % 2);
        q.gx = m.x + Math.cos(a) * r; q.gy = m.y + Math.sin(a) * r * 0.8; q.gt = T + 3; q.guestT = T; q.lost = Math.max(q.lost, T + 2);
      }
      for (const m of mine.values()) m.sh = (m.sh || 0) + (Math.min(3, m.ng) - (m.sh || 0)) * (1 - Math.exp(-dt * 3));   // the umbrella opens wider for them
      const close = (A, B) => (A.host && (A.host === B || A.host === B.host)) || (B.host && B.host === A);
      // keep a little room between people
      for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
        const A = all[i], B = all[j]; if (close(A, B)) continue;
        const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) + 1e-6, m = (A.R + B.R) * 0.85 - d;
        if (m > 0) { const f = m * 2.5 * dt / d; A.x -= dx * f; A.y -= dy * f; B.x += dx * f; B.y += dy * f; }
      }
      // ---- draw, in the plumes' manner: light on black (ink on paper in the light theme), everything made of
      // flowing dots and fine lines, with a soft trail as things move. Colour only for what the phones do.
      const ink = PAL.ink, spr = sparkSprite(), ds = E.s || 1;
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.lineCap = 'round'; c.lineJoin = 'round'; c.setLineDash([]);
      c.fillStyle = `rgba(${PAL.bg},${E.fresh ? 1 : PAL.fade})`; c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = PAL.comp;
      const gk = W + ':' + H + ':' + INK;
      if (st.gndKey !== gk) { st.gnd = umbGround(st, W, H, dpr); st.gndKey = gk; }
      c.globalAlpha = E.fresh ? 0.3 : 0.07; c.drawImage(st.gnd, 0, 0, W, H); c.globalAlpha = 1;
      if (fl > 0.02) { c.fillStyle = `rgba(${ink},${(0.1 * fl).toFixed(3)})`; c.fillRect(0, 0, W, H); }
      const fib = [0, 1, 2, 3].map(() => new Path2D()), dts = [0, 1, 2, 3].map(() => new Path2D()), silk = new Path2D(), sparks = [];
      const lev = (arr, al) => arr[Math.min(3, Math.max(0, Math.floor(al * 4)))];
      const dot = (pp, x, y, d) => pp.rect(x - d / 2, y - d / 2, d, d);
      const cp = new Map(), CP = col => { const k = col.join(','); let o = cp.get(k); if (!o) cp.set(k, o = { fib: new Path2D(), body: new Path2D(), lines: new Path2D(), dots: new Path2D(), glow: [] }); return o; };
      const off = (x, y) => x < -30 || x > W + 30 || y < -30 || y > H + 30;
      // splashes: a ring of dots opening on the stone (in a phone's colour where its shower falls)
      const nsp = Math.round((6 + 60 * amt) * W / 1600);
      for (let i = 0; i < nsp; i++) {
        const ph = T / 0.4 + hash(i * 7 + 3), cyc = Math.floor(ph), f = ph - cyc, sd = i * 131 + cyc * 7919;
        P((hash(sd) - 0.5) * 26, -6 + hash(sd + 1) * 16, 0, p); if (off(p[0], p[1])) continue;
        const r = (0.04 + 0.22 * f) * p[2], pp = lev(dts, 0.5 * (1 - f));
        for (let m = 0; m < 5; m++) { const a = hash(sd + m * 5) * TAU; dot(pp, p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r * 0.82, lw * 1.1); }
      }
      for (const o of shw.values()) {
        const C = CP(o.col);
        for (let i = 0, n = Math.round(26 * o.a); i < n; i++) {
          const ph = T / 0.35 + hash(i * 5 + 1), cyc = Math.floor(ph), f = ph - cyc, sd = i * 977 + cyc * 7919, a = hash(sd) * TAU, r = 2.6 * Math.sqrt(hash(sd + 1));
          P(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r * 0.8, 0, p); const rr = (0.04 + 0.22 * f) * p[2];
          for (let m = 0; m < 6; m++) { const b = hash(sd + m * 5) * TAU; dot(C.dots, p[0] + Math.cos(b) * rr, p[1] + Math.sin(b) * rr * 0.82, lw * 1.2); }
        }
        P(o.x, o.y, 0, p); C.fib.moveTo(p[0] + 2.8 * p[2], p[1]); C.fib.ellipse(p[0], p[1], 2.8 * p[2], 2.2 * p[2], 0, 0, TAU);   // where it falls
      }
      // the puddles are water: a faint sheen, and the rain's rings widening on them
      for (const pd of st.puddles) {
        const sh = new Path2D();
        for (let i = 0; i <= 28; i++) { const a = i / 28 * TAU, rr = pd.rr(a); P(pd.cx + Math.cos(a) * rr * 1.5, pd.cy + Math.sin(a) * rr, 0, p); i ? sh.lineTo(p[0], p[1]) : sh.moveTo(p[0], p[1]); }
        sh.closePath(); c.fillStyle = `rgba(${ink},0.009)`; c.fill(sh);
        const nr = Math.round((3 + 9 * amt) * pd.r);
        for (let i = 0; i < nr; i++) {
          const ph = T / 1.6 + hash(pd.n * 53 + i * 7), cyc = Math.floor(ph), f = ph - cyc, sd = pd.n * 7919 + i * 131 + cyc * 977;
          const a = hash(sd) * TAU, d = Math.sqrt(hash(sd + 1)) * 0.85, rr = pd.rr(a);
          P(pd.cx + Math.cos(a) * rr * 1.5 * d, pd.cy + Math.sin(a) * rr * d, 0, p);
          const R0 = (0.06 + 0.55 * f) * p[2] * pd.r * 0.6, pp = lev(dts, 0.55 * (1 - f) * (1 - f));
          for (let m = 0, nm = 6 + Math.round(R0 / 3); m < nm; m++) { const b = m / nm * TAU + hash(sd + 9) * TAU; dot(pp, p[0] + Math.cos(b) * R0, p[1] + Math.sin(b) * R0 * 0.8, lw * 1.05); }
        }
      }
      // the lamps glow at night
      if (day < 0.98) for (const [x, y] of st.lamps) { P(x, y, 5.2, p); sparks.push([p[0], p[1], 0.3 * (1 - day), 0.7 * p[2]]); }
      // ---- each person: the canopy's points in space (tilted with the wind, inside out if it blew)
      const geo = (q, x, y, zh, ox) => {                        // -> {apex, tips, mids} as [X, Y, Z]
        const o = ox == null ? q.o : ox, io = q.io, R = q.R * (0.14 + 0.86 * o) * (1 + 0.22 * io) * (1 + 0.22 * (q.sh || 0)), zr = 2.05 - (1 - o) * 0.75 * q.R + 0.03 * Math.sin(q.ph * 2);
        const za = zr + q.R * 0.42 * o * (1 - 2 * io), tw = (pt) => { const dz = pt[2] - zh; pt[0] += q.tx * dz; pt[1] += q.ty * dz; pt[2] -= 0.5 * (q.tx * q.tx + q.ty * q.ty) * dz; return pt; };
        const apex = tw([x, y, za]), tips = [], mids = [];
        for (let i = 0; i < 8; i++) {
          const a = q.spin + i * TAU / 8, a2 = a + TAU / 16, j = io * (hash(q.id * 9 + i) - 0.5);
          tips.push(tw([x + Math.cos(a + 0.25 * j) * R * (1 + 0.45 * j), y + Math.sin(a + 0.25 * j) * R * (1 + 0.45 * j), zr - 0.06 * q.R + io * 0.3 * q.R * hash(q.id * 7 + i)]));
          mids.push(tw([x + Math.cos(a2) * R * 0.86, y + Math.sin(a2) * R * 0.86, zr + 0.02 * q.R + io * 0.1 * q.R]));
        }
        return { apex, tips, mids };
      };
      const list = all.map(q => { const r = q.host || q; P(r.x, r.y, 2, p); return [p[1] - (r !== q ? 0.5 : 0), q]; }).sort((a, b) => a[0] - b[0]).map(a => a[1]);
      // a canopy as a little plume: ribs of dots running down from the top, a dotted rim, and inner arcs on the
      // panels the kind of rain fills (drizzle none, rain every other, showers two quarters, thunderstorm all)
      const PAT = [0, 0b01010101, 0b00110011, 255];
      const canopy = (q, gq, out, body) => {
        const A = P(gq.apex[0], gq.apex[1], gq.apex[2], [0, 0, 0]), tp = gq.tips.map(t => P(t[0], t[1], t[2], [0, 0, 0])), md = gq.mids.map(t => P(t[0], t[1], t[2], [0, 0, 0]));
        for (let i = 0; i < 8; i++) { out.moveTo(A[0], A[1]); out.lineTo(tp[i][0], tp[i][1]); }
        const rim = pp => { pp.moveTo(tp[0][0], tp[0][1]); for (let i = 0; i < 8; i++) pp.quadraticCurveTo(md[i][0], md[i][1], tp[(i + 1) % 8][0], tp[(i + 1) % 8][1]); };
        rim(out); rim(body || silk);
        const pat = PAT[q.kind] || 0, inner = body || silk;   // the kind of rain, as faint arcs inside
        for (let i = 0; i < 8; i++) if (pat >> i & 1) {
          const t0 = tp[i], t1 = tp[(i + 1) % 8], m = md[i], f = 0.62;
          inner.moveTo(A[0] + (t0[0] - A[0]) * f, A[1] + (t0[1] - A[1]) * f);
          inner.quadraticCurveTo(A[0] + (m[0] - A[0]) * f, A[1] + (m[1] - A[1]) * f, A[0] + (t1[0] - A[0]) * f, A[1] + (t1[1] - A[1]) * f);
        }
        return { A, tp };
      };
      const aw0 = amt * wet;
      for (const q of list) {
        const C = q.ctrl ? CP(q.col) : null;
        // the person: a dotted head and shoulders, seen as the umbrella fades; under a phone's umbrella, in its colour
        const vis = 1 - smoothstep(0.15, 0.6, q.o);
        if (vis > 0.01) {
          const out = C ? C.fib : q.host ? CP(q.host.col).lines : lev(fib, 0.75 * vis);
          P(q.x, q.y, 1.45, p); const k = p[2];
          out.moveTo(p[0] + 0.3 * k, p[1]); out.ellipse(p[0], p[1], 0.3 * k, 0.15 * k, q.hd + Math.PI / 2, 0, TAU);
          P(q.x + Math.cos(q.hd) * 0.04, q.y + Math.sin(q.hd) * 0.04, 1.7, q2); out.moveTo(q2[0] + 0.12 * q2[2], q2[1]); out.arc(q2[0], q2[1], 0.12 * q2[2], 0, TAU);
        }
        if (C) { P(q.x, q.y, 1.45, p); const g0 = st.G(p[0], p[1]); P(g0[0], g0[1], 0, p); const rr = 1.1 * p[2] * (1 + 0.22 * (q.sh || 0));   // your ring on the ground
          C.fib.moveTo(p[0] + rr, p[1]); C.fib.ellipse(p[0], p[1], rr, rr * 0.8, 0, 0, TAU); }
        if (q.o > 0.02) {
          const al = smoothstep(0.02, 0.4, q.o), gq = geo(q, q.x, q.y, 1.1);
          const { A, tp } = canopy(q, gq, C ? C.fib : lev(fib, al * (0.3 + 0.7 * q.k)), C ? C.body : null);
          if (C) C.glow.push([A[0], A[1], 0.6 * al, 1.6 * A[2] * q.R]); else sparks.push([A[0], A[1], al * (0.08 + 0.3 * q.k), 0.34 * A[2] * q.R]);
          const aw = Math.max(aw0, (q.lw || 0) * 1.3);          // rain landing on it: a few bright drops
          if (aw > 0.02 && al > 0.5) for (let n = 0, m = Math.round(aw * (1.5 + 2 * q.k)); n < m; n++) {
            const i = Math.floor(rnd() * 8), f = rnd() * 0.85; dot(dts[3], A[0] + (tp[i][0] - A[0]) * f, A[1] + (tp[i][1] - A[1]) * f, lw * 1.3);
          }
        }
      }
      // umbrellas the wind tore away, tumbling off downwind
      st.fly = st.fly.filter(f => {
        f.vx += ((f.wx == null ? wdx : f.wx) * 7 - f.vx) * dt * 0.8; f.vy += ((f.wy == null ? wdy : f.wy) * 7 - f.vy) * dt * 0.8; f.vz += (-1.2 + 2 * Math.sin(T * 3 + f.t)) * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z = Math.max(0.6, f.z + f.vz * dt); f.spin += f.om * dt; f.tx = 0.8 * Math.sin(T * 2.3 + f.t); f.ty = 0.8 * Math.cos(T * 1.9 + f.t);
        const q = { id: 999, R: f.R, o: 1, io: 0.6 + 0.4 * Math.sin(T * 4 + f.t), tx: f.tx, ty: f.ty, spin: f.spin, ph: 0, kind: 1, k: 0 };
        canopy(q, geo(q, f.x, f.y, f.z - 1), fib[2]);
        P(f.x, f.y, f.z, p); return p[0] > -200 && p[0] < W + 200 && p[1] > -200 && p[1] < H + 200 && T - f.t < 12;
      });
      // ---- the rain itself, falling past the window (a phone's shower in its colour)
      const rain = new Path2D(), nr = Math.round((40 + 700 * amt) * wet * W / 1600 * (0.4 + 0.6 * (E.pts.length ? 1 : 0.6)));
      const slx = wdx * (0.25 + 1.2 * e + 0.8 * storm), sly = wdy * (0.25 + 1.2 * e + 0.8 * storm);
      for (let i = 0; i < nr; i++) {
        const z = 9 - ((T * 9 + hash(i * 3 + 3) * 9) % 9), X = (hash(i * 3 + 1) - 0.5) * 30 + slx * (9 - z) * 0.3, Y = -6 + hash(i * 3 + 2) * 18 + sly * (9 - z) * 0.3;
        P(X, Y, z, p); P(X - slx * 0.12, Y - sly * 0.12, z + 0.55, q2);
        if (off(p[0], p[1])) continue;
        rain.moveTo(q2[0], q2[1]); rain.lineTo(p[0], p[1]);
      }
      for (const o of shw.values()) {
        const C = CP(o.col);
        for (let i = 0, n = Math.round(140 * o.a); i < n; i++) {
          const z = 7 - ((T * 9 + hash(i * 3 + 101) * 7) % 7), a = hash(i * 3 + 102) * TAU, r = 2.6 * Math.sqrt(hash(i * 3 + 103)), X = o.x + Math.cos(a) * r, Y = o.y + Math.sin(a) * r * 0.8;
          P(X, Y, z, p); P(X, Y, z + 0.55, q2); if (off(p[0], p[1])) continue; C.lines.moveTo(q2[0], q2[1]); C.lines.lineTo(p[0], p[1]);
        }
      }
      for (const g of gus) {                                     // a gust: dotted streaks sweeping across, in the colour of the phone that sent it
        const ag = T - g.t0, f = ag * 8 - 4, al = Math.min(1, ag * 3) * (1 - smoothstep(3, 4.5, ag)) * Math.min(1, g.s);
        if (al < 0.05) continue;
        const C = CP(g.col);
        for (let j = -16; j <= 16; j++) {
          const o2 = j * 0.9 + (hash(j + 40) - 0.5) * 0.8, fj = f + (hash(j + 60) - 0.5) * 2.5, ln = (2 + 2 * hash(j + 80)) * al, fx = g.x0 + g.dx * fj - g.dy * o2, fy = g.y0 + g.dy * fj + g.dx * o2;
          P(fx - g.dx * ln, fy - g.dy * ln, 2.6, q2); P(fx, fy, 2.6, p); C.fib.moveTo(q2[0], q2[1]); C.fib.lineTo(p[0], p[1]);
        }
      }
      // ---- now lay it all down: faint silk under the rims, the dotted filaments (the dots flow, as in the plumes),
      // sparks and drops, the falling streaks; then the phones' own, in colour
      const flow = -T * (16 + 40 * storm) * ds;
      c.strokeStyle = `rgba(${ink},0.07)`; c.lineWidth = lw * 0.6; c.stroke(silk);
      c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow; c.lineWidth = lw * 1.05;
      fib.forEach((pp, i) => { c.strokeStyle = `rgba(${ink},${(0.14 + 0.2 * i).toFixed(2)})`; c.stroke(pp); });
      c.setLineDash([]); c.lineDashOffset = 0;
      dts.forEach((pp, i) => { c.fillStyle = `rgba(${ink},${(0.16 + 0.2 * i).toFixed(2)})`; c.fill(pp); });
      c.strokeStyle = `rgba(${ink},${(0.1 + 0.08 * storm).toFixed(3)})`; c.lineWidth = lw * 0.7; c.stroke(rain);
      for (const [x, y, al, z] of sparks) { c.globalAlpha = Math.min(1, al); c.drawImage(spr, x - z / 2, y - z / 2, z, z); }
      c.globalAlpha = 1;
      for (const [k, o] of cp) {
        c.fillStyle = `rgba(${k},0.1)`; c.fill(o.body);
        c.strokeStyle = `rgba(${k},0.3)`; c.lineWidth = lw * 0.6; c.stroke(o.body);
        c.strokeStyle = `rgba(${k},0.6)`; c.lineWidth = lw * 0.9; c.stroke(o.lines);
        c.fillStyle = `rgba(${k},0.9)`; c.fill(o.dots);
        c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow; c.strokeStyle = `rgba(${k},0.95)`; c.lineWidth = lw * 1.4; c.stroke(o.fib); c.setLineDash([]); c.lineDashOffset = 0;
        const gl = glow(k, 64, 0.3);
        for (const [x, y, al, z] of o.glow) { c.globalAlpha = al; c.drawImage(gl, x - z / 2, y - z / 2, z, z); }
        c.globalAlpha = 1;
      }
      c.globalCompositeOperation = 'source-over';
    },
  };

  return [umbrellas];
})();
