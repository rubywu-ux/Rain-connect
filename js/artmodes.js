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
    name: 'murmuration', title: 'Murmuration', dark: true, bolts: false,
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
        const tx = Cx + x1 * cyw + z2 * syw, ty = Cy + y2, tz = Cz - x1 * syw + z2 * cyw;
        if (b >= st.init) { P[i3] = tx; P[i3 + 1] = ty; P[i3 + 2] = tz; }
        const px = P[i3], py = P[i3 + 1], pz = P[i3 + 2];
        let axx = (tx - px) * K - V[i3] * Cd + J * Math.sin(T * 1.7 + fb * 13);
        let ayy = (ty - py) * K - V[i3 + 1] * Cd + J * Math.sin(T * 1.3 + fb * 7);
        let azz = (tz - pz) * K - V[i3 + 2] * Cd + J * Math.sin(T * 1.1 + fb * 11);
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
        const sp = Math.hypot(vx, vy, vz), cap = vmax * (startle ? 3 : 1.6); if (sp > cap) { const q = cap / sp; vx *= q; vy *= q; vz *= q; }
        V[i3] = vx; V[i3 + 1] = vy; V[i3 + 2] = vz;
        P[i3] = px + vx * dt; P[i3 + 1] = py + vy * dt; P[i3 + 2] = pz + vz * dt;
        F[b] = fb + dt * (10 + sp * 0.03 / sc);
      }
      st.init = N;
      // ---- draw: the gold, then the birds (far ones small and paler, near ones bigger and darker)
      c.globalCompositeOperation = 'source-over';
      c.drawImage(st.bg, 0, 0, W, H);
      let fl = 0;
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0) fl = Math.max(fl, (age < 0.07 ? 1 : age < 0.12 ? 0.3 : age < 0.2 ? 0.85 : Math.max(0, 0.85 - (age - 0.2) * 1.5)) * (b.power || 0.6)); }
      if (fl > 0.01) { c.globalCompositeOperation = 'lighter'; c.fillStyle = `rgba(255,214,140,${0.5 * fl})`; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; }
      const sz0 = 0.0042 * W;
      const B3 = [new Path2D(), new Path2D(), new Path2D()], dots = new Path2D(), xs = [], ys = [];
      for (let b = 0; b < N; b++) {
        const i3 = b * 3, k = FOC / (FOC + Math.max(P[i3 + 2], -0.5 * W));    // and never drawn bigger than that
        if (k <= 0) continue;
        const x = cx + P[i3] * k, y = cy + P[i3 + 1] * k;
        if ((b & 7) === 0) { xs.push(x - cx); ys.push(y - cy); }
        if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
        const size = sz0 * k * Z[b];
        if (size < 3.2) { const d = Math.max(1.1, size * 0.45); dots.rect(x - d / 2, y - d * 0.35, d, d * 0.7); continue; }
        let fx = V[i3], fy = V[i3 + 1]; const fm = Math.hypot(fx, fy) + 1e-3; fx /= fm; fy /= fm;
        const fp = Math.sin(F[b]), span = size * (0.55 + 0.45 * Math.abs(fp)), sw = size * (0.15 - 0.3 * fp);   // wings beat: up, sweep, down
        const p = B3[k > 1.12 ? 2 : k > 0.95 ? 1 : 0];
        p.moveTo(x + fx * size * 0.32, y + fy * size * 0.32);
        p.lineTo(x - fy * span - fx * sw, y + fx * span - fy * sw);
        p.lineTo(x - fx * size * 0.12, y - fy * size * 0.12);
        p.lineTo(x + fy * span - fx * sw, y - fx * span - fy * sw);
        p.lineTo(x + fx * size * 0.32, y + fy * size * 0.32);
      }
      if (xs.length > 8) {                                  // how far the flock reaches (ignoring the few stragglers at either end)
        xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); const q = Math.floor(xs.length * 0.04), r = xs.length - 1 - q;
        st.ext = [xs[q], xs[r], ys[q], ys[r]];
      }
      c.fillStyle = 'rgba(46,30,10,0.62)'; c.fill(dots);
      c.lineJoin = 'round'; c.lineWidth = lw * 0.5;
      [['54,36,12', 0.7], ['30,19,7', 0.85], ['18,11,4', 0.95]].forEach(([col, a], i) => { c.fillStyle = c.strokeStyle = `rgba(${col},${a})`; c.fill(B3[i]); c.stroke(B3[i]); });
      // the falcons, facing the way they fly
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
        c.fillStyle = `rgba(14,9,3,${(0.95 * Math.min(1, pres * 1.4)).toFixed(3)})`; c.beginPath();
        c.moveTo(x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.quadraticCurveTo(x - fy * span * 0.5 + fx * sz * 0.1, y + fx * span * 0.5 + fy * sz * 0.1, x - fy * span - fx * swp, y + fx * span - fy * swp);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2); c.lineTo(x - fx * sz * 0.6 - fy * sz * 0.12, y - fy * sz * 0.6 + fx * sz * 0.12); c.lineTo(x - fx * sz * 0.6 + fy * sz * 0.12, y - fy * sz * 0.6 - fx * sz * 0.12);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2);
        c.lineTo(x + fy * span - fx * swp, y - fx * span - fy * swp);
        c.quadraticCurveTo(x + fy * span * 0.5 + fx * sz * 0.1, y - fx * span * 0.5 + fy * sz * 0.1, x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.fill();
        st.hkSeen = T;
      }
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
  function umbBg(st, W, H, dpr, day) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), P = st.P, p = [0, 0, 0];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = day ? '#b3ada2' : '#17181d'; g.fillRect(0, 0, W, H);
    // big stone slabs, each a slightly different stone, wet
    const S = 1.6, joints = new Path2D(), tones = [[], [], [], [], []];
    for (let j = -5; j < 9; j++) for (let i = -11; i < 11; i++) {
      const q = [];
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]]) { P((i + a) * S, (j + b) * S, 0, p); q.push([p[0], p[1]]); }
      const path = new Path2D(); q.forEach(([x, y], n) => n ? path.lineTo(x, y) : path.moveTo(x, y)); path.closePath();
      tones[Math.floor(hash(i * 31 + j * 17 + 5) * 5)].push(path);
      q.forEach(([x, y], n) => n ? joints.lineTo(x, y) : joints.moveTo(x, y)); joints.lineTo(q[0][0], q[0][1]);
    }
    const T5 = day ? ['178,171,160', '186,180,170', '170,164,154', '192,186,176', '164,158,150'] : ['27,28,34', '31,32,38', '24,25,31', '35,35,42', '22,23,28'];
    tones.forEach((list, n) => { g.fillStyle = `rgb(${T5[n]})`; for (const path of list) g.fill(path); });
    g.strokeStyle = day ? 'rgba(90,84,76,0.45)' : 'rgba(0,0,0,0.6)'; g.lineWidth = 1.2; g.stroke(joints);
    // a band of dark granite running across the plaza
    g.fillStyle = day ? 'rgba(80,76,72,0.35)' : 'rgba(0,0,0,0.3)';
    const band = new Path2D(); [[-20, 1.6], [20, 1.6], [20, 3.2], [-20, 3.2]].forEach(([x, y], n) => { P(x, y, 0, p); n ? band.lineTo(p[0], p[1]) : band.moveTo(p[0], p[1]); }); band.closePath(); g.fill(band);
    // the light: lamps on the wet stone at night, a patch of sun by day
    if (!day) for (const [x, y] of st.lamps) {
      P(x, y, 0, p); const r = 4.2 * p[2];
      g.save(); g.translate(p[0], p[1]); g.scale(1, 0.86);
      const q = g.createRadialGradient(0, 0, 0, 0, 0, r); q.addColorStop(0, 'rgba(255,170,90,0.34)'); q.addColorStop(0.4, 'rgba(255,140,70,0.12)'); q.addColorStop(1, 'rgba(255,140,70,0)');
      g.fillStyle = q; g.fillRect(-r, -r, 2 * r, 2 * r); g.restore();
    } else {
      const q = g.createRadialGradient(W * 0.62, H * 0.42, 0, W * 0.62, H * 0.42, W * 0.6); q.addColorStop(0, 'rgba(255,236,190,0.42)'); q.addColorStop(0.6, 'rgba(255,226,170,0.12)'); q.addColorStop(1, 'rgba(255,220,160,0)');
      g.fillStyle = q; g.fillRect(0, 0, W, H);
    }
    // puddles: the sky in them (a rainbow in one, by day)
    for (let n = 0; n < 6; n++) {
      const cx = n === 2 ? 3.5 : (hash(n * 7 + 1) - 0.5) * 18, cy = n === 2 ? -1 : -3 + hash(n * 7 + 2) * 10, r = n === 2 ? 1.7 : 0.8 + 1.4 * hash(n * 7 + 3), path = new Path2D();
      for (let i = 0; i <= 24; i++) { const a = i / 24 * TAU, rr = r * (1 + 0.35 * vnoise(Math.cos(a) * 1.5 + n * 3, Math.sin(a) * 1.5)); P(cx + Math.cos(a) * rr * 1.5, cy + Math.sin(a) * rr, 0, p); i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1]); }
      path.closePath();
      g.fillStyle = day ? 'rgba(186,210,232,0.9)' : 'rgba(10,12,26,0.85)'; g.fill(path);
      g.strokeStyle = day ? 'rgba(255,255,255,0.35)' : 'rgba(120,130,170,0.18)'; g.lineWidth = 1.5; g.stroke(path);
      g.save(); g.clip(path);
      if (day && n === 2) {
        P(cx, cy + r * 0.6, 0, p); const k = p[2];
        ['255,60,60', '255,150,40', '255,230,60', '80,200,90', '60,140,255', '140,80,220'].forEach((col, i) => { g.strokeStyle = `rgba(${col},0.32)`; g.lineWidth = 0.09 * k; g.beginPath(); g.ellipse(p[0], p[1] + r * k * 0.4, r * k * (1.2 - i * 0.09), r * k * 0.7 * (1.2 - i * 0.09), 0, Math.PI, TAU); g.stroke(); });
      }
      if (!day) { P(cx, cy, 0, p); const q = g.createLinearGradient(p[0], p[1] - r * p[2], p[0], p[1] + r * p[2]); q.addColorStop(0, 'rgba(255,160,90,0)'); q.addColorStop(0.5, 'rgba(255,160,90,0.12)'); q.addColorStop(1, 'rgba(255,160,90,0)'); g.fillStyle = q; g.fill(path); }
      g.restore();
    }
    // grain, and a darker edge
    const gr = [new Path2D(), new Path2D()];
    for (let i = 0; i < 9000; i++) gr[i & 1].rect(hash(i * 3 + 1) * W, hash(i * 3 + 2) * H, 1.2, 1.2);
    g.fillStyle = day ? 'rgba(60,54,46,0.1)' : 'rgba(0,0,0,0.25)'; g.fill(gr[0]); g.fillStyle = day ? 'rgba(255,255,250,0.12)' : 'rgba(255,255,255,0.03)'; g.fill(gr[1]);
    const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, day ? 'rgba(40,30,20,0.22)' : 'rgba(0,0,0,0.5)');
    g.fillStyle = v; g.fillRect(0, 0, W, H);
    return cv;
  }
  function umbTree(st, r, day, sd) {                // a tree crown seen from above (Seattle in autumn)
    const S = Math.ceil(r * 2.3), cv = canvas(S, S), g = cv.getContext('2d'), m = S / 2;
    const cols = day ? ['58,92,44', '82,112,48', '170,146,52', '206,124,40', '120,120,50', '190,80,40'] : ['22,36,26', '30,44,28', '64,52,22', '78,46,18', '36,42,24', '70,30,20'];
    for (let i = 0; i < 420; i++) {
      const a = hash(sd + i * 3) * TAU, d = Math.sqrt(hash(sd + i * 3 + 1)) * r * 0.9, x = m + Math.cos(a) * d, y = m + Math.sin(a) * d, z = r * (0.08 + 0.12 * hash(sd + i * 3 + 2));
      const col = cols[Math.floor(hash(sd + i * 7) * cols.length)];
      g.fillStyle = `rgba(${col},0.9)`; g.beginPath(); g.arc(x, y, z * 0.7, 0, TAU); g.fill();
      g.fillStyle = day ? 'rgba(255,250,220,0.18)' : 'rgba(120,120,100,0.08)'; g.beginPath(); g.arc(x - z * 0.2, y - z * 0.2, z * 0.35, 0, TAU); g.fill();
    }
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
        st.bgN = umbBg(st, W, H, dpr, false); st.bgD = umbBg(st, W, H, dpr, true);
        const rt = Math.min(W, H) * 0.26;
        st.trees = [[-0.02 * W, 0.18 * H, rt, 11], [1.03 * W, 0.62 * H, rt * 1.15, 47], [0.12 * W, 1.04 * H, rt * 0.9, 83]].map(([x, y, r, sd]) => ({ x, y, r, n: umbTree(st, r, false, sd), d: umbTree(st, r, true, sd) }));
        st.ref = null; st.fly = []; st.ppl = null;
      }
      if (st.ref !== E.sites) umbPeople(st, E, W, H);
      const day = dayOf(st, E), P = st.P, p = [0, 0, 0], q2 = [0, 0, 0], ppl = st.ppl;
      const [fl, fb] = flicker(R, T);
      // ---- the wind: the breath from the side it comes in, gusts in a storm
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, wdx = Math.abs(wx) > 0.12 ? wx : dir * 0.8, wdy = -wy * 0.8;
      const amt = (1 - calm) * (1 + 1.5 * storm);
      const openT = 1 - smoothstep(0.45, 0.9, calm);
      // startled by a strike: everybody jumps away from it; taps twirl umbrellas
      const strikes = newBolts(R, st, T);
      const tp = tapsOf(R, E);
      for (const q of ppl) {
        P(q.x, q.y, 2, p); const sx = p[0], sy = p[1];
        const G = e * (0.3 + 0.7 * Math.exp(-((sx - bxs) ** 2) / (0.2 * W * W))) * (0.85 + 0.15 * Math.sin(T * 7 + q.id)) + storm * (0.5 + 0.5 * vnoise(T * 0.9, q.id * 0.37));
        // walking: toward a spot near home, a new one now and then
        if (T > q.gt || Math.hypot(q.gx - q.x, q.gy - q.y) < 0.4) { q.gt = T + 6 + 8 * rnd(); const a = rnd() * TAU, r = 0.5 + 2.4 * Math.sqrt(rnd()); q.gx = q.hx + Math.cos(a) * r * 1.4; q.gy = q.hy + Math.sin(a) * r; }
        const dx = q.gx - q.x, dy = q.gy - q.y, dd = Math.hypot(dx, dy) + 1e-6, run = q.lost > T ? 2 : 1;
        const spd = q.sp * (0.8 + 0.5 * (1 - calm) + 0.9 * storm) * run;
        let ax = dx / dd * spd + wdx * G * 1.6, ay = dy / dd * spd + wdy * G * 1.6;
        if (sx < W * 0.04) ax += 1.5; if (sx > W * 0.96) ax -= 1.5; if (sy < H * 0.08) ay -= 1.5; if (sy > H * 0.96) ay += 1.5;
        for (const b of strikes) { const ux = q.x - ((b.u == null ? 0.5 : b.u) - 0.5) * 16, uy = q.y - 2, ud = Math.hypot(ux, uy) + 0.5; q.vx += ux / ud * 3.5 * (b.power || 0.6); q.vy += uy / ud * 3.5 * (b.power || 0.6); q.om += (rnd() - 0.5) * 14; q.tvx += (rnd() - 0.5) * 3; q.tvy += (rnd() - 0.5) * 3; }
        const kv = 1 - Math.exp(-dt * 2.5); q.vx += (ax - q.vx) * kv; q.vy += (ay - q.vy) * kv;
        q.x += q.vx * dt; q.y += q.vy * dt;
        const vm = Math.hypot(q.vx, q.vy);
        if (vm > 0.05) { let dh = Math.atan2(q.vy, q.vx) - q.hd; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); q.hd += dh * Math.min(1, dt * 4); }
        q.ph += dt * vm * 5;
        // the umbrella leans with the wind (a spring), and may blow inside out
        const lean = 0.95 * G * (1.25 - 0.35 * q.R);
        q.tvx += ((wdx * lean + 0.03 * Math.sin(q.ph) - q.tx) * 34 - q.tvx * 6) * dt; q.tvy += ((wdy * lean + 0.03 * Math.cos(q.ph * 0.5) - q.ty) * 34 - q.tvy * 6) * dt;
        q.tx = clamp(q.tx + q.tvx * dt, -0.9, 0.9); q.ty = clamp(q.ty + q.tvy * dt, -0.9, 0.9);
        if (G > q.th + 0.12 * (q.R - 0.5) && openT > 0.5) { if (!q.iot) { q.om += (rnd() - 0.5) * 16; q.tvx += wdx * 4; q.tvy += wdy * 4; } q.iot = 1; q.calmT = T; }   // pop!
        else if (G < q.th * 0.45 && T - q.calmT > 1.4) q.iot = 0;
        q.io += (q.iot - q.io) * (1 - Math.exp(-dt * (q.iot > q.io ? 16 : 2.4)));
        // a storm tears a few out of people's hands
        if (storm > 0.3 && q.io > 0.9 && q.lost < T && st.fly.length < 3 && rnd() < dt * storm * 0.05) {
          q.lost = T + 7 + 6 * rnd(); q.o = 0;
          st.fly.push({ x: q.x, y: q.y, z: 2.2, vx: wdx * 5, vy: wdy * 5, vz: 2.5, cols: q.cols, rim: q.rim, R: q.R, spin: q.spin, om: 9 * (rnd() < 0.5 ? -1 : 1), tx: wdx * 0.6, ty: 0.5, t: T });
        }
        const ot = q.lost > T ? 0 : openT;
        q.o += (ot - q.o) * (1 - Math.exp(-dt * (ot > q.o ? 2.2 : 1.3)));
        // twirls
        for (const t of tp.fresh) {
          if (t.site === q.id) q.om += t.echo ? 2.6 : 11 * (hash(t.seed) < 0.5 ? -1 : 1);
          else if (!t.echo && t.site == null) { const [gx, gy] = st.G(t.x, t.y), d = Math.hypot(gx - q.x, gy - q.y); if (d < 3) { q.om += (3 - d) * 3; q.vx += (q.x - gx) / (d + 0.3) * 1.5; q.vy += (q.y - gy) / (d + 0.3) * 1.5; } }
        }
        q.om *= Math.exp(-dt * 0.7); q.om += (rnd() - 0.5) * storm * 30 * dt; q.spin += q.om * dt;
      }
      // keep a little room between people
      for (let i = 0; i < ppl.length; i++) for (let j = i + 1; j < ppl.length; j++) {
        const A = ppl[i], B = ppl[j], dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) + 1e-6, m = (A.R + B.R) * 0.85 - d;
        if (m > 0) { const f = m * 2.5 * dt / d; A.x -= dx * f; A.y -= dy * f; B.x += dx * f; B.y += dy * f; }
      }
      // ---- draw: the plaza
      c.globalCompositeOperation = 'source-over';
      c.drawImage(fade2(st, 'fb', st.bgN, st.bgD, day), 0, 0, W, H);
      // splashes on the stone
      const spl = new Path2D(), nsp = Math.round((14 + 120 * amt) * W / 1600);
      for (let i = 0; i < nsp; i++) {
        const ph = T / 0.4 + hash(i * 7 + 3), cyc = Math.floor(ph), f = ph - cyc, sd = i * 131 + cyc * 7919;
        P((hash(sd) - 0.5) * 26, -6 + hash(sd + 1) * 16, 0, p); if (p[0] < -10 || p[0] > W + 10 || p[1] < -10 || p[1] > H + 10) continue;
        const r = (0.04 + 0.2 * f) * p[2];
        spl.moveTo(p[0] + r, p[1]); spl.ellipse(p[0], p[1], r, r * 0.82, 0, 0, TAU);
      }
      c.strokeStyle = `rgba(${day > 0.5 ? '255,255,255' : '200,210,235'},${0.16 + 0.1 * storm})`; c.lineWidth = lw * 0.6; c.stroke(spl);
      // ---- each person: the canopy's points in space (tilted with the wind, inside out if it blew), then shadows and paint
      const L = day > 0.5 ? [0.62, 0.42, 0.66] : [-0.55, 0.42, 0.72];
      const lb = fb ? [((fb.u == null ? 0.5 : fb.u) - 0.5) * -1.6, -0.5, 0.75] : null;
      const geo = (q, x, y, zh, ox) => {                        // -> {apex, tips, mids} as [X, Y, Z]
        const o = ox == null ? q.o : ox, io = q.io, R = q.R * (0.14 + 0.86 * o) * (1 + 0.22 * io), zr = 2.05 - (1 - o) * 0.75 * q.R + 0.03 * Math.sin(q.ph * 2);
        const za = zr + q.R * 0.42 * o * (1 - 2 * io), tw = (pt) => { const dz = pt[2] - zh; pt[0] += q.tx * dz; pt[1] += q.ty * dz; pt[2] -= 0.5 * (q.tx * q.tx + q.ty * q.ty) * dz; return pt; };
        const apex = tw([x, y, za]), tips = [], mids = [];
        for (let i = 0; i < 8; i++) {
          const a = q.spin + i * TAU / 8, a2 = a + TAU / 16, j = io * (hash(q.id * 9 + i) - 0.5);
          tips.push(tw([x + Math.cos(a + 0.25 * j) * R * (1 + 0.45 * j), y + Math.sin(a + 0.25 * j) * R * (1 + 0.45 * j), zr - 0.06 * q.R + io * 0.3 * q.R * hash(q.id * 7 + i)]));
          mids.push(tw([x + Math.cos(a2) * R * 0.86, y + Math.sin(a2) * R * 0.86, zr + 0.02 * q.R + io * 0.1 * q.R]));
        }
        return { apex, tips, mids };
      };
      const list = ppl.map(q => { P(q.x, q.y, 2, p); return [p[1], q]; }).sort((a, b) => a[0] - b[0]).map(a => a[1]);
      // shadows: soft pools under each (lamplight), hard shapes by day and in a lightning flash
      const soft = 1 - day;
      if (soft > 0.02) {
        const sp = [new Path2D(), new Path2D()];
        for (const q of list) { P(q.x + 0.25, q.y - 0.2, 0, p); const r = q.R * (0.5 + 0.6 * q.o) * p[2]; sp[0].moveTo(p[0] + r * 1.25, p[1]); sp[0].ellipse(p[0], p[1], r * 1.25, r, 0, 0, TAU); sp[1].moveTo(p[0] + r * 0.8, p[1]); sp[1].ellipse(p[0], p[1], r * 0.8, r * 0.62, 0, 0, TAU); }
        c.fillStyle = `rgba(0,0,0,${0.13 * soft})`; c.fill(sp[0]); c.fill(sp[1]);
      }
      const hard = (Lv, a) => {
        const path = new Path2D();
        for (const q of list) {
          const gq = geo(q, q.x, q.y, 1.1), proj = pt => P(pt[0] - Lv[0] * pt[2] / Lv[2], pt[1] - Lv[1] * pt[2] / Lv[2], 0, p);
          if (q.o > 0.2) { gq.tips.forEach((t, i) => { proj(t); i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1]); }); path.closePath(); }
          proj([q.x, q.y, 1.5]); const ex = p[0], ey = p[1]; P(q.x, q.y, 0, q2);    // the person's own shadow
          path.moveTo(q2[0] + 0.2 * q2[2], q2[1]); path.lineTo(ex + 0.16 * q2[2], ey); path.lineTo(ex - 0.16 * q2[2], ey); path.lineTo(q2[0] - 0.2 * q2[2], q2[1]); path.closePath();
        }
        c.fillStyle = `rgba(20,16,12,${a})`; c.fill(path);
      };
      if (day > 0.02) hard(L, 0.3 * day);
      if (fl > 0.05 && lb) hard(lb, 0.5 * fl);
      // people (seen when the umbrella is closed or gone) and canopies, far ones first
      const seams = new Path2D(), ribs = new Path2D(), caps = new Path2D(), drops = new Path2D();
      const paint = (q, gq, alpha) => {
        const A = P(gq.apex[0], gq.apex[1], gq.apex[2], [0, 0, 0]), tips = gq.tips.map(t => P(t[0], t[1], t[2], [0, 0, 0])), mids = gq.mids.map(t => P(t[0], t[1], t[2], [0, 0, 0]));
        const Lx = L[0] * (1 - fl) + (lb ? lb[0] : 0) * fl, Ly = L[1], Lz = L[2];
        c.globalAlpha = alpha;
        for (let i = 0; i < 8; i++) {
          const t0 = gq.tips[i], t1 = gq.tips[(i + 1) % 8], ap = gq.apex;
          const ax = t0[0] - ap[0], ay = t0[1] - ap[1], az = t0[2] - ap[2], bx = t1[0] - ap[0], by = t1[1] - ap[1], bz = t1[2] - ap[2];
          let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; const nm = Math.hypot(nx, ny, nz) + 1e-9; nx /= nm; ny /= nm; nz /= nm;
          const under = q.io > 0.5, d = Math.max(0, nx * Lx + ny * Ly + nz * Lz);          // inside out: we look into the cup, at the lining
          const lit = (under ? 0.26 + 0.4 * d : 0.38 + 0.78 * d) * (0.74 + 0.26 * day) + 0.5 * fl, col = q.cols[i];
          c.fillStyle = `rgb(${Math.min(255, col[0] * lit) | 0},${Math.min(255, col[1] * lit) | 0},${Math.min(255, col[2] * lit) | 0})`;
          c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(tips[i][0], tips[i][1]); c.quadraticCurveTo(mids[i][0], mids[i][1], tips[(i + 1) % 8][0], tips[(i + 1) % 8][1]); c.closePath(); c.fill();
          seams.moveTo(A[0], A[1]); seams.lineTo(tips[i][0], tips[i][1]);
          if (q.io > 0.3) { ribs.moveTo(A[0], A[1]); ribs.lineTo(tips[i][0], tips[i][1]); }
          caps.rect(tips[i][0] - 1.1, tips[i][1] - 1.1, 2.2, 2.2);
        }
        if (q.rim) {                                           // the black ones: a coloured rim
          c.strokeStyle = `rgb(${q.rim})`; c.lineWidth = Math.max(1.1, 0.026 * A[2]); c.beginPath();
          for (let i = 0; i <= 8; i++) { const t = tips[i % 8]; if (!i) c.moveTo(t[0], t[1]); else c.quadraticCurveTo(mids[i - 1][0], mids[i - 1][1], t[0], t[1]); }
          c.stroke();
        }
        c.fillStyle = day > 0.5 ? 'rgba(250,246,238,0.95)' : 'rgba(220,214,206,0.9)'; c.beginPath(); c.arc(A[0], A[1], Math.max(1.6, 0.05 * A[2]), 0, TAU); c.fill();
        c.globalAlpha = 1;
        // rain landing on it
        if (amt > 0.02 && alpha > 0.5) for (let n = 0, m = Math.round(amt * (1.5 + 2 * q.k)); n < m; n++) {
          const i = Math.floor(rnd() * 8), f = rnd() * 0.85; const x = A[0] + (tips[i][0] - A[0]) * f, y = A[1] + (tips[i][1] - A[1]) * f, d = 1.2 + 1.4 * rnd();
          drops.rect(x - d / 2, y - d / 2, d, d);
        }
      };
      for (const q of list) {
        // the person underneath: shoulders and head, the closed umbrella at their side
        const vis = 1 - smoothstep(0.15, 0.6, q.o);
        if (vis > 0.01) {
          P(q.x, q.y, 1.45, p); const k = p[2], ch = Math.cos(q.hd), shh = Math.sin(q.hd), sw = Math.sin(q.ph) * 0.06;
          c.globalAlpha = vis;
          c.fillStyle = `rgb(${q.coat})`; c.beginPath(); c.ellipse(p[0], p[1], 0.3 * k, 0.15 * k, q.hd + Math.PI / 2, 0, TAU); c.fill();
          c.fillStyle = `rgb(${q.hair})`; P(q.x + ch * 0.04, q.y + shh * 0.04, 1.7, q2); c.beginPath(); c.arc(q2[0], q2[1], 0.12 * q2[2], 0, TAU); c.fill();
          if (q.lost < T) {                                  // the closed umbrella, swinging at their side
            const sx = q.x - shh * 0.3 + ch * sw, sy = q.y + ch * 0.3 + shh * sw;
            P(sx, sy, 0.95, p); P(sx + ch * 0.62, sy + shh * 0.62, 0.2, q2);
            const ux = q2[0] - p[0], uy = q2[1] - p[1], ul = Math.hypot(ux, uy) + 1e-6, nx = -uy / ul * 0.07 * p[2], ny = ux / ul * 0.07 * p[2];
            c.fillStyle = `rgb(${q.cols[0].map(v => v * 0.85 | 0)})`; c.beginPath(); c.moveTo(p[0] - ux * 0.1, p[1] - uy * 0.1);
            c.quadraticCurveTo(p[0] + ux * 0.3 + nx, p[1] + uy * 0.3 + ny, q2[0], q2[1]); c.quadraticCurveTo(p[0] + ux * 0.3 - nx, p[1] + uy * 0.3 - ny, p[0] - ux * 0.1, p[1] - uy * 0.1); c.fill();
          }
          c.globalAlpha = 1;
        }
        if (q.o > 0.15) paint(q, geo(q, q.x, q.y, 1.1), smoothstep(0.15, 0.5, q.o));
      }
      c.lineWidth = lw * 0.45; c.strokeStyle = 'rgba(0,0,0,0.22)'; c.stroke(seams);
      c.strokeStyle = 'rgba(232,232,240,0.9)'; c.lineWidth = lw * 1.1; c.stroke(ribs);
      c.fillStyle = 'rgba(240,236,230,0.7)'; c.fill(caps);
      c.fillStyle = `rgba(235,242,255,${0.55 + 0.2 * storm})`; c.fill(drops);
      // umbrellas the storm tore away, tumbling off downwind
      st.fly = st.fly.filter(f => {
        f.vx += (wdx * 7 - f.vx) * dt * 0.8; f.vy += (wdy * 7 - f.vy) * dt * 0.8; f.vz += (-1.2 + 2 * Math.sin(T * 3 + f.t)) * dt;
        f.x += f.vx * dt; f.y += f.vy * dt; f.z = Math.max(0.6, f.z + f.vz * dt); f.spin += f.om * dt; f.tx = 0.8 * Math.sin(T * 2.3 + f.t); f.ty = 0.8 * Math.cos(T * 1.9 + f.t);
        const q = { id: 999, R: f.R, o: 1, io: 0.6 + 0.4 * Math.sin(T * 4 + f.t), tx: f.tx, ty: f.ty, spin: f.spin, ph: 0, cols: f.cols, rim: f.rim, k: 0 };
        paint(q, geo(q, f.x, f.y, f.z - 1), 1);
        P(f.x, f.y, f.z, p); return p[0] > -200 && p[0] < W + 200 && p[1] > -200 && p[1] < H + 200 && T - f.t < 12;
      });
      // ---- the rain itself, falling past the window
      const rain = new Path2D(), nr = Math.round((40 + 700 * amt) * W / 1600 * (0.4 + 0.6 * (E.pts.length ? 1 : 0.6)));
      const slx = wdx * (0.25 + 1.2 * e + 0.8 * storm), sly = wdy * (0.25 + 1.2 * e + 0.8 * storm);
      for (let i = 0; i < nr; i++) {
        const z = 9 - ((T * 9 + hash(i * 3 + 3) * 9) % 9), X = (hash(i * 3 + 1) - 0.5) * 30 + slx * (9 - z) * 0.3, Y = -6 + hash(i * 3 + 2) * 18 + sly * (9 - z) * 0.3;
        P(X, Y, z, p); P(X - slx * 0.12, Y - sly * 0.12, z + 0.55, q2);
        if (p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
        rain.moveTo(q2[0], q2[1]); rain.lineTo(p[0], p[1]);
      }
      c.strokeStyle = day > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(200,214,240,0.3)'; c.lineWidth = lw * 0.6; c.stroke(rain);
      // the lamp heads (lit at night) and the trees' crowns
      for (const [x, y] of st.lamps) {
        P(x, y, 5.2, p); const k = p[2];
        c.fillStyle = day > 0.5 ? '#3a3a40' : '#0c0c10'; c.beginPath(); c.arc(p[0], p[1], 0.17 * k, 0, TAU); c.fill();
        if (day < 0.98) { c.globalAlpha = 1 - day; c.drawImage(glow('255,200,140', 64, 0.3), p[0] - 0.7 * k, p[1] - 0.7 * k, 1.4 * k, 1.4 * k); c.fillStyle = '#ffe9c8'; c.beginPath(); c.arc(p[0], p[1], 0.09 * k, 0, TAU); c.fill(); c.globalAlpha = 1; }
      }
      for (const t of st.trees) {
        const sw = (wdx * (e + storm) * 0.025 + 0.004 * Math.sin(T * 0.7 + t.r)) * t.r, z = t.r * 2.3;
        if (day < 0.996) c.drawImage(t.n, t.x - z / 2 + sw, t.y - z / 2, z, z);
        if (day > 0.004) { c.globalAlpha = day; c.drawImage(t.d, t.x - z / 2 + sw, t.y - z / 2, z, z); c.globalAlpha = 1; }
      }
      if (fl > 0.02) { c.fillStyle = `rgba(236,240,255,${0.38 * fl})`; c.fillRect(0, 0, W, H); }
    },
  };

  return [murm, umbrellas];
})();
