/* Connect the Rain — art modes for the wall. No map, no words: each mode paints the same live data
 * (where it is raining right now, and the mist weather from the webcam) as a different picture.
 * RainRenderer._drawArt (common.js) picks a mode and calls draw(R, c, E) with
 *   T, dt        shared time in s, seconds since the last frame (0..0.1)
 *   W, H, s, lw  screen size in CSS px, world->screen scale, base line width; dpr
 *   sites        raining places [{id, u, v, k}]  u = (lon+180)/360, v = (90-lat)/180, k = rain strength 0.12..1
 *   pts          all sample points [lat, lon, mm, code] (mm / code can be null); site.id = 5000 + its index here
 *   storm, pres  storm 0..1; how much rain shows 0..1 (low = calm: the mist has settled)
 *   mist, e      mist weather 0..1 (0 calm, ~0.3 still mist, >0.6 storm); how hard the mist moves right now 0..1
 *   mx, my       where in the pot the mist moves, -1..1: a breath from the left of the pot pushes things right
 *   light        light theme; fresh: first frame (clear everything); st: this mode's own state (reset on a switch)
 * then draws the taps from phones and the lightning on top (a mode with bolts: false draws its own).
 * Modes 2-5 also act on the taps themselves: tapsOf(R, E) turns R.ripples into screen points (and the
 * raining place tapped, if any; echo: the wall's own soft notes), newBolts(R, st, T) gives fresh strikes.
 * Modes marked dark: true keep their own palette in either theme. Canvas 2D only; static things are
 * prerendered once to offscreen canvases, strokes are batched into a few paths per frame. */
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
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
    return f(0) + ',' + f(8) + ',' + f(4);
  }
  const mix = (a, b, t) => [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];

  /* every sample point as {lat, lon, mm, code, rain, k, id}, worked out once per snapshot;
     before the first snapshot only the raining places are known */
  const _pts = new WeakMap();
  function points(E) {
    const src = E.pts && E.pts.length ? E.pts : E.sites;
    let out = _pts.get(src);
    if (out) return out;
    out = src === E.pts
      ? E.pts.map((p, i) => { const [lat, lon, mm, code] = p, rain = isRaining(mm, code); return { lat, lon, mm, code, rain, k: rain ? rainStrength(mm, code) : 0, id: 5000 + i }; })
      : E.sites.map(z => ({ lat: 90 - z.v * 180, lon: z.u * 360 - 180, mm: null, code: null, rain: true, k: z.k, id: z.id }));
    _pts.set(src, out);
    return out;
  }
  const codeOf = (E, z) => { const p = E.pts[z.id - 5000]; return p && p[3] != null ? p[3] : null; };
  /* the colour of a latitude as [h, s, l]: warm coral and orange in the tropics, teal and green in the middle
     latitudes, icy lavender near the poles */
  function latColor(lat) {
    const a = Math.abs(lat);
    const S = [[0, 12, 86, 63], [16, 22, 92, 61], [24, 40, 92, 58], [31, 96, 52, 50], [41, 166, 58, 45], [52, 190, 58, 52], [61, 250, 55, 72], [90, 268, 45, 84]];
    for (let i = 1; i < S.length; i++) if (a <= S[i][0]) {
      const p = S[i - 1], q = S[i], t = (a - p[0]) / (q[0] - p[0]);
      return [lerp(p[1], q[1], t), lerp(p[2], q[2], t), lerp(p[3], q[3], t)];
    }
    return S[S.length - 1].slice(1);
  }

  /* ================================================================ shared by the modes: the rain itself
     Shared by them: the kind of rain at a place (from its WMO code), the daylight easing in for the calm
     (light) theme, the lightning flicker, and the taps from phones as points on the screen. */
  const rainKind = code => code == null ? 1 : code >= 95 ? 3 : code >= 80 ? 2 : code >= 61 ? 1 : code >= 51 ? 0 : 1;   // 0 drizzle, 1 rain, 2 showers, 3 thunderstorm
  const kindOf = (E, z) => rainKind(codeOf(E, z));
  const latOf = z => 90 - z.v * 180;
  const southOf = z => clamp((80 - latOf(z)) / 140, 0, 1);            // 0 = 80N (top / far) .. 1 = 60S (bottom / near)
  const dayOf = (st, E) => (st.day = st.day == null ? (E.light ? 1 : 0) : st.day + ((E.light ? 1 : 0) - st.day) * (1 - Math.exp(-E.dt / 1.4)));
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
  /* a cross-fade of two prerendered pictures of the same size, kept while it holds still (one blit a frame, not two) */
  function fade2(st, key, A, B, t) {
    if (t < 0.004) return A; if (t > 0.996) return B;
    let f = st[key];
    if (!f || f.cv.width !== A.width || f.cv.height !== A.height) f = st[key] = { cv: canvas(A.width, A.height), t: -1 };
    if (Math.abs(f.t - t) > 0.02) { const g = f.cv.getContext('2d'); g.clearRect(0, 0, A.width, A.height); g.globalAlpha = 1; g.drawImage(A, 0, 0); g.globalAlpha = t; g.drawImage(B, 0, 0); g.globalAlpha = 1; f.t = t; }
    return f.cv;
  }

  /* ============================================================== 1  Murmuration
     A murmuration of starlings over a gold-leaf folding screen. Every raining place leads a patch of the
     flock (bigger where it rains harder), and the patches hold a formation set by where the places are
     (east to west along the flock, north to south across it): one thin sheet of birds that turns in space,
     a wide haze face-on and a dark band edge-on, folding and pulsing with waves of density. A breath is a hawk: the birds burst away from where it comes in,
     leaving a hole, and the flock flees to the other side. In a storm two falcons hunt through it and the
     flock tears into ragged pieces; a lightning strike startles every bird at once and the gold flares.
     Calm, the flock draws together and drifts slowly. */
  function murmSetup(st, W, H, dpr) {
    st.W = W; st.H = H;
    const bg = st.bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, W * 0.7, H);
    gr.addColorStop(0, '#d8b45c'); gr.addColorStop(0.5, '#c39b44'); gr.addColorStop(1, '#9c7630');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    gr = g.createLinearGradient(0, H * 0.1, W, H * 0.7);                 // a broad sheen across the leaf
    gr.addColorStop(0, 'rgba(255,240,190,0)'); gr.addColorStop(0.45, 'rgba(255,240,190,0.22)'); gr.addColorStop(0.6, 'rgba(255,240,190,0.05)'); gr.addColorStop(1, 'rgba(255,240,190,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // gold leaf: squares laid by hand, each catching the light a little differently, with faint seams
    const q = Math.round(H / 6.5);
    for (let j = 0, y = 0; y < H; y += q, j++) for (let i = 0, x = -hash(j * 7 + 1) * q; x < W; x += q, i++) {
      const h = hash(i * 131 + j * 977 + 5), xo = (hash(i * 31 + j * 7) - 0.5) * 3, yo = (hash(i * 7 + j * 31) - 0.5) * 3;
      g.fillStyle = h < 0.5 ? `rgba(255,236,180,${0.025 * h})` : `rgba(110,74,16,${0.03 * (h - 0.5)})`;
      g.fillRect(x + xo, y + yo, q, q);
      g.strokeStyle = h < 0.5 ? 'rgba(255,238,190,0.08)' : 'rgba(110,76,20,0.08)'; g.lineWidth = 1; g.strokeRect(x + xo + 0.5, y + yo + 0.5, q, q);
    }
    for (let i = 0; i < 16000; i++) { const h = hash(i * 3 + 1); g.fillStyle = h < 0.5 ? `rgba(255,246,210,${0.06 * h})` : `rgba(80,50,10,${0.05 * (h - 0.5)})`; g.fillRect(hash(i * 3 + 2) * W, hash(i * 3 + 3) * H, 1, 1); }
    // the folding screen: six panels, turned alternately toward the light and away from it
    const np = 6, pw = W / np;
    for (let i = 0; i < np; i++) {
      gr = g.createLinearGradient(i * pw, 0, (i + 1) * pw, 0);
      if (i % 2 === 0) { gr.addColorStop(0, 'rgba(255,244,200,0.1)'); gr.addColorStop(1, 'rgba(255,244,200,0.0)'); }
      else { gr.addColorStop(0, 'rgba(70,42,6,0.1)'); gr.addColorStop(1, 'rgba(70,42,6,0.02)'); }
      g.fillStyle = gr; g.fillRect(i * pw, 0, pw, H);
      if (i) { g.fillStyle = 'rgba(80,52,14,0.28)'; g.fillRect(i * pw - 0.5, 0, 1, H); }
    }
    gr = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.4, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    gr.addColorStop(0, 'rgba(40,24,4,0)'); gr.addColorStop(1, 'rgba(40,24,4,0.4)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
  }
  /* the flock: each raining place leads a patch of a thin, folded sheet of birds (its place in the sheet
     from where it is on Earth, its size from how hard it rains there) */
  function murmFlock(st, E, W, H) {
    st.ref = E.sites;
    const src = E.sites.length ? E.sites : [{ id: 1, u: 0.5, v: 0.45, k: 0.5 }];
    const lead = src.map(z => {
      const lat = 90 - z.v * 180;
      return { a: (z.u - 0.5) * 0.5 * W, b: (clamp((80 - lat) / 140, 0, 1) - 0.45) * 0.36 * W, r: (0.045 + 0.065 * z.k) * W, k: z.k, w: hash(z.id * 3 + 2) * TAU,
               n: E.sites.length ? 20 + 70 * z.k : 600 };
    });
    const tot = lead.reduce((a, l) => a + l.n, 0), f = tot > 2600 ? 2600 / tot : 1;
    let N = 0; for (const l of lead) { l.n = Math.max(8, Math.round(l.n * f)); N += l.n; }
    const old = st.P, oldN = st.N || 0;
    const P = new Float32Array(N * 3), V = new Float32Array(N * 3), O = new Float32Array(N * 3), Ld = new Uint16Array(N), F = new Float32Array(N), Z = new Float32Array(N);
    let b = 0;
    lead.forEach((l, li) => {
      for (let n = 0; n < l.n; n++, b++) {
        const a = rnd() * TAU, rr = Math.sqrt(rnd());
        O[b * 3] = Math.cos(a) * rr; O[b * 3 + 1] = (rnd() - 0.5) * 0.28; O[b * 3 + 2] = Math.sin(a) * rr;
        Ld[b] = li; F[b] = rnd() * TAU; Z[b] = 0.75 + 0.5 * rnd();
      }
    });
    if (old) for (let i = 0; i < Math.min(oldN, N) * 3; i++) { P[i] = old[i]; V[i] = st.V[i]; }
    Object.assign(st, { lead, N, P, V, O, Ld, F, Z, init: old ? Math.min(oldN, N) : 0 });
  }
  const murm = {
    name: 'murmuration', title: 'Murmuration', bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E), sc = W / 1600;
      if (st.W !== W || st.H !== H || !st.bg) { murmSetup(st, W, H, E.dpr); st.ref = null; st.P = null; st.N = 0; }
      if (st.ref !== E.sites) murmFlock(st, E, W, H);
      const { lead, N, P, V, O, Ld, F, Z } = st;
      // the flock's heart drifts about; the breath drives it off to the other side
      const kp = 1 - Math.exp(-dt * (e > 0.1 ? 3 : 0.4));
      st.fx = (st.fx || 0) + (wx * e * 0.22 * W - (st.fx || 0)) * kp; st.fy = (st.fy || 0) + (wy * e * 0.16 * H - (st.fy || 0)) * kp;
      // ... and the edges of the screen turn it back (from how far it reached last frame)
      const ex = st.ext || [0, 0, 0, 0], kx = (1 - Math.exp(-dt * 0.6)) * (1 - smoothstep(0.15, 0.5, e));   // (a breath wins)
      st.bx_ = (st.bx_ || 0) + (Math.max(0, -0.44 * W - ex[0]) - Math.max(0, ex[1] - 0.44 * W) - (st.bx_ || 0) * 0.15) * kx;
      st.by_ = (st.by_ || 0) + (Math.max(0, -0.42 * H - ex[2]) - Math.max(0, ex[3] - 0.42 * H) - (st.by_ || 0) * 0.15) * kx;
      const Cx = 0.12 * W * Math.sin(T * 0.071) + st.fx + st.bx_, Cy = 0.05 * H * Math.sin(T * 0.113 + 1) + st.fy + st.by_, Cz = 0.12 * W * Math.sin(T * 0.053);
      // the sheet turns in space (seen flat it is a wide haze, edge-on a dark band), folds, and waves run through it
      const yaw = T * 0.06 + 0.5 * Math.sin(T * 0.031), tilt = 0.75 + 0.6 * Math.sin(T * 0.043), roll = 0.3 * Math.sin(T * 0.057);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), ct = Math.cos(tilt), stl = Math.sin(tilt), cr = Math.cos(roll), sr = Math.sin(roll);
      const fold = (0.5 * Math.sin(T * 0.11) + 0.25 * storm * Math.sin(T * 1.3)) / (0.5 * W), wph = T * (1.4 + 3 * storm + 1.5 * e), wk = 7 / W;
      const spread = 0.62 + 0.18 * (1 - calm) + 0.5 * storm + 0.25 * e;
      const K = 1.3 + 1.4 * (1 - calm) + 4 * storm + 2.5 * e, Cd = 1.6 + 1.2 * storm;
      // the hawk (the breath) and, in a storm, two falcons
      const hawks = [];
      if (e > 0.02) hawks.push([lerp(Cx, 0.44 * clamp(E.mx, -1, 1) * W, 0.4), lerp(Cy, 0.4 * clamp(E.my, -1, 1) * H, 0.4), Cz * 0.5, (0.13 + 0.12 * e) * W, e * 3600 * sc]);
      // falcons: they don't blink on and off with the storm level; each storm they fly in from a new place
      // beyond the edge of the screen (any side or corner, the two from different directions) over ~2 s, hunt,
      // and when the storm passes they leave by another way
      const fon0 = st.fon || 0;
      if (storm > 0.2) st.fon = 1; else if (storm < 0.05) st.fon = 0;               // hysteresis
      if (st.fon && !fon0) {                                                          // a storm begins
        if ((st.fal || 0) > 0.04 && st.fout) st.fin = st.fout.slice();                // (they were still in sight, leaving: turn back from there)
        else { const a = Math.random() * TAU; st.fin = [a, a + 1.6 + Math.random() * 2.2]; }
      }
      if (!st.fon && fon0 && st.fin) st.fout = st.fin.map(a => a + Math.PI + (Math.random() - 0.5) * 2.2);   // leave another way
      st.fal = (st.fal || 0) + ((st.fon || 0) - (st.fal || 0)) * (1 - Math.exp(-dt / (st.fon ? 1.1 : 1.6)));
      if (!st.fon && st.fal < 0.04) st.fal = 0;                                      // out of sight: gone
      if (st.fal > 0 && st.fin) {
        const ea = smoothstep(0, 1, st.fal), ang = st.fon ? st.fin : (st.fout || st.fin);
        for (let h = 0; h < 2; h++) {
          const hx = Cx + 0.36 * W * vnoise(T * 0.35, h * 9 + 1), hy = Cy + 0.26 * H * vnoise(T * 0.4, h * 9 + 4), hz = Cz + 0.2 * W * vnoise(T * 0.3, h * 9 + 7);
          const ox = Math.cos(ang[h]) * 0.85 * W, oy = Math.sin(ang[h]) * 0.8 * H;    // out beyond the edge in that direction
          hawks.push([lerp(ox, hx, ea), lerp(oy, hy, ea), lerp(0, hz, ea), 0.11 * W, Math.max(storm, 0.2) * 3200 * sc * ea, h, ea]);
        }
      }
      // ---- the phones' test panel (js/lab.js): A your own bird, B a drawn shape, C a falcon you fly
      const ix = ixOf(R, E, 'murmuration');
      const pb = st.pb || (st.pb = new Map()), pf = st.pf || (st.pf = new Map());
      for (const m of [pb, pf]) for (const o of m.values()) o.on = 0;
      for (const ev of ix.live) {
        const m = ev.k === 'bird' ? pb : ev.k === 'falcon' ? pf : null; if (!m) continue;
        const tx = (clamp(ev.u, 0, 1) - 0.5) * W * 0.92, ty = (clamp(ev.v, 0, 1) - 0.5) * H * 0.9;
        let o = m.get(ev.id); if (!o) m.set(ev.id, o = { x: tx, y: ty, vx: 0, vy: 0, a: 0, sw: 0, h: 10 + m.size + (m === pf ? 20 : 0) });
        o.on = 1; o.tx = tx; o.ty = ty; o.col = ixCol(ev); o.swT = ev.s || 0;
      }
      let lx = 0, ly = 0, la = 0;
      for (const m of [pb, pf]) for (const [id, o] of m) {
        o.a += ((o.on ? 1 : 0) - o.a) * (1 - Math.exp(-dt * (o.on ? 3 : 1.5)));
        if (!o.on && o.a < 0.02) { m.delete(id); continue; }
        if (m === pb) {                                       // your bird: flies to where your finger is, with a little lag
          const ax = (o.tx - o.x) * 7 - o.vx * 4.2, ay = (o.ty - o.y) * 7 - o.vy * 4.2 + 30 * sc * Math.sin(T * 2.3 + o.h);
          o.vx += ax * dt; o.vy += ay * dt; const sp = Math.hypot(o.vx, o.vy), cap = 0.7 * W; if (sp > cap) { o.vx *= cap / sp; o.vy *= cap / sp; }
          o.x += o.vx * dt; o.y += o.vy * dt;
          lx += (o.x - o.vx * 0.5) * o.a; ly += (o.y - o.vy * 0.5) * o.a; la += o.a;
        } else {                                              // your falcon: right under your finger; a fast drag is a swoop
          const k0 = 1 - Math.exp(-dt * 12), px0 = o.x, py0 = o.y; o.x += (o.tx - o.x) * k0; o.y += (o.ty - o.y) * k0;
          o.vx = (o.x - px0) / Math.max(dt, 1e-3); o.vy = (o.y - py0) / Math.max(dt, 1e-3);
          o.sw += (Math.max(o.swT, clamp(Math.hypot(o.vx, o.vy) / (1.2 * W), 0, 1)) - o.sw) * (1 - Math.exp(-dt * 4));
          hawks.push([o.x, o.y, 0, (0.13 + 0.1 * o.sw) * W, (2600 + 4200 * o.sw) * sc * o.a, o.h, o.a, o.col]);
        }
      }
      // the flock's heart follows the birds people fly (a little behind them)
      st.lw_ = (st.lw_ || 0) + ((la ? Math.min(1, la) : 0) - (st.lw_ || 0)) * (1 - Math.exp(-dt * 1.5));
      if (la) { st.lx_ = lx / la; st.ly_ = ly / la; }
      const LW = st.lw_ * 0.85, Cx2 = lerp(Cx, st.lx_ || 0, LW), Cy2 = lerp(Cy, st.ly_ || 0, LW);
      // a shape drawn on a phone: the flock flies along it for a few seconds, then lets go
      for (const ev of ix.fresh) if (ev.k === 'shape' && ev.pts && ev.pts.length > 2) {
        const pts = ev.pts.map(([u, v]) => [(clamp(u, 0, 1) - 0.5) * W * 0.92, (clamp(v, 0, 1) - 0.5) * H * 0.9]), cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const L = cum[cum.length - 1], closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.12 * W;
        if (L > 0.05 * W) st.shape = { pts, cum, L, closed, t0: T, col: ixCol(ev) };
      }
      let shp = st.shape, shw = 0;
      if (shp) { const ag = T - shp.t0; shw = smoothstep(0, 1.4, ag) * (1 - smoothstep(6.5, 9, ag)); if (ag > 9) shp = st.shape = null; }
      const sp4 = [0, 0, 0, 0], onShape = f => {             // the point a fraction f along the drawn path, and its direction
        const d = f * shp.L, cu = shp.cum; let lo = 0, hi = cu.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cu[mid] < d) lo = mid; else hi = mid; }
        const a = shp.pts[lo], b = shp.pts[hi], t = clamp((d - cu[lo]) / Math.max(1e-6, cu[hi] - cu[lo]), 0, 1);
        sp4[0] = a[0] + (b[0] - a[0]) * t; sp4[1] = a[1] + (b[1] - a[1]) * t; sp4[2] = b[0] - a[0]; sp4[3] = b[1] - a[1];
      };
      const Kb = K + 3 * shw, Cdb = Cd + 1.2 * shw;
      let startle = 0;
      for (const b of R.bolts) if (b.t > (st.bolt || 0) && T >= b.t) { st.bolt = b.t; startle = Math.max(startle, b.power || 0.6); }
      // phone taps: a pebble thrown into the flock. The starlings near where it lands burst away from it,
      // then the flock closes up again (the pull back into formation does that by itself)
      const FOC = 1.7 * W, cx = W / 2, cy = H / 2;
      const peb = [];
      for (const q of tapsOf(R, E).all) if (!q.echo && q.age < 0.9) peb.push([q.x, q.y, (0.1 + 0.03 * q.k) * W, 4600 * sc * Math.exp(-q.age * 4.5), q.seed % 2 ? 1 : -1]);
      const vmax = (240 + 520 * storm + 380 * e) * sc, J = (25 + 220 * storm + 60 * e) * sc;
      for (let b = 0; b < N; b++) {
        const i3 = b * 3, l = lead[Ld[b]], fb = F[b];
        // where this bird belongs in the sheet right now
        let x = l.a * spread + O[i3] * l.r * spread, z = l.b * spread + O[i3 + 2] * l.r * spread;
        x *= 1 + 0.18 * Math.sin(x * wk - wph); z += 0.04 * W * Math.sin(T * 0.27 + l.w);
        let y = O[i3 + 1] * l.r + fold * (x * x - z * z) + 0.02 * W * Math.sin(T * 0.31 + l.w * 1.7);
        let y1 = y * cr - x * sr, x1 = x * cr + y * sr;
        const y2 = y1 * ct - z * stl, z2 = y1 * stl + z * ct;
        let tx = Cx2 + x1 * cyw + z2 * syw, ty = Cy2 + y2, tz = Cz - x1 * syw + z2 * cyw;
        if (shw > 0.001) {                                   // flying the drawn shape (a loop goes round, a line back and forth)
          const vb = (b * 0.6180339) % 1, ag = T - shp.t0, g = (vb * 0.5 + ag * 0.02) % 1;
          onShape(shp.closed ? (vb + ag * 0.025) % 1 : 1 - Math.abs(1 - 2 * g));
          const tl = Math.hypot(sp4[2], sp4[3]) + 1e-6, off = (((b * 0.7548777) % 1) - 0.5) * 0.035 * W;
          tx = lerp(tx, sp4[0] - sp4[3] / tl * off, shw); ty = lerp(ty, sp4[1] + sp4[2] / tl * off, shw); tz = lerp(tz, (((b * 0.5698403) % 1) - 0.5) * 0.08 * W, shw);
        }
        if (b >= st.init) { P[i3] = tx; P[i3 + 1] = ty; P[i3 + 2] = tz; }
        const px = P[i3], py = P[i3 + 1], pz = P[i3 + 2];
        let axx = (tx - px) * Kb - V[i3] * Cdb + J * Math.sin(T * 1.7 + fb * 13);
        let ayy = (ty - py) * Kb - V[i3 + 1] * Cdb + J * Math.sin(T * 1.3 + fb * 7);
        let azz = (tz - pz) * Kb - V[i3 + 2] * Cdb + J * Math.sin(T * 1.1 + fb * 11);
        if (pz < -0.4 * W) azz += (-0.4 * W - pz) * 9;                       // a soft wall: no bird comes right up to the camera
        for (const [hx, hy, hz, hr, hs] of hawks) {
          const dx = px - hx, dy = py - hy, dz = pz - hz, dd = dx * dx + dy * dy + dz * dz;
          if (dd < hr * hr) { const q = Math.sqrt(dd) + 1, f = hs * (1 - q / hr) * (1 - q / hr) / q; axx += dx * f; ayy += dy * f; azz += dz * f; }
        }
        if (peb.length) {                                    // the pebble works where the bird is seen on screen
          const kb = FOC / (FOC + Math.max(pz, -0.5 * W)), sx = cx + px * kb, sy = cy + py * kb;
          const vb = (b * 0.6180339) % 1, vr = 0.72 + 0.56 * vb, vs = 0.55 + 0.9 * ((b * 0.7548777) % 1);   // each bird its own reach and fright
          for (const [tx, ty, tr0, ts, tw] of peb) {
            const dx = sx - tx, dy = sy - ty, dd = dx * dx + dy * dy, tr = tr0 * vr;               // a ragged edge, not a circle
            if (dd < tr * tr) {
              const q = Math.sqrt(dd) + 1, f = ts * vs * (1 - q / tr) * (1 - q / tr) / q;
              axx += (dx - tw * dy * 0.45) * f / kb; ayy += (dy + tw * dx * 0.45) * f / kb;      // outward, with a little swirl
              azz += (vb - 0.5) * f * q * 0.9;
            }
          }
        }
        if (startle) { const dx = px - Cx, dy = py - Cy, dz = pz - Cz, q = Math.hypot(dx, dy, dz) + 1, f = startle * 650 * sc / q; V[i3] += dx * f; V[i3 + 1] += dy * f; V[i3 + 2] += dz * f; }
        let vx = V[i3] + axx * dt, vy = V[i3 + 1] + ayy * dt, vz = V[i3 + 2] + azz * dt;
        const sp = Math.hypot(vx, vy, vz), cap = vmax * (startle ? 3 : 1.6) * (1 + 1.5 * shw); if (sp > cap) { const q = cap / sp; vx *= q; vy *= q; vz *= q; }
        V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
        P[i3] = px + vx * dt; P[i3 + 1] = py + vy * dt; P[i3 + 2] = pz + vz * dt;
        F[b] = fb + dt * (10 + sp * 0.03 / sc);
      }
      st.init = N;
      // ---- draw, in the plumes' manner: each starling a point of light (ink on paper in the light theme) leaving a
      // soft trail as it flies, far ones fainter, near ones a fine stroke of wings. Colour only for what the phones do.
      const ink = PAL.ink, spr = sparkSprite(), ds = E.s || 1;
      c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.lineCap = 'round'; c.lineJoin = 'round'; c.setLineDash([]);
      c.fillStyle = `rgba(${PAL.bg},${E.fresh ? 1 : PAL.fade})`; c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = PAL.comp;
      let fl = 0;
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0) fl = Math.max(fl, (age < 0.07 ? 1 : age < 0.12 ? 0.3 : age < 0.2 ? 0.85 : Math.max(0, 0.85 - (age - 0.2) * 1.5)) * (b.power || 0.6)); }
      if (fl > 0.01) { c.fillStyle = `rgba(${ink},${(0.3 * fl).toFixed(3)})`; c.fillRect(0, 0, W, H); }
      const sz0 = 0.0042 * W;
      const DT = [0, 1, 2, 3].map(() => new Path2D()), WG = [0, 1, 2, 3].map(() => new Path2D()), xs = [], ys = [];
      for (let b = 0; b < N; b++) {
        const i3 = b * 3, k = FOC / (FOC + Math.max(P[i3 + 2], -0.5 * W));    // and never drawn bigger than that
        if (k <= 0) continue;
        const x = cx + P[i3] * k, y = cy + P[i3 + 1] * k;
        if ((b & 7) === 0) { xs.push(x - cx); ys.push(y - cy); }
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        const size = sz0 * k * Z[b], lv = Math.min(3, Math.max(0, Math.floor((k - 0.7) / 0.5 * 4)));
        const d = lw * (0.9 + 0.5 * Math.min(1.5, k));
        DT[lv].rect(x - d / 2, y - d / 2, d, d);
        if (size < 4) continue;                                // near ones: a fine stroke of wings
        let fx = V[i3], fy = V[i3 + 1]; const fm = Math.hypot(fx, fy) + 1e-3; fx /= fm; fy /= fm;
        const fp = Math.sin(F[b]), span = size * (0.55 + 0.45 * Math.abs(fp)), sw = size * (0.15 - 0.3 * fp);   // wings beat: up, sweep, down
        const p = WG[lv];
        p.moveTo(x - fy * span - fx * sw, y + fx * span - fy * sw); p.lineTo(x, y); p.lineTo(x + fy * span - fx * sw, y - fx * span - fy * sw);
      }
      if (xs.length > 8) {                                  // how far the flock reaches (ignoring the few stragglers at either end)
        xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); const q = Math.floor(xs.length * 0.04), r = xs.length - 1 - q;
        st.ext = [xs[q], xs[r], ys[q], ys[r]];
      }
      DT.forEach((pp, i) => { c.fillStyle = `rgba(${ink},${(0.35 + 0.2 * i).toFixed(2)})`; c.fill(pp); });
      c.lineWidth = lw * 0.8; WG.forEach((pp, i) => { c.strokeStyle = `rgba(${ink},${(0.25 + 0.18 * i).toFixed(2)})`; c.stroke(pp); });
      // the drawn shape, as a dotted line of the phone's colour for a moment; then the birds flown from phones
      const flow = -T * (16 + 40 * storm) * ds;
      if (shp && T - shp.t0 < 3.5) {
        c.strokeStyle = `rgba(${shp.col.join(',')},${(0.9 * (1 - smoothstep(2, 3.5, T - shp.t0))).toFixed(3)})`; c.lineWidth = lw * 1.6; c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow;
        c.beginPath(); shp.pts.forEach(([x, y], i) => i ? c.lineTo(cx + x, cy + y) : c.moveTo(cx + x, cy + y)); c.stroke(); c.setLineDash([]); c.lineDashOffset = 0;
      }
      for (const o of pb.values()) {
        const x = cx + o.x, y = cy + o.y, col = o.col.join(','), sz = sz0 * 5.5, fm = Math.hypot(o.vx, o.vy);
        let fx = 1, fy = 0; if (fm > 5) { fx = o.vx / fm; fy = o.vy / fm; }
        const fp = Math.sin(T * 11 + o.h), span = sz * (0.55 + 0.45 * Math.abs(fp)), sw = sz * (0.15 - 0.3 * fp), z = sz * 3.2;
        c.globalAlpha = o.a * 0.9; c.drawImage(glow(col, 64, 0.3), x - z / 2, y - z / 2, z, z); c.globalAlpha = o.a;
        c.strokeStyle = `rgb(${col})`; c.lineWidth = lw * 1.6; c.beginPath();
        c.moveTo(x - fy * span - fx * sw, y + fx * span - fy * sw); c.lineTo(x, y); c.lineTo(x + fy * span - fx * sw, y - fx * span - fy * sw); c.stroke();
        c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow; c.lineWidth = lw * 1.5; c.beginPath(); c.arc(x, y, sz * 1.4, 0, TAU); c.stroke(); c.setLineDash([]); c.lineDashOffset = 0;
        c.globalAlpha = 1;
      }
      // the falcons: a brighter spark with an outline of wings (a phone's falcon in its colour)
      st.hk = st.hk || [];
      for (const hk of hawks) {
        const h = hk[5]; if (h == null) continue;
        const pres = hk[6] == null ? 1 : hk[6];
        const k = FOC / (FOC + hk[2]), x = cx + hk[0] * k, y = cy + hk[1] * k;
        if (!st.hk[h] || T - (st.hkSeen == null ? -9 : st.hkSeen) > 0.5) st.hk[h] = [x - (hk[0] > 0 ? -1 : 1), y];   // fresh heading after a break
        const prev = st.hk[h];
        let fx = x - prev[0], fy = y - prev[1]; const fm = Math.hypot(fx, fy) + 1e-3; fx /= fm; fy /= fm;
        st.hk[h] = [lerp(prev[0], x, 0.3), lerp(prev[1], y, 0.3)];
        const sz = sz0 * 4.5 * k * (0.75 + 0.25 * pres), fp = Math.sin(T * 9 + h * 2), span = sz * (0.7 + 0.3 * fp), swp = sz * (0.35 - 0.25 * fp);
        const col = hk[7] ? hk[7].join(',') : ink, a = Math.min(1, pres * 1.4), z = sz * (hk[7] ? 3 : 2);
        c.globalAlpha = a * (hk[7] ? 0.9 : 0.6); c.drawImage(hk[7] ? glow(col, 64, 0.3) : spr, x - z / 2, y - z / 2, z, z); c.globalAlpha = 1;
        c.strokeStyle = `rgba(${col},${(0.95 * a).toFixed(3)})`; c.lineWidth = lw * (hk[7] ? 1.6 : 1.1); c.beginPath();
        c.moveTo(x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.quadraticCurveTo(x - fy * span * 0.5 + fx * sz * 0.1, y + fx * span * 0.5 + fy * sz * 0.1, x - fy * span - fx * swp, y + fx * span - fy * swp);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2); c.lineTo(x - fx * sz * 0.6 - fy * sz * 0.12, y - fy * sz * 0.6 + fx * sz * 0.12); c.lineTo(x - fx * sz * 0.6 + fy * sz * 0.12, y - fy * sz * 0.6 - fx * sz * 0.12);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2);
        c.lineTo(x + fy * span - fx * swp, y - fx * span - fy * swp);
        c.quadraticCurveTo(x + fy * span * 0.5 + fx * sz * 0.1, y - fx * span * 0.5 + fy * sz * 0.1, x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.stroke();
        st.hkSeen = T;
      }
      c.globalCompositeOperation = 'source-over';
    },
  };

  /* ============================================================== 2  Umbrellas
     A plaza in the rain, seen from a high window. Every raining place is somebody crossing it under an
     umbrella: where they walk from where the place is (east-west across, north on the far side, south on
     the near one), the size of the umbrella from how hard it is raining there, its colour from the latitude
     (coral and orange in the tropics, yellow, green and teal in the middle latitudes, lavender toward the
     poles) and its pattern from the kind of rain: drizzle plain, rain two-tone, showers rainbow,
     thunderstorms black with a coloured rim. A breath is a gust across the plaza: the umbrellas lean away
     from the side it came from, people stagger downwind and the weaker umbrellas blow inside out; a storm
     turns many inside out and tears a few out of people's hands; lightning lights the plaza white with
     hard shadows and everyone jumps. Calm, the umbrellas close, the sun comes out, long shadows fall across
     the wet stone and a rainbow shows in a puddle. A tap twirls the umbrella of the place tapped (or the
     ones near where it lands); the wall's own soft notes give a little twirl. */
  const COATS = ['43,45,53', '74,59,50', '31,42,58', '90,47,47', '47,59,45', '60,58,70', '96,82,60'];
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
    for (let n = 0; n < 6; n++) {                                // puddles
      const cx = n === 2 ? 3.5 : (hash(n * 7 + 1) - 0.5) * 18, cy = n === 2 ? -1 : -3 + hash(n * 7 + 2) * 10, r = n === 2 ? 1.7 : 0.8 + 1.4 * hash(n * 7 + 3);
      const rr = a => r * (1 + 0.35 * vnoise(Math.cos(a) * 1.5 + n * 3, Math.sin(a) * 1.5));
      for (let q = 0; q < 260 * r; q++) {
        const a = hash(n * 997 + q * 3) * TAU, edge = hash(n * 997 + q * 3 + 1) < 0.7, f = edge ? 0.9 + 0.12 * hash(n * 997 + q * 3 + 2) : Math.sqrt(hash(n * 997 + q * 3 + 2)) * 0.9;
        P(cx + Math.cos(a) * rr(a) * 1.5 * f, cy + Math.sin(a) * rr(a) * f, 0, p);
        dot(p[0], p[1], edge ? 1.3 : 1, edge ? 0.75 : 0.18);
      }
    }
    for (const t of st.trees) for (let q = 0; q < 900; q++) {   // crowns
      const a = hash(t.sd + q * 3) * TAU, f = Math.pow(hash(t.sd + q * 3 + 1), 0.35), x = t.x + Math.cos(a) * t.r * 0.9 * f, y = t.y + Math.sin(a) * t.r * 0.9 * f;
      dot(x, y, 0.9 + 1.2 * hash(t.sd + q * 3 + 2), 0.25 + 0.5 * f);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-in'; g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = `rgb(${PAL.ink})`; g.fillRect(0, 0, cv.width, cv.height);
    return cv;
  }
  function umbPeople(st, E, W, H) {
    st.ref = E.sites;
    const old = new Map((st.ppl || []).map(q => [q.id, q])), out = [];
    for (const z of E.sites) {
      const kind = kindOf(E, z), lat = latOf(z), [h, sa, l] = latColor(lat), R = 0.42 + 0.5 * z.k;
      const [hx, hy] = st.G(W * (0.06 + 0.88 * z.u), H * (0.12 + 0.8 * southOf(z)));
      const q = old.get(z.id) || { id: z.id, x: hx, y: hy, vx: 0, vy: 0, hd: hash(z.id) * TAU, ph: hash(z.id + 1) * 9, tx: 0, ty: 0, tvx: 0, tvy: 0, io: 0, iot: 0, calmT: 0,
                                   sp: 0.5 + 0.45 * hash(z.id + 2), spin: hash(z.id + 3) * TAU, om: 0, o: E.fresh ? 1 : 0, lost: 0, th: 0.5 + 0.4 * hash(z.id + 4), gx: hx, gy: hy, gt: 0,
                                   coat: COATS[Math.floor(hash(z.id + 5) * COATS.length)], hair: hash(z.id + 6) < 0.7 ? '24,20,18' : hash(z.id + 6) < 0.85 ? '120,100,80' : '170,170,170' };
      Object.assign(q, { hx, hy, R, kind, k: z.k });
      // the canopy's colours, panel by panel
      const sat = Math.min(95, sa + 10), lit = clamp(l - 6, 38, 64), base = hsl2rgb(h, sat, lit).split(',').map(Number);
      q.cols = [];
      for (let i = 0; i < 8; i++) q.cols.push(kind === 0 ? hsl2rgb(h, sat - 15, Math.min(76, lit + 12)).split(',').map(Number) : kind === 1 ? (i & 1 ? [242, 236, 222] : base)
                                                : kind === 2 ? hsl2rgb(h + i * 45, 70, 58).split(',').map(Number) : [40, 40, 50]);
      q.rim = kind === 3 ? base : null;
      q.cols = q.cols.map(greyOf); if (q.rim) q.rim = greyOf(q.rim);                 // the crowd in greys
      q.coat = greyOf(q.coat).join(','); q.hair = greyOf(q.hair).join(',');
      out.push(q);
    }
    st.ppl = out;
  }
  // Umbrellas is black and white: everything but the umbrellas of the phones that join in
  const greyOf = c => { const [r, g, b] = typeof c === 'string' ? c.split(',').map(Number) : c, l = Math.round(0.3 * r + 0.59 * g + 0.11 * b); return [l, l, l]; };
  function toGrey(cv) {
    try {
      const g = cv.getContext('2d'), im = g.getImageData(0, 0, cv.width, cv.height), d = im.data;
      for (let i = 0; i < d.length; i += 4) { const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = l; }
      g.putImageData(im, 0, 0);
    } catch (e) {}
    return cv;
  }
  const umbrellas = {
    name: 'umbrellas', title: 'Umbrellas', bolts: false,
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
      const day = dayOf(st, E), P = st.P, p = [0, 0, 0], q2 = [0, 0, 0], ppl = st.ppl;
      const [fl, fb] = flicker(R, T);
      // ---- the wind: the breath from the side it comes in, gusts in a storm
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, wdx = Math.abs(wx) > 0.12 ? wx : dir * 0.8, wdy = -wy * 0.8;
      const amt = (1 - calm) * (1 + 1.5 * storm);
      const wet = 1 - smoothstep(0.35, 0.65, calm);             // the rain stops first, then people fold their umbrellas
      const openT = 1 - smoothstep(0.55, 0.9, calm);
      // startled by a strike: everybody jumps away from it; taps twirl umbrellas
      const strikes = newBolts(R, st, T);
      const tp = tapsOf(R, E);
      // ---- the phones' test panel (js/lab.js): A your own walker, B a shower where you hold, C a gust you swipe
      const ix = ixOf(R, E, 'umbrellas'), mine = st.mine || (st.mine = new Map()), shw = st.shw || (st.shw = new Map()), live = new Set();
      for (const ev of ix.live) {
        const [gx, gy] = st.G(clamp(ev.u, 0, 1) * W, clamp(ev.v, 0, 1) * H);
        if (ev.k === 'walk') {
          let q = mine.get(ev.id);
          if (!q) {
            const col = ixCol(ev); st.nid = (st.nid || 0) + 1;
            q = { id: 9000 + st.nid * 7, ctrl: 1, x: gx, y: gy, vx: 0, vy: 0, hd: 0, ph: 0, tx: 0, ty: 0, tvx: 0, tvy: 0, io: 0, iot: 0, calmT: 0, sp: 1, spin: 0, om: 0, o: 0, lost: 0, th: 0.75,
                  gt: 1e9, gx, gy, hx: gx, hy: gy, coat: col.join(','), hair: '24,20,18', R: 0.75, kind: 1, k: 0.6, cols: [0, 1, 2, 3, 4, 5, 6, 7].map(i => i & 1 ? [245, 242, 235] : col), rim: null, col };
            mine.set(ev.id, q);
          }
          q.gx = gx; q.gy = gy; q.open = !!ev.open; q.key = ev.id; q.col = ixCol(ev); live.add(ev.id);
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
        const spd = q.ctrl ? 1.7 * Math.min(1, dd / 0.9) : q.sp * (0.8 + 0.5 * (1 - calm) + 0.9 * storm) * run * (1 + 0.8 * lwq) * (held ? Math.min(1, dd / 0.6) : 1);
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
          q.lost = T + 7 + 6 * rnd(); q.o = 0;
          st.fly.push({ x: q.x, y: q.y, z: 2.2, vx: wdx * 5, vy: wdy * 5, vz: 2.5, cols: q.cols, rim: q.rim, R: q.R, spin: q.spin, om: 9 * (rnd() < 0.5 ? -1 : 1), tx: wdx * 0.6, ty: 0.5, t: T });
        } else if (!q.ctrl && gg > 0.5 && q.io > 0.8 && q.lost < T && st.fly.length < 10 && rnd() < dt * gg * 1.2) {   // ... and so does a strong gust
          q.lost = T + 12 + 6 * rnd(); q.o = 0;
          st.fly.push({ x: q.x, y: q.y, z: 2.2, vx: qwx * 6, vy: qwy * 6, vz: 2.5, wx: qwx, wy: qwy, cols: q.cols, rim: q.rim, R: q.R, spin: q.spin, om: 9 * (rnd() < 0.5 ? -1 : 1), tx: qwx * 0.6, ty: 0.5, t: T });
        }
        const ot = q.ctrl ? (q.open ? 1 : 0) : q.lost > T ? 0 : Math.max(openT, smoothstep(0.15, 0.5, lwq));
        q.o += (ot - q.o) * (1 - Math.exp(-dt * (ot > q.o ? 2.6 : 1.5)));           // calm: fold, then fade away; rain: fade in folded, then unfold
        // twirls
        for (const t of tp.fresh) {
          if (t.site === q.id) q.om += t.echo ? 2.6 : 11 * (hash(t.seed) < 0.5 ? -1 : 1);
          else if (!t.echo && t.site == null) { const [gx, gy] = st.G(t.x, t.y), d = Math.hypot(gx - q.x, gy - q.y); if (d < 3) { q.om += (3 - d) * 3; q.vx += (q.x - gx) / (d + 0.3) * 1.5; q.vy += (q.y - gy) / (d + 0.3) * 1.5; } }
        }
        q.om *= Math.exp(-dt * 0.7); q.om += (rnd() - 0.5) * storm * 30 * dt; q.spin += q.om * dt;
      }
      // A: sharing. Only someone whose umbrella the wind took (a storm, or a gust) comes in under a phone's
      // open umbrella: they run to the nearest one in reach (up to 4 under each) and walk along with it while it rains
      for (const m of mine.values()) m.ng = 0;
      const hostOk = m => mine.get(m.key) === m && m.o > 0.5 && calm < 0.8;
      for (const q of ppl) {
        if (q.host && !hostOk(q.host)) { q.host = null; q.lost = Math.min(q.lost, T + 1.5); }   // that umbrella closed or left
        if (q.host) q.host.ng++;
      }
      for (const q of ppl) if (!q.host && q.lost > T) {
        let best = null, bd = 8;
        for (const m of mine.values()) { const d = Math.hypot(m.x - q.x, m.y - q.y); if (hostOk(m) && m.ng < 4 && d < bd) { bd = d; best = m; } }
        if (best) { q.host = best; best.ng++; best.sl = (best.sl || 0) + 1; q.slot = best.sl; }
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
      c.globalAlpha = E.fresh ? 0.45 : 0.12; c.drawImage(st.gnd, 0, 0, W, H); c.globalAlpha = 1;
      if (fl > 0.02) { c.fillStyle = `rgba(${ink},${(0.3 * fl).toFixed(3)})`; c.fillRect(0, 0, W, H); }
      const fib = [0, 1, 2, 3].map(() => new Path2D()), dts = [0, 1, 2, 3].map(() => new Path2D()), silk = new Path2D(), sparks = [];
      const lev = (arr, al) => arr[Math.min(3, Math.max(0, Math.floor(al * 4)))];
      const dot = (pp, x, y, d) => pp.rect(x - d / 2, y - d / 2, d, d);
      const cp = new Map(), CP = col => { const k = col.join(','); let o = cp.get(k); if (!o) cp.set(k, o = { fib: new Path2D(), body: new Path2D(), lines: new Path2D(), dots: new Path2D(), glow: [] }); return o; };
      const off = (x, y) => x < -30 || x > W + 30 || y < -30 || y > H + 30;
      // splashes: a ring of dots opening on the stone (in a phone's colour where its shower falls)
      const nsp = Math.round((14 + 120 * amt) * wet * W / 1600);
      for (let i = 0; i < nsp; i++) {
        const ph = T / 0.4 + hash(i * 7 + 3), cyc = Math.floor(ph), f = ph - cyc, sd = i * 131 + cyc * 7919;
        P((hash(sd) - 0.5) * 26, -6 + hash(sd + 1) * 16, 0, p); if (off(p[0], p[1])) continue;
        const r = (0.04 + 0.22 * f) * p[2], pp = lev(dts, 0.7 * (1 - f));
        for (let m = 0; m < 7; m++) { const a = hash(sd + m * 5) * TAU; dot(pp, p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r * 0.82, lw * 1.1); }
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
        const pat = q.ctrl ? 255 : PAT[q.kind] || 0;
        for (let i = 0; i < 8; i++) if (pat >> i & 1) for (const f of [0.42, 0.7]) {
          const t0 = tp[i], t1 = tp[(i + 1) % 8], m = md[i];
          out.moveTo(A[0] + (t0[0] - A[0]) * f, A[1] + (t0[1] - A[1]) * f);
          out.quadraticCurveTo(A[0] + (m[0] - A[0]) * f, A[1] + (m[1] - A[1]) * f, A[0] + (t1[0] - A[0]) * f, A[1] + (t1[1] - A[1]) * f);
        }
        return { A, tp };
      };
      const aw0 = amt * wet;
      for (const q of list) {
        const C = q.ctrl ? CP(q.col) : null;
        // the person: a dotted head and shoulders, seen as the umbrella fades
        const vis = 1 - smoothstep(0.15, 0.6, q.o);
        if (vis > 0.01) {
          const out = C ? C.fib : lev(fib, 0.55 * vis);
          P(q.x, q.y, 1.45, p); const k = p[2];
          out.moveTo(p[0] + 0.3 * k, p[1]); out.ellipse(p[0], p[1], 0.3 * k, 0.15 * k, q.hd + Math.PI / 2, 0, TAU);
          P(q.x + Math.cos(q.hd) * 0.04, q.y + Math.sin(q.hd) * 0.04, 1.7, q2); out.moveTo(q2[0] + 0.12 * q2[2], q2[1]); out.arc(q2[0], q2[1], 0.12 * q2[2], 0, TAU);
        }
        if (C) { P(q.x, q.y, 1.45, p); const g0 = st.G(p[0], p[1]); P(g0[0], g0[1], 0, p); const rr = 1.1 * p[2] * (1 + 0.22 * (q.sh || 0));   // your ring on the ground
          C.fib.moveTo(p[0] + rr, p[1]); C.fib.ellipse(p[0], p[1], rr, rr * 0.8, 0, 0, TAU); }
        if (q.o > 0.02) {
          const al = smoothstep(0.02, 0.4, q.o), gq = geo(q, q.x, q.y, 1.1);
          const { A, tp } = canopy(q, gq, C ? C.fib : lev(fib, al * (0.35 + 0.6 * q.k)), C ? C.body : null);
          if (C) C.glow.push([A[0], A[1], 0.8 * al, 1.8 * A[2] * q.R]); else sparks.push([A[0], A[1], al * (0.12 + 0.3 * q.k), 0.38 * A[2] * q.R]);
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
      c.strokeStyle = `rgba(${ink},0.05)`; c.lineWidth = lw * 0.6; c.stroke(silk);
      c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow; c.lineWidth = lw * 1.25;
      fib.forEach((pp, i) => { c.strokeStyle = `rgba(${ink},${(0.2 + 0.25 * i).toFixed(2)})`; c.stroke(pp); });
      c.setLineDash([]); c.lineDashOffset = 0;
      dts.forEach((pp, i) => { c.fillStyle = `rgba(${ink},${(0.2 + 0.25 * i).toFixed(2)})`; c.fill(pp); });
      c.strokeStyle = `rgba(${ink},${(0.16 + 0.06 * storm).toFixed(3)})`; c.lineWidth = lw * 0.8; c.stroke(rain);
      for (const [x, y, al, z] of sparks) { c.globalAlpha = Math.min(1, al); c.drawImage(spr, x - z / 2, y - z / 2, z, z); }
      c.globalAlpha = 1;
      for (const [k, o] of cp) {
        c.fillStyle = `rgba(${k},0.14)`; c.fill(o.body);
        c.strokeStyle = `rgba(${k},0.35)`; c.lineWidth = lw * 0.6; c.stroke(o.body);
        c.strokeStyle = `rgba(${k},0.55)`; c.lineWidth = lw * 0.9; c.stroke(o.lines);
        c.fillStyle = `rgba(${k},0.95)`; c.fill(o.dots);
        c.setLineDash([0.01, 3 * ds]); c.lineDashOffset = flow; c.strokeStyle = `rgba(${k},1)`; c.lineWidth = lw * 1.7; c.stroke(o.fib); c.setLineDash([]); c.lineDashOffset = 0;
        const gl = glow(k, 64, 0.3);
        for (const [x, y, al, z] of o.glow) { c.globalAlpha = al; c.drawImage(gl, x - z / 2, y - z / 2, z, z); }
        c.globalAlpha = 1;
      }
      c.globalCompositeOperation = 'source-over';
    },
  };

  return [murm, umbrellas];
})();
