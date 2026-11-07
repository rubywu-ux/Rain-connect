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

  /* ============================================================== 3  Marbling
     Ebru, Turkish paper marbling, seen from above: ink floats on a bath and every new drop pushes all the
     ink before it outward into rings and veins (the exact mathematics of marbling: the ink keeps its area
     and never blurs). Every raining place drops ink at its own spot again and again: heavier rain = bigger
     drops, more often; the colour comes from the kind of rain and the latitude (drizzle: aqua and celadon,
     a sprinkle of small drops; rain: teal and emerald in the tropics, cobalt in the middle latitudes,
     violet toward the poles; showers: saffron, coral and rose, in bursts of rings; thunderstorms: crimson
     and ink black with a white vein), and now and then clear size water rings a drop in ivory. A breath
     is the marbler's comb: one stroke of tines drawn through the bath in the direction it blows, around
     where the mist moved, pulling the rings into feathers (a long breath draws the next stroke between the
     lines of the last). A storm stirs the bath into whirlpools that twist and untwist; lightning leaves a
     jagged chain of white drops. Calm, the drops come slowly and the bath rests like a finished print.
     A tap drops gold where it lands (on a raining place: a bull's-eye of rings). Each drop is an outline
     moved exactly, filled on a smaller canvas; the bath holds a budget of drops and outline points. */
  const MARB_IVORY = [246, 238, 220], MARB_GOLD = [240, 182, 46], NVB = 7500, MAXD = 120;   // how many outline points and drops the bath may hold
  function marbInk(kind, lat, h) {                 // the ink a place drops: by its kind of rain, then its latitude
    const a = Math.abs(lat), pick = L => L[Math.floor(h * L.length) % L.length];
    if (kind === 0) return pick([[86, 194, 204], [146, 208, 180], [120, 172, 232], [190, 226, 220]]);
    if (kind === 2) return pick([[246, 172, 28], [240, 104, 66], [222, 58, 108], [250, 136, 40]]);
    if (kind === 3) return pick([[172, 18, 46], [30, 22, 42], [108, 22, 84]]);
    return a < 23 ? pick([[0, 134, 146], [16, 150, 108], [0, 112, 170]]) : a < 50 ? pick([[26, 70, 184], [46, 50, 156], [18, 98, 198]]) : pick([[104, 66, 180], [58, 46, 124], [150, 98, 204]]);
  }
  /* the ink moves: drops spreading (each [x, y, added r^2]) and the comb / the whirlpools, for every vertex */
  function marbMove(st, ev, comb, vort) {
    const ne = ev.length, nv = vort ? vort.length : 0;
    for (const d of st.drops) {
      const p = d.p;
      for (let i = 0; i < p.length; i += 2) {
        let x = p[i], y = p[i + 1];
        for (let j = 0; j < ne; j += 3) {
          const dx = x - ev[j], dy = y - ev[j + 1], u = ev[j + 2] / (dx * dx + dy * dy + 1e-6), f = u < 0.004 ? 1 + u * 0.5 : Math.sqrt(1 + u);
          x = ev[j] + dx * f; y = ev[j + 1] + dy * f;
        }
        if (comb) {                                   // tines along M, spaced S across: a shear that keeps area
          const sN = (x - comb.bx) * comb.nx + (y - comb.by) * comb.ny, band = sN * sN * comb.iB;
          if (band < 5) {
            const dd = Math.abs(sN - comb.S * (Math.round(sN / comb.S - comb.o) + comb.o)), m = comb.v * Math.exp(-band) * (Math.exp(-dd * comb.ic) - comb.m0);   // the ink between the tines flows back: nothing is carried off
            x += m * comb.mx; y += m * comb.my;
          }
        }
        for (let j = 0; j < nv; j += 4) {             // whirlpools: a turn that fades with the distance
          const dx = x - vort[j], dy = y - vort[j + 1], k = (dx * dx + dy * dy) * vort[j + 3];
          if (k > 8) continue;
          const a = vort[j + 2] * Math.exp(-k), ca = Math.cos(a), sa = Math.sin(a); x = vort[j] + dx * ca - dy * sa; y = vort[j + 1] + dx * sa + dy * ca;
        }
        p[i] = x; p[i + 1] = y;
      }
    }
  }
  /* keep the outlines smooth and light: a point where an edge has stretched (straight runs may keep longer edges),
     none where two crowd or where a point lies on the line through its neighbours; note each drop's bounds */
  function marbTidy(st, W, H, T) {
    const mx = W * 0.1, my = H * 0.1;
    let tot = 0;
    for (const d of st.drops) {
      const p = d.p, n = p.length >> 1, o = [], fix = d.till > T || n < 17;     // (not while a new drop is still spreading from a speck)
      const sg = st.sig * clamp(n / 700, 1, 3), L = st.Lmax * sg, L2 = L * L, Ls2 = L2 * 9, lm = st.Lmin * sg, l2 = lm * lm, e2 = Math.pow(0.12 * sg, 2);   // a very long outline is kept coarser
      let lx = p[p.length - 2], ly = p[p.length - 1], x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, tx = 0, ty = 0;
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i], y = p[i + 1], dx = x - lx, dy = y - ly, l = dx * dx + dy * dy;
        const j = i + 2 < p.length ? i + 2 : 0, ax = p[j] - lx, ay = p[j + 1] - ly, la = ax * ax + ay * ay;
        if (!fix && i > 0) {
          if (l < l2) continue;
          if (la < Ls2) { const cr = dx * ay - dy * ax; if (cr * cr < e2 * la) continue; }
        }
        if (l > L2) {
          // straight here (the edge runs on in the direction it came, and on to the next point)? then it may stay longer
          const lt = Math.hypot(tx, ty) * Math.sqrt(l), st1 = lt > 0 ? (tx * dx + ty * dy) / lt : 0, bx = p[j] - x, by = p[j + 1] - y, lb = Math.sqrt((bx * bx + by * by) * l), st2 = lb > 0 ? (bx * dx + by * dy) / lb : 0;
          const lim = st1 > 0.995 && st2 > 0.995 ? Ls2 : L2;
          if (l > lim) {
            const near = (x > -mx && x < W + mx && y > -my && y < H + my) || (lx > -mx && lx < W + mx && ly > -my && ly < H + my);
            if (near || l > L2 * 36) { const k = Math.min(24, Math.ceil(Math.sqrt(l / lim)) - 1); for (let q = 1; q <= k; q++) { const t = q / (k + 1); o.push(lx + dx * t, ly + dy * t); } }
          }
        }
        o.push(x, y); tx = dx; ty = dy; lx = x; ly = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      d.p = o; d.bb = [x0, y0, x1, y1]; tot += o.length >> 1;
    }
    st.nv = tot;
  }
  /* which drops still show: the ink drawn small, one flat colour per drop, counted. A ring stretched thinner
     than a few pixels (or buried) fades away, which keeps the outlines to a budget */
  function marbSeen(st, W, H, T) {
    const w = Math.round(W / 5), h = Math.round(H / 5), D = st.drops;
    if (!st.idc || st.idc.width !== w || st.idc.height !== h) { st.idc = canvas(w, h); st.idx = st.idc.getContext('2d', { willReadFrequently: true }); }
    const g = st.idx;
    g.setTransform(w / W, 0, 0, h / H, 0, 0); g.globalAlpha = 1; g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < D.length; i++) {
      const p = D[i].p, k = i + 1;
      g.fillStyle = `rgb(${k & 255},${k >> 8},0)`; g.beginPath(); g.moveTo(p[0], p[1]);
      for (let j = 2; j < p.length; j += 2) g.lineTo(p[j], p[j + 1]);
      g.fill();
    }
    const px = g.getImageData(0, 0, w, h).data, cnt = new Uint16Array(D.length + 2);
    for (let i = 0; i < px.length; i += 4) { const k = px[i] | (px[i + 1] << 8); if (k <= D.length) cnt[k]++; }
    for (let i = 0; i < D.length; i++) { D[i].vis = cnt[i + 1]; if (cnt[i + 1] < 2 && T - D[i].t0 > 2.5 && D[i].fade == null) D[i].fade = T; }
    st.seenAt = st.n;
  }
  function marbLight(W, H, dpr, day) {             // the light on the bath, laid over the ink
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (day) {
      for (let i = 0; i < 12000; i++) { g.fillStyle = `rgba(${hash(i * 5 + 4) < 0.5 ? '255,250,236' : '90,70,40'},${0.03 + 0.06 * hash(i * 5 + 1)})`; g.fillRect(hash(i * 5 + 2) * W, hash(i * 5 + 3) * H, 1.2, 1.2); }
      let gr = g.createRadialGradient(W * 0.35, H * 0.3, 0, W * 0.35, H * 0.3, W * 0.8);
      gr.addColorStop(0, 'rgba(255,252,240,0.16)'); gr.addColorStop(1, 'rgba(255,252,240,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      gr.addColorStop(0, 'rgba(120,96,60,0)'); gr.addColorStop(1, 'rgba(120,96,60,0.22)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    } else {
      let gr = g.createRadialGradient(W * 0.3, H * 0.22, 0, W * 0.3, H * 0.22, W * 0.55);
      gr.addColorStop(0, 'rgba(255,236,206,0.13)'); gr.addColorStop(0.5, 'rgba(255,236,206,0.04)'); gr.addColorStop(1, 'rgba(255,236,206,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
      gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.58);
      gr.addColorStop(0, 'rgba(2,3,10,0)'); gr.addColorStop(1, 'rgba(2,3,10,0.62)'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    return cv;
  }
  const marbling = {
    name: 'marbling', title: 'Marbling', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, W, H, st, storm, e } = E, dt = Math.min(E.dt, 1 / 30), calm = calmOf(E), wx = windX(E), wy = windY(E), sk = W / 1600;
      if (st.W !== W || st.H !== H || !st.g) {
        st.W = W; st.H = H; st.q = Math.min(1, 600 / W);
        st.cv = canvas(W * st.q, H * st.q); st.g = st.cv.getContext('2d');
        st.Lmax = 10 * sk + 3; st.Lmin = 2.4 * sk + 0.6;
        st.drops = []; st.grow = []; st.pend = []; st.rings = []; st.next = new Map(); st.nv = 0; st.n = 0; st.seenAt = 0; st.sig = 1;
        st.bath = E.light ? [234, 226, 208] : [20, 24, 54]; st.lD = marbLight(W, H, E.dpr, true); st.lN = marbLight(W, H, E.dpr, false);
        st.vort = [0, 1, 2].map(i => ({ sd: i * 7.3 + 1, sg: i % 2 ? -1 : 1 }));
        st.seeded = false;
      }
      const day = dayOf(st, E), g = st.g;
      // the places: where each drops, its ink, how big
      let sites = E.sites;
      if (!sites.length) sites = st.idle || (st.idle = Array.from({ length: 9 }, (_, i) => ({ id: 90000 + i, u: hash(i * 3 + 1), v: 0.25 + 0.5 * hash(i * 3 + 2), k: 0.25 + 0.4 * hash(i * 3 + 3) })));
      const spot = z => [W * (0.06 + 0.88 * z.u), H * (0.08 + 0.84 * hash(z.id * 7 + 3))];
      const inkOf = z => { const m = st.ink || (st.ink = new Map()); let q = m.get(z.id); if (!q) m.set(z.id, q = marbInk(z.id >= 90000 ? 1 : kindOf(E, z), latOf(z), hash(z.id * 5 + 1))); return q; };
      const sizeOf = z => (20 + 56 * z.k) * sk * 1.25;
      const circle = (x, y, r, r0) => { const n = clamp(Math.ceil(TAU * r / (st.Lmax * 0.8)), 18, 240), p = new Array(n * 2); for (let i = 0; i < n; i++) { const a = i / n * TAU; p[2 * i] = x + Math.cos(a) * r0; p[2 * i + 1] = y + Math.sin(a) * r0; } return p; };
      const add = (x, y, r, rgb, dur) => {               // a drop lands: a speck of ink that spreads to radius r
        st.drops.push({ p: circle(x, y, r, 0.5), c: `rgb(${rgb})`, rgb, a: 1, t0: T, till: T + dur + 0.2, bb: [x - r, y - r, x + r, y + r] });
        st.grow.push({ x, y, r2: r * r, done: 0, t0: T, dur });
        if (st.rings.length < 80) st.rings.push({ x, y, r, t: T });
      };
      const dropAt = (z, delay = 0) => {                 // one place drops: a little pattern by its kind of rain
        const [x0, y0] = spot(z), k = z.k, kind = z.id >= 90000 ? 1 : kindOf(E, z), rgb = inkOf(z);
        const r = sizeOf(z) * (1 + 0.35 * storm), j = r * 0.8, dur = (0.5 + 0.5 * k) * (1 + 0.9 * calm);
        const x = x0 + (rnd() - 0.5) * j, y = y0 + (rnd() - 0.5) * j, t = T + delay, P = st.pend;
        if (kind === 0) { for (let i = 0; i < 3; i++) P.push([t + i * 0.1, x + (rnd() - 0.5) * r * 2.4, y + (rnd() - 0.5) * r * 2.4, r * (0.4 + 0.15 * rnd()), rgb, dur * 0.6]); }
        else if (kind === 2) { P.push([t, x, y, r, rgb, dur]); P.push([t + 0.4, x, y, r * 0.5, MARB_IVORY, dur * 0.7]); P.push([t + 0.65, x, y, r * 0.42, rgb, dur * 0.7]); }
        else if (kind === 3) { P.push([t, x, y, r * 1.25, rgb, dur]); P.push([t + 0.45, x, y, r * 0.32, MARB_IVORY, dur * 0.6]); }
        else { P.push([t, x, y, r, rgb, dur]); if (rnd() < 0.15) P.push([t + 0.5, x, y, r * 0.38, MARB_IVORY, dur * 0.6]); }
      };
      // ---- the bath before the first look: the marbler has been at work a while
      if (!st.seeded) {
        st.seeded = true;
        const tw = sites.reduce((a, z) => a + 0.2 + z.k * z.k, 0);
        let area = 0;
        for (let i = 0; area < W * H * 1.7 && i < 120; i++) {
          let w = rnd() * tw, z = sites[0];
          for (const o of sites) { w -= 0.2 + o.k * o.k; if (w <= 0) { z = o; break; } }
          const [x0, y0] = spot(z), iv = i % 9 === 8, r = sizeOf(z) * (iv ? 0.4 : i < 40 ? 1.7 : 1.15), x = x0 + (rnd() - 0.5) * r * 0.8, y = y0 + (rnd() - 0.5) * r * 0.8;
          const rgb = iv ? MARB_IVORY : inkOf(z);
          marbMove(st, [x, y, r * r], null, null);
          st.drops.push({ p: circle(x, y, r, r), c: `rgb(${rgb})`, rgb, a: 1, t0: T - 10, bb: [x - r, y - r, x + r, y + r] });
          area += Math.PI * r * r;
          if (i % 3 === 2) { marbTidy(st, W, H, T); st.drops = st.drops.filter(d => d.bb[2] > 0 && d.bb[0] < W && d.bb[3] > 0 && d.bb[1] < H); }
        }
        marbTidy(st, W, H, T); marbSeen(st, W, H, T); st.drops = st.drops.filter(d => d.fade == null);
      }
      st.n++;
      // ---- drops: every raining place at its own pace (more places and heavier rain = more ink)
      const amt = (0.1 + 0.9 * (1 - calm)) * (1 + 1.4 * storm) * (1 + 0.3 * e);
      let sum = 0; for (const z of sites) sum += 0.05 + 0.35 * z.k * z.k;
      const sc = Math.min(1, 3.6 / Math.max(0.01, sum)) * amt;
      for (const z of sites) {
        const nx = st.next.get(z.id);
        if (nx == null) { st.next.set(z.id, T + rnd() * 3); continue; }
        if (T < nx) continue;
        st.next.set(z.id, T + (0.5 + rnd()) / Math.max(0.02, (0.05 + 0.35 * z.k * z.k) * sc));
        dropAt(z);
      }
      // ---- taps: gold where it lands; on a raining place a bull's-eye there (the wall's own soft notes: a small ivory drop)
      for (const q of tapsOf(R, E).fresh) {
        const z = q.site != null ? sites.find(o => o.id === q.site) : null;
        if (z) { const [x, y] = spot(z), r = (34 + 30 * z.k) * sk * 1.3 * (q.echo ? 0.5 : 1), ink = inkOf(z);
          [MARB_GOLD, ink, MARB_IVORY, ink, MARB_GOLD].forEach((col, i) => st.pend.push([T + i * (q.echo ? 0.3 : 0.16), x, y, r * (1 - 0.15 * i), col, 0.5])); }
        else if (q.echo) st.pend.push([T, q.x, q.y, 14 * sk, MARB_IVORY, 0.5]);
        else { st.pend.push([T, q.x, q.y, 50 * sk, MARB_GOLD, 0.45]); st.pend.push([T + 0.25, q.x, q.y, 22 * sk, MARB_IVORY, 0.4]); }
      }
      // ---- lightning: a jagged chain of white drops down its path, and the flash
      for (const b of newBolts(R, st, T)) {
        const sd = b.seed | 0; let x = (b.u == null ? 0.5 : b.u) * W, y = -10;
        for (let i = 0; y < H + 20; i++) { x += (hash(sd + i * 3) - 0.5) * 130 * sk; y += (36 + 46 * hash(sd + i * 3 + 1)) * sk; st.pend.push([T + i * 0.03, x, y, (10 + 10 * hash(sd + i * 3 + 2)) * sk * (0.5 + (b.power || 0.7)), i % 3 ? [255, 255, 255] : MARB_IVORY, 0.25]); }
      }
      st.pend = st.pend.filter(p => { if (T < p[0]) return true; add(p[1], p[2], p[3], p[4], p[5]); return false; });
      // ---- move the ink: the drops spreading, the comb (breath) and the whirlpools (storm)
      const ev = [];
      st.grow = st.grow.filter(gw => { const t = Math.min(1, (T - gw.t0) / gw.dur), f = 1 - Math.pow(1 - t, 3), d = gw.r2 * f - gw.done; if (d > 0) { ev.push(gw.x, gw.y, d); gw.done += d; } return t < 1; });
      // the comb: a breath draws it one stroke through the bath (a fixed length), then it lifts; a longer breath draws
      // the next stroke between the lines of the last one (as a marbler does), so the feathers get finer, not wilder
      let comb = null;
      const cs = st.cs || (st.cs = { d: 0, off: 0, rest: 0 }), D = 150 * sk;
      const eb = smoothstep(0.12, 0.45, e);                             // a real breath, not the mist stirring on its own
      if (eb > 0 && T > cs.rest) {
        if (Math.abs(wx) > 0.1) st.dir = Math.sign(wx);
        let mx = Math.abs(wx) > 0.1 || Math.abs(wy) < 0.15 ? (Math.abs(wx) > 0.1 ? wx : (st.dir || 1)) : 0, my = wy * 0.6; const l = Math.hypot(mx, my) || 1; mx /= l; my /= l;
        const S = 46 * sk, cc = 9 * sk, m0 = 2 * cc / S * (1 - Math.exp(-S / (2 * cc))), v = Math.min(D - cs.d, (240 + 160 * e) * sk * eb * dt / st.sig);
        if (cs.d === 0) { cs.bx = (0.5 + 0.4 * clamp(E.mx, -1, 1)) * W; cs.by = (0.5 + 0.4 * clamp(E.my, -1, 1)) * H; cs.mx = mx; cs.my = my; }
        comb = { bx: cs.bx, by: cs.by, mx: cs.mx, my: cs.my, nx: -cs.my, ny: cs.mx, S, ic: 1 / cc, iB: 1 / Math.pow(0.26 * H, 2), m0, v: v / (1 - m0), o: cs.off };
        cs.d += v;
        if (cs.d >= D - 0.01) { cs.d = 0; cs.rest = T + 1.2; cs.off = (cs.off + 0.5) % 1; }
      } else if (eb === 0 && cs.d > 0 && T > cs.rest) { cs.d = 0; cs.off = (cs.off + 0.5) % 1; }
      let vort = null;
      if (storm > 0.04) {
        vort = [];
        const sg = Math.min(W, H) * 0.28;
        for (const v of st.vort) vort.push(W * (0.5 + 0.38 * vnoise(T * 0.05, v.sd)), H * (0.5 + 0.38 * vnoise(v.sd, T * 0.045)), v.sg * (1.2 + 1.8 * storm) * storm * Math.sin(T * 0.9 + v.sd) * dt / st.sig, 1 / (sg * sg));   // they twist and untwist
      }
      if (ev.length || comb || vort) marbMove(st, ev, comb, vort);
      if (ev.length || comb || vort || st.n % 10 === 0) marbTidy(st, W, H, T);
      // ---- what goes: drops pushed off screen and rings too thin to see; past the budget, the drop that shows least
      //      (outlines grow coarser while there are too many points)
      st.drops = st.drops.filter(d => d.bb[2] > 0 && d.bb[0] < W && d.bb[3] > 0 && d.bb[1] < H && !(d.fade != null && T - d.fade > 0.8));
      st.sig = clamp(st.sig + (st.nv > NVB ? (st.nv / NVB - 1) * 3 : st.nv < NVB * 0.75 ? -0.25 : 0) * dt, 1, 2);
      if (st.n - st.seenAt >= 30) marbSeen(st, W, H, T);
      let live = 0; for (const d of st.drops) if (d.fade == null) live++;
      while (live > MAXD) {                                              // too many: the drop that shows least fades away
        let w = null; for (const d of st.drops) if (d.fade == null && d.vis != null && T - d.t0 > 3 && (!w || d.vis < w.vis)) w = d;
        if (!w) break; w.fade = T; live--;
      }
      if (st.nv > NVB * 1.9 && !(st.cut > T)) {                         // far too many points: the costliest old drop goes
        let w = null; for (const d of st.drops) if (d.fade == null && T - d.t0 > 3 && (!w || d.p.length > w.p.length)) w = d;
        if (w) { w.fade = T; st.cut = T + 0.15; }
      }
      // ---- paint the ink (on a smaller canvas, drawn up); when that is slow (a combed bath), every other frame
      const q = st.q, t0 = performance.now(), redo = !(st.rt > 5.5 && st.n % 2 && !E.fresh);
      if (redo) {
        g.setTransform(q, 0, 0, q, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
        g.fillStyle = `rgb(${st.bath})`; g.fillRect(0, 0, W, H);
        for (const d of st.drops) {
          const p = d.p;
          g.globalAlpha = d.fade == null ? 1 : Math.max(0, 1 - (T - d.fade) / 0.8); g.fillStyle = d.c; g.beginPath(); g.moveTo(p[0], p[1]);
          for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
          g.fill();
        }
        g.globalAlpha = 1;
      }
      c.globalCompositeOperation = 'source-over'; c.imageSmoothingEnabled = true;
      c.drawImage(st.cv, 0, 0, W, H);
      if (redo) st.rt = st.rt == null ? 3 : st.rt * 0.8 + (performance.now() - t0) * 0.2;
      // ---- the surface: a ring of water runs out from each new drop, catching the light
      const rc = day > 0.5 ? '255,255,255' : '255,240,220', RB = [new Path2D(), new Path2D()];
      st.rings = st.rings.filter(o => T - o.t < 0.9);
      for (const o of st.rings) { const a = (T - o.t) / 0.9, r = o.r * (0.4 + 1.6 * Math.sqrt(a)), P = RB[a < 0.4 ? 1 : 0]; P.moveTo(o.x + r, o.y); P.arc(o.x, o.y, r, 0, TAU); }
      c.lineWidth = Math.max(1, 1.4 * sk); c.strokeStyle = `rgba(${rc},0.16)`; c.stroke(RB[0]); c.strokeStyle = `rgba(${rc},0.32)`; c.stroke(RB[1]);
      c.drawImage(fade2(st, 'fl', st.lN, st.lD, day), 0, 0, W, H);
      const [fl] = flicker(R, T);
      if (fl > 0.02) { c.fillStyle = `rgba(255,255,255,${0.32 * fl})`; c.fillRect(0, 0, W, H); }
    },
  };

  /* ============================================================== 4  Cymatics
     A Chladni plate in a dark studio: a round black plate dusted with fine white sand, set out in the rain
     under a spotlight, and the rain plays it. The raining places take turns (east to west): a drop from
     that place strikes the plate and it rings with that place's own note, and the sand dances off the
     parts that shake and gathers on the still lines, drawing the note's figure. The figure comes from the
     place: drizzle rings fine lace, rain a square figure, showers a rosette, a thunderstorm a dense star;
     heavier rain = a deeper note (bigger, bolder figure) that rings longer; the light under the plate takes
     the colour of the kind of rain. More raining places = more drops striking the plate and more sand. A
     breath blows the sand across and off the plate, away from the side it came from (fresh sand is sifted
     back on after); a storm sets the plate ringing wildly, note over note, the sand leaping; lightning
     makes every grain jump and the plate boom. Calm, one pure figure holds and the sand settles into it,
     sharp. A tap strikes the plate where it lands (on a raining place: its note rings). */
  const CYM_COL = [[90, 224, 236], [92, 140, 255], [255, 170, 64], [200, 110, 255]];   // the light of a note: drizzle, rain, showers, thunderstorm
  function cymSpec(z, kind) {                     // a place's note: which figure the plate rings in (the second ring shares the first one's symmetry)
    const h1 = hash(z.id * 3 + 11), h2 = hash(z.id * 3 + 12), h3 = hash(z.id * 3 + 13), lo = Math.round(1.6 * (1 - z.k));   // heavier rain: a lower note
    const M = (m, n, w) => ({ m, n, w });
    let modes, m;
    if (kind === 0) { m = 6 + Math.floor(h1 * 4); modes = [M(m, 2 + lo + Math.floor(h2 * 2), 1), M(0, 4 + lo, 0.28)]; }                       // drizzle: fine lace
    else if (kind === 2) { m = 3 + Math.floor(h1 * 3); modes = [M(m, 1 + lo, 1), M(2 * m, 1 + lo, 0.42), M(0, 2 + lo, 0.15)]; }             // showers: a rosette
    else if (kind === 3) { m = 4 + Math.floor(h1 * 3); modes = [M(m, 2 + lo, 1), M(2 * m, 2 + lo, 0.5), M(0, 3 + lo, 0.22)]; }              // thunderstorms: a dense star
    else { m = 2 + Math.floor(h1 * 4); modes = [M(m, 1 + lo + Math.floor(h2 * 2), 1), M(0, 2 + lo + Math.floor(h3 * 2), 0.35)]; }          // rain: rings and spokes
    return { modes, rot: (h2 + z.u) * TAU, kind };
  }
  /* Bessel J_m(x) on a table (the shape of a ring of a round plate) */
  function besselJ(m, x) {
    let s = 0, t = Math.pow(x / 2, m); for (let k = 1; k <= m; k++) t /= k;
    for (let k = 0; k < 60; k++) { s += t; t *= -(x * x / 4) / ((k + 1) * (k + 1 + m)); if (Math.abs(t) < 1e-9 && k > x) break; }
    return s;
  }
  function cymField(sp, G) {                      // the plate's shape of vibration on a G x G grid over [-1, 1]^2, scaled to |max| = 1
    const f = new Float32Array(G * G), tabs = sp.modes.map(o => { const a = (o.n + o.m / 2 + 0.75) * Math.PI, tb = new Float32Array(257); for (let i = 0; i <= 256; i++) tb[i] = besselJ(o.m, a * i / 256); return tb; });
    let mx = 1e-6;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const X = i / (G - 1) * 2 - 1, Z = j / (G - 1) * 2 - 1, r = Math.min(1, Math.hypot(X, Z)), th = Math.atan2(Z, X) + sp.rot;
      let v = 0;
      sp.modes.forEach((o, k) => { v += o.w * Math.cos(o.m * th) * tabs[k][Math.round(r * 256)]; });
      f[j * G + i] = v; if (Math.abs(v) > mx && Math.hypot(X, Z) <= 1) mx = Math.abs(v);
    }
    for (let i = 0; i < f.length; i++) f[i] /= mx;
    return f;
  }
  function cymScene(st, W, H, dpr, day) {         // the studio, and the plate, drawn once (night: black plate under a spot; day: brass in daylight)
    const bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d'), P = st.P, p = [0, 0, 0];
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, H);
    if (day) { gr.addColorStop(0, '#f2f1ed'); gr.addColorStop(0.6, '#e6e4de'); gr.addColorStop(1, '#d2cfc7'); }
    else { gr.addColorStop(0, '#040406'); gr.addColorStop(0.6, '#07070a'); gr.addColorStop(1, '#0b0a0d'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    P(0, 0, 0, p); const cx = p[0], cy = p[1], rx = st.Rp;
    if (!day) {                                   // the spotlight: a soft cone of light from above, a little dust in it
      g.save(); g.globalCompositeOperation = 'lighter';
      for (let k = 0; k < 14; k++) {
        const f = 1 - k / 14, wT = W * 0.03 * f, wB = rx * 1.15 * f;
        gr = g.createLinearGradient(0, -H * 0.05, 0, cy + rx * 0.2);
        gr.addColorStop(0, 'rgba(255,238,212,0.022)'); gr.addColorStop(1, 'rgba(255,238,212,0.006)');
        g.fillStyle = gr; g.beginPath(); g.moveTo(cx - wT, -H * 0.05); g.lineTo(cx + wT, -H * 0.05); g.lineTo(cx + wB, cy + rx * 0.2); g.lineTo(cx - wB, cy + rx * 0.2); g.fill();
      }
      for (let i = 0; i < 260; i++) {
        const t = hash(i * 3 + 1), y = -H * 0.05 + t * (cy + rx * 0.2 + H * 0.05), w = W * 0.03 + (rx * 1.15 - W * 0.03) * t, x = cx + (hash(i * 3 + 2) - 0.5) * 2 * w * 0.8;
        g.fillStyle = `rgba(255,240,220,${0.05 + 0.12 * hash(i * 3 + 3)})`; g.fillRect(x, y, 1.2, 1.2);
      }
      g.restore();
    }
    // the plate's shadow on the floor, the stand and its driver
    g.save(); g.translate(cx, H * 0.975); g.scale(1, 0.1);
    gr = g.createRadialGradient(0, 0, 0, 0, 0, rx * 1.15); gr.addColorStop(0, day ? 'rgba(60,50,40,0.3)' : 'rgba(255,236,210,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-rx * 1.2, -rx * 1.2, rx * 2.4, rx * 2.4); g.restore();
    const sw = rx * 0.03;
    gr = g.createLinearGradient(cx - sw, 0, cx + sw, 0);
    gr.addColorStop(0, day ? '#5a5048' : '#09090b'); gr.addColorStop(0.4, day ? '#a39684' : '#2a2a31'); gr.addColorStop(1, day ? '#4a4038' : '#060608');
    g.fillStyle = gr; g.fillRect(cx - sw, cy, sw * 2, H - cy);
    gr = g.createLinearGradient(cx - sw * 5, 0, cx + sw * 5, 0);
    gr.addColorStop(0, day ? '#3a322c' : '#060607'); gr.addColorStop(0.35, day ? '#6a5e52' : '#1c1c22'); gr.addColorStop(1, day ? '#2e2722' : '#040405');
    g.fillStyle = gr; g.fillRect(cx - sw * 5, H * 0.9, sw * 10, H * 0.12);
    // the plate: its edge (the thickness, at the front), its top, brushed rings, the light on it
    const pl = canvas(W * dpr, H * dpr), q = pl.getContext('2d');
    q.setTransform(dpr, 0, 0, dpr, 0, 0);
    const N = 180, rim = [], th = rx * 0.022;
    for (let i = 0; i <= N; i++) { const a = i / N * TAU; P(Math.cos(a), 0, Math.sin(a), p); rim.push([p[0], p[1]]); }
    q.beginPath(); rim.forEach(([x, y], i) => i ? q.lineTo(x, y) : q.moveTo(x, y));
    for (let i = N; i >= 0; i--) { const [x, y] = rim[i]; q.lineTo(x, y + th); }
    gr = q.createLinearGradient(cx - rx, 0, cx + rx, 0);
    if (day) { gr.addColorStop(0, '#5a4424'); gr.addColorStop(0.4, '#8a6a38'); gr.addColorStop(1, '#4a3820'); }
    else { gr.addColorStop(0, '#0c0c10'); gr.addColorStop(0.4, '#2a2a33'); gr.addColorStop(1, '#09090c'); }
    q.fillStyle = gr; q.fill();
    const top = new Path2D(); rim.forEach(([x, y], i) => i ? top.lineTo(x, y) : top.moveTo(x, y));
    gr = q.createLinearGradient(0, rim[N * 3 / 4][1], 0, rim[N / 4][1]);
    if (day) { gr.addColorStop(0, '#b0915a'); gr.addColorStop(0.5, '#cfb077'); gr.addColorStop(1, '#bb985c'); }
    else { gr.addColorStop(0, '#0b0b0e'); gr.addColorStop(0.55, '#16161b'); gr.addColorStop(1, '#0e0e12'); }
    q.fillStyle = gr; q.fill(top);
    q.save(); q.clip(top);
    for (let i = 0; i < 110; i++) {
      const r = 0.04 + 0.96 * hash(i * 7 + 1), pp = [];
      for (let k = 0; k <= 72; k++) { const a = k / 72 * TAU; P(Math.cos(a) * r, 0, Math.sin(a) * r, p); pp.push([p[0], p[1]]); }
      q.strokeStyle = day ? `rgba(255,240,200,${0.05 + 0.08 * hash(i * 7 + 2)})` : `rgba(160,170,190,${0.018 + 0.03 * hash(i * 7 + 2)})`; q.lineWidth = 0.8;
      q.beginPath(); pp.forEach(([x, y], k) => k ? q.lineTo(x, y) : q.moveTo(x, y)); q.stroke();
    }
    P(-0.1, 0, -0.3, p);
    q.translate(p[0], p[1]); q.scale(1, 0.5);
    gr = q.createRadialGradient(0, 0, 0, 0, 0, rx * 0.95);
    gr.addColorStop(0, day ? 'rgba(255,250,230,0.38)' : 'rgba(220,222,240,0.12)'); gr.addColorStop(0.5, day ? 'rgba(255,250,230,0.1)' : 'rgba(220,222,240,0.04)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    q.fillStyle = gr; q.fillRect(-rx, -rx, rx * 2, rx * 2);
    q.restore();
    q.strokeStyle = day ? 'rgba(255,236,190,0.75)' : 'rgba(200,205,225,0.3)'; q.lineWidth = 1.2;
    q.beginPath(); rim.slice(0, N / 2 + 1).forEach(([x, y], i) => i ? q.lineTo(x, y) : q.moveTo(x, y)); q.stroke();
    return [bg, pl];
  }
  const cymatics = {
    name: 'cymatics', title: 'Cymatics', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, W, H, st, storm, e } = E, dt = Math.min(E.dt, 1 / 30), calm = calmOf(E), wx = windX(E), wy = windY(E), sk = W / 1600, G = 64;
      if (st.W !== W || st.H !== H || !st.P) {
        st.W = W; st.H = H;
        const Rp = Math.min(W * 0.3, H * 0.6), cx = W / 2, cy = H * 0.56, tz = 0.6, q = 0.2;
        st.Rp = Rp; st.cx = cx; st.cy = cy; st.tz = tz; st.q = q;
        st.P = (X, Y, Z, out) => { const k = 1 / (1 - q * Z); out[0] = cx + Rp * X * k; out[1] = cy + Rp * (tz * Z - 0.9 * Y) * k; out[2] = k; return out; };
        st.inv = (sx, sy) => { const v = (sy - cy) / (Rp * tz), Z = v / (1 + q * v); return [(sx - cx) * (1 - q * Z) / Rp, Z]; };
        [st.bN, st.pN] = cymScene(st, W, H, E.dpr, false); [st.bD, st.pD] = cymScene(st, W, H, E.dpr, true);
        const bx = Math.max(0, Math.floor(cx - Rp / (1 - q) - 6)), by = Math.max(0, Math.floor(cy - Rp * tz / (1 + q) - 6));   // the plate's box (only that is drawn of its layer)
        st.pbox = [bx, by, Math.min(W, Math.ceil(cx + Rp / (1 - q) + 6)) - bx, Math.min(H, Math.ceil(cy + Rp * tz / (1 - q) + Rp * 0.04 + 6)) - by];
        st.f = new Float32Array(G * G); st.notes = []; st.drops = []; st.spl = []; st.waves = []; st.idx = 0; st.next = 0;
        st.gr = null; st.cache = new Map();
      }
      const day = dayOf(st, E), P = st.P, p = [0, 0, 0];
      let sites = E.sites;
      if (!sites.length) sites = st.idle || (st.idle = Array.from({ length: 6 }, (_, i) => ({ id: 90000 + i, u: (i + 0.5) / 6, v: 0.5, k: 0.3 + 0.4 * hash(i * 5 + 1) })));
      const kindAt = z => z.id >= 90000 ? (z.id % 4) : kindOf(E, z);
      const specOf = z => { let s = st.cache.get(z.id); if (!s) { s = cymSpec(z, kindAt(z)); s.f = cymField(s, G); st.cache.set(z.id, s); } return s; };
      const spotOf = z => { const a = hash(z.id * 5 + 2) * TAU, r = 0.25 + 0.6 * Math.sqrt(hash(z.id * 5 + 3)); return [Math.cos(a) * r, Math.sin(a) * r]; };
      // ---- the sand: more of it when more places are raining
      const NG = Math.round(clamp(3200 + 110 * E.sites.length, 3200, 9000) * Math.min(1.3, W * H / (1280 * 720)));
      if (!st.gr || st.gr.n !== NG) {
        const o = st.gr, gx = new Float32Array(NG), gz = new Float32Array(NG), gy = new Float32Array(NG), gv = new Float32Array(NG), gu = new Float32Array(NG), gw = new Float32Array(NG), ph = new Float32Array(NG), off = new Float32Array(NG);
        for (let i = 0; i < NG; i++) {
          if (o && i < o.n) { gx[i] = o.x[i]; gz[i] = o.z[i]; gy[i] = o.y[i]; gv[i] = o.vy[i]; gu[i] = o.vx[i]; gw[i] = o.vz[i]; off[i] = o.off[i]; }
          else { const a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.97; gx[i] = Math.cos(a) * r; gz[i] = Math.sin(a) * r; gy[i] = o ? 0.4 + rnd() * 0.3 : 0; }
          ph[i] = rnd() * TAU;
        }
        st.gr = { n: NG, x: gx, z: gz, y: gy, vy: gv, vx: gu, vz: gw, ph, off };
      }
      // ---- the notes: the raining places take turns (east to west); calm holds one; a storm piles them up
      const order = [...sites].sort((a, b) => a.u - b.u);
      const play = (z, amp, now) => {               // a place's drop strikes the plate: its note begins
        const sp = specOf(z), [X, Z] = spotOf(z);
        st.notes.push({ sp, t: T, w: 0, amp, kind: sp.kind, k: z.k });
        if (st.notes.length > 4) st.notes.shift();
        st.waves.push({ X, Z, t: T, a: amp });
        st.lastKind = sp.kind; st.hit = T;
        if (!now) st.drops.push({ X, Z, t: T - 0.3, land: T, k: z.k, big: true });
      };
      const dur = (z => (2.8 + 3 * z.k) * (1 + 3 * smoothstep(0.3, 0.9, calm)) / (1 + 6 * storm));
      if (T >= st.next && order.length) {
        const z = order[st.idx % order.length]; st.idx++;
        if (calm > 0.75 && st.notes.length) st.next = T + 1;                  // calm: the figure holds
        else {
          // the drop is seen falling first; it strikes (and the note begins) as it lands
          const [X, Z] = spotOf(z); st.drops.push({ X, Z, t: T, land: T + 0.32, k: z.k, big: true, z });
          st.next = T + dur(z) * (0.85 + 0.3 * rnd());
        }
        if (storm > 0.3 && rnd() < storm) { const z2 = order[Math.floor(rnd() * order.length)]; play(z2, 0.7 + storm, true); }   // the storm: note over note
      }
      // fade the notes in and out (the newest rings, the older die away)
      let drive = 0;
      for (let i = 0; i < st.notes.length; i++) {
        const n = st.notes[i], newest = i === st.notes.length - 1;
        n.w += ((newest ? 1 : 0) - n.w) * (1 - Math.exp(-dt * (newest ? 7 : 3 + 6 * storm)));
      }
      st.notes = st.notes.filter((n, i) => n.w > 0.01 || i === st.notes.length - 1);
      const f = st.f; f.fill(0);
      for (const n of st.notes) { const w = n.w * (storm > 0.2 ? 0.7 + 0.3 * Math.sin(T * 17 + n.t * 7) : 1), F = n.sp.f; for (let i = 0; i < f.length; i++) f[i] += F[i] * w; }
      const cur = st.notes.length ? st.notes[st.notes.length - 1] : null;
      // how hard it shakes: a strike rings loud and settles; calm settles low; a storm stays loud
      const ring = st.hit != null ? Math.exp(-(T - st.hit) * (0.9 + 0.6 * calm)) : 0;
      drive = (0.22 + 0.5 * ring) * (cur ? 0.6 + 0.6 * cur.k : 0.6) * (1 - 0.55 * calm) + 1.1 * storm;
      // ---- the rain: drops falling into the light and striking the plate (each raining place now and then; more places = more drops)
      const rate = (0.6 + 0.09 * sites.length) * (0.15 + 0.85 * (1 - calm)) * (1 + 3 * storm);
      let m = rate * dt;
      while (m > 0) { if (m < 1 && rnd() > m) break; m -= 1; const z = sites[Math.floor(rnd() * sites.length)], a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.98;
        st.drops.push({ X: Math.cos(a) * r, Z: Math.sin(a) * r, t: T, land: T + 0.3 + 0.1 * rnd(), k: z.k * 0.6 }); }
      // ---- taps: a strike where it lands (on a raining place: its note)
      for (const t of tapsOf(R, E).fresh) {
        let [X, Z] = st.inv(t.x, t.y); const r = Math.hypot(X, Z); if (r > 0.95) { X *= 0.95 / r; Z *= 0.95 / r; }
        const z = t.site != null ? sites.find(o => o.id === t.site) : null;
        if (z) { play(z, t.echo ? 0.6 : 1.6, true); const [sx, sz] = spotOf(z); X = sx; Z = sz; st.next = T + dur(z); }
        st.waves.push({ X, Z, t: T, a: t.echo ? 0.5 : 1.6, tap: !t.echo }); if (!z && !t.echo) st.hit = T;
      }
      // ---- lightning: the plate booms, every grain jumps
      for (const b of newBolts(R, st, T)) { st.boom = T; st.hit = T; const G2 = st.gr; for (let i = 0; i < G2.n; i++) if (G2.y[i] === 0) G2.vy[i] = (0.4 + 0.8 * rnd()) * (b.power || 0.7); }
      const boom = st.boom != null ? Math.exp(-(T - st.boom) * 2.5) : 0;
      drive += 1.2 * boom;
      // drops land: a splash, a ring running out through the sand
      st.drops = st.drops.filter(d => { if (T < d.land) return true; if (d.z) play(d.z, 1); else st.waves.push({ X: d.X, Z: d.Z, t: T, a: 0.35 + d.k });
        for (let i = 0; i < 7; i++) { const a = rnd() * TAU, v = 0.08 + 0.15 * rnd(); st.spl.push({ X: d.X, Z: d.Z, vx: Math.cos(a) * v, vz: Math.sin(a) * v, vy: 0.25 + 0.4 * rnd(), y: 0, t: T }); }
        return false; });
      st.waves = st.waves.filter(w => T - w.t < 1.2);
      // ---- move the sand: shaken where the plate moves (the still lines keep it), kicked by the rings, blown by the breath
      const gs = st.gr, gx = gs.x, gz = gs.z, gy = gs.y, gvy = gs.vy, gvx = gs.vx, gvz = gs.vz, h = 2 / (G - 1);
      const step = 0.15 * drive * Math.sqrt(dt), pull = 0.2 * (0.5 + drive) * dt;
      const gust = e * (0.85 + 0.15 * Math.sin(T * 7)), bX = clamp(E.mx, -1, 1) * 0.8, bZ = clamp(E.my, -1, 1) * 0.8;
      const dir = Math.abs(wx) > 0.1 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const wvx = (Math.abs(wx) > 0.1 ? wx : 0.4 * dir) * gust * 1.6, wvz = wy * gust * 0.9;
      const wv = st.waves;
      for (let i = 0; i < gs.n; i++) {
        let x = gx[i], z = gz[i];
        if (gs.off[i] > 0) {                          // blown off: back on after a while, sifted in from above
          if (T > gs.off[i] && (e < 0.3 || T > gs.off[i] + 2.5)) { const a = rnd() * TAU, r = Math.sqrt(rnd()) * 0.95; gx[i] = Math.cos(a) * r; gz[i] = Math.sin(a) * r; gy[i] = 0.5 + 0.5 * rnd(); gvy[i] = 0; gvx[i] = 0; gvz[i] = 0; gs.off[i] = 0; }
          continue;
        }
        // the plate's motion here (bilinear), and its slope
        let fx = (x + 1) / h, fz = (z + 1) / h; if (fx < 0) fx = 0; else if (fx > G - 1.001) fx = G - 1.001; if (fz < 0) fz = 0; else if (fz > G - 1.001) fz = G - 1.001;
        const ix = fx | 0, iz = fz | 0, ux = fx - ix, uz = fz - iz, o = iz * G + ix;
        const a00 = f[o], a10 = f[o + 1], a01 = f[o + G], a11 = f[o + G + 1];
        const v = (a00 * (1 - ux) + a10 * ux) * (1 - uz) + (a01 * (1 - ux) + a11 * ux) * uz;
        const dfx = ((a10 - a00) * (1 - uz) + (a11 - a01) * uz) / h, dfz = ((a01 - a00) * (1 - ux) + (a11 - a10) * ux) / h;
        const av = v < 0 ? -v : v;
        if (gy[i] <= 0) {                             // on the plate: jiggled, and drawn toward the still lines
          const s2 = step * av * (0.4 + av);
          x += (rnd() + rnd() - 1) * s2 - pull * v * dfx; z += (rnd() + rnd() - 1) * s2 - pull * v * dfz;
          if (av * drive > 0.55 && rnd() < av * drive * dt * 6) gvy[i] = 0.06 * av * drive * (0.5 + rnd());   // hops where it shakes hard
        }
        for (let k = 0; k < wv.length; k++) {         // a ring passing by kicks the grain up and out
          const W2 = wv[k], age = T - W2.t, dx = x - W2.X, dz = z - W2.Z, d = Math.sqrt(dx * dx + dz * dz) + 1e-4, front = age * 0.9;
          if (Math.abs(d - front) < 0.035 && gy[i] <= 0) { const kick = W2.a * (1 - age / 1.2); gvy[i] = Math.max(gvy[i], 0.12 * kick); gvx[i] += dx / d * 0.22 * kick; gvz[i] += dz / d * 0.22 * kick; }
        }
        if (gust > 0.02) {                            // the breath: strongest on the side it comes from, it lifts the sand and carries it off
          const ax = 0.35 + 0.65 * Math.exp(-((x - bX) * (x - bX) + (z - bZ) * (z - bZ)) * 1.2);
          gvx[i] += (wvx * ax - gvx[i]) * dt * 3; gvz[i] += (wvz * ax - gvz[i]) * dt * 3;
          if (gy[i] <= 0 && rnd() < gust * ax * dt * 4) gvy[i] = 0.05 + 0.1 * rnd() * gust;
        }
        if (gy[i] > 0 || gvy[i] > 0) {               // in the air
          gy[i] += gvy[i] * dt * 4; gvy[i] -= 1.6 * dt;
          x += gvx[i] * dt; z += gvz[i] * dt;
          if (gy[i] <= 0) { gy[i] = 0; gvy[i] = 0; gvx[i] *= 0.3; gvz[i] *= 0.3; }
        } else { x += gvx[i] * dt * 0.4; z += gvz[i] * dt * 0.4; gvx[i] *= 0.9; gvz[i] *= 0.9; }
        if (x * x + z * z > 1) { gs.off[i] = T + 1.5 + 2 * rnd(); gy[i] = 0; }   // off the edge
        gx[i] = x; gz[i] = z;
      }
      // ---- paint: the studio and the plate, the note's light, the sand, the rain
      c.globalCompositeOperation = 'source-over';
      const jit = (storm * 1.6 + boom * 3) * sk * 1.5, dp = E.dpr, jx = Math.round((rnd() - 0.5) * jit * dp) / dp, jy = Math.round((rnd() - 0.5) * jit * dp) / dp;   // whole pixels: the pictures are not resampled
      if (jit > 0.05) c.translate(jx, jy);
      c.drawImage(fade2(st, 'fb', st.bN, st.bD, day), 0, 0, W, H);
      // the note's light: from under the plate, round its rim, brightest as the drop strikes
      const nk = cur ? cur.kind : 1, col = CYM_COL[nk].join(','), lit = (0.4 + 0.6 * ring + 0.5 * storm + 0.6 * boom) * (1 - 0.5 * day);
      P(0, 0, 0, p);
      const ex = p[0], ey = p[1], rx = st.Rp;
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0 && age < 1.2) R._bolt(c, b, age, E.lw); }   // lightning, behind the plate
      c.globalCompositeOperation = 'source-over';
      { const [x, y, w, h] = st.pbox, dp = E.dpr; c.drawImage(fade2(st, 'fp', st.pN, st.pD, day), x * dp, y * dp, w * dp, h * dp, x, y, w, h); }
      // the coloured light under the plate catching the front of its rim
      const rl = new Path2D(); for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI; P(Math.cos(a), 0, Math.sin(a), p); k ? rl.lineTo(p[0], p[1] + rx * 0.011) : rl.moveTo(p[0], p[1] + rx * 0.011); }
      const ra = Math.min(1, 0.25 + 0.6 * lit) * (1 - 0.4 * day);
      c.strokeStyle = `rgba(${col},${ra * 0.12})`; c.lineWidth = rx * 0.07; c.stroke(rl);
      c.strokeStyle = `rgba(${col},${ra * 0.25})`; c.lineWidth = rx * 0.03; c.stroke(rl);
      c.strokeStyle = `rgba(${col},${ra})`; c.lineWidth = Math.max(1.5, rx * 0.011); c.stroke(rl);
      // the sand (grains in the air cast a small shadow)
      const shade = [new Path2D(), new Path2D(), new Path2D()], shad = new Path2D(), air = new Path2D(), gsz = Math.max(1, 1.75 * sk + 0.4);
      for (let i = 0; i < gs.n; i++) {
        if (gs.off[i] > 0) continue;
        const x = gx[i], z = gz[i], y = gy[i];
        P(x, y, z, p);
        const d = gsz * p[2];
        if (y > 0.004) { const sx = p[0], sy = p[1]; P(x, 0, z, p); shad.rect(p[0] - d * 0.5, p[1] - d * 0.3, d, d * 0.6); air.rect(sx - d / 2, sy - d / 2, d, d); continue; }
        const L = (x + 0.15) * (x + 0.15) + (z + 0.35) * (z + 0.35);   // brighter under the spot
        shade[L < 0.35 ? 2 : L < 0.9 ? 1 : 0].rect(p[0] - d / 2, p[1] - d * 0.4, d, d * 0.8);
      }
      const sand = day > 0.5 ? ['44,38,32', '36,31,26', '28,24,20'] : ['176,170,158', '216,210,196', '246,240,226'];
      c.fillStyle = day > 0.5 ? 'rgba(80,60,30,0.3)' : 'rgba(0,0,0,0.55)'; c.fill(shad);
      shade.forEach((pp, i) => { c.fillStyle = `rgb(${sand[i]})`; c.fill(pp); });
      c.fillStyle = `rgba(${mix(sand[2].split(',').map(Number), CYM_COL[nk], 0.55 * (1 - day))},0.95)`; c.fill(air);   // grains in the air catch the coloured light
      // rings running out over the plate
      const rp = new Path2D(), rt = new Path2D();
      for (const w of st.waves) {
        const age = T - w.t, r = age * 0.9, q = w.tap ? rt : rp; if (r < 0.01) continue;
        let pen = false;
        for (let k = 0; k <= 40; k++) { const a = k / 40 * TAU, X = w.X + Math.cos(a) * r, Z = w.Z + Math.sin(a) * r; if (X * X + Z * Z > 1) { pen = false; continue; } P(X, 0, Z, p); if (pen) q.lineTo(p[0], p[1]); else { q.moveTo(p[0], p[1]); pen = true; } }
        if (w.tap && age < 0.5) { P(w.X, 0, w.Z, p); const z = st.Rp * 0.5 * (1 - age * 1.4); c.globalAlpha = 1 - age * 2; c.drawImage(glow(day > 0.5 ? '255,250,235' : col, 64, 0.3), p[0] - z / 2, p[1] - z * 0.3, z, z * 0.6); c.globalAlpha = 1; }   // a tap: a flash where it struck
      }
      c.strokeStyle = day > 0.5 ? 'rgba(60,40,10,0.18)' : `rgba(${col},0.22)`; c.lineWidth = Math.max(1, 1.2 * sk); c.stroke(rp);
      c.strokeStyle = day > 0.5 ? 'rgba(60,40,10,0.5)' : `rgba(${mix(CYM_COL[nk], [255, 255, 255], 0.5)},0.7)`; c.lineWidth = Math.max(1.5, 2 * sk); c.stroke(rt);
      // the rain: streaks falling through the light to where they strike; splashes
      const rs = new Path2D(), lean = (Math.abs(wx) > 0.1 ? wx : 0) * (0.3 * e + 0.25 * storm);
      for (const d of st.drops) {
        const a = clamp((T - d.t) / (d.land - d.t), 0, 1), Y = 2.6 * (1 - a * a), Y2 = Math.max(0, Y + 0.35 + 0.2 * d.k);
        P(d.X - lean * Y, Y, d.Z, p); const x1 = p[0], y1 = p[1]; P(d.X - lean * Y2, Y2, d.Z, p);
        rs.moveTo(p[0], p[1]); rs.lineTo(x1, y1);
      }
      // and the rain falling past the plate, all over the light
      const nr = Math.round((14 + 3 * sites.length) * (0.2 + 0.8 * (1 - calm)) * (1 + 2.5 * storm));
      for (let i = 0; i < nr; i++) {
        const hs = hash(i * 7 + 3), sp = 1.4 + 0.6 * hash(i * 7 + 4), ph = (T * sp * 0.55 + hash(i * 7 + 5)) % 1;
        const x = W * (0.5 + (hs - 0.5) * (0.5 + 0.7 * ph)) + lean * 120 * sk * ph, y = -40 + (H + 80) * ph, l = (20 + 30 * hash(i * 7 + 6)) * sk * (1 + storm);
        rs.moveTo(x, y); rs.lineTo(x - lean * l * 0.6, y - l);
      }
      c.strokeStyle = day > 0.5 ? 'rgba(70,80,100,0.35)' : 'rgba(225,232,255,0.42)'; c.lineWidth = Math.max(1, 1.1 * sk); c.lineCap = 'round'; c.stroke(rs);
      st.spl = st.spl.filter(s => s.y >= 0 && T - s.t < 1);
      const sp2 = new Path2D();
      for (const s of st.spl) { s.vy -= 2.2 * dt; s.y += s.vy * dt; s.X += s.vx * dt; s.Z += s.vz * dt; P(s.X, Math.max(0, s.y), s.Z, p); const d = Math.max(1, 1.8 * sk * p[2]); sp2.rect(p[0] - d / 2, p[1] - d / 2, d, d); }
      c.fillStyle = day > 0.5 ? 'rgba(90,100,120,0.7)' : 'rgba(235,240,255,0.85)'; c.fill(sp2);
      if (jit > 0.05) c.translate(-jx, -jy);
    },
  };

  /* ============================================================== 5  Sea Glow
     A beach at night where the sea glows: plankton in the water lights up electric blue wherever it is
     disturbed. Waves roll in out of the dark and their crests flare as they break, the foam runs up the
     sand glittering and fades. Every raining place is a shower out at sea (across by longitude, the
     further north the further out): its rain falls in a grey curtain and each drop that hits the water
     sparks; heavier rain = a wider curtain and more, brighter sparks; drizzle is a fine glitter, showers
     come in bursts, a thunderstorm throws big flashes. A breath is a gust over the water: a glowing wake of
     ripples races away from the side it came from, spray is torn off the crests and the rain leans. A
     storm brings big surf that breaks in sheets of light, heavy rain and lightning over the sea; calm, the
     clouds open on the Milky Way, the swell is low and only a few sparks glow at the water's edge. A tap
     is a stone thrown in (a ring of light) or, on the sand, a footprint that glows; on a raining place,
     a downpour there. */
  function seaSky(st, W, H, dpr, clear) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), hy = st.hy, ys = st.ys;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, hy);
    if (clear) { gr.addColorStop(0, '#01030a'); gr.addColorStop(0.7, '#061026'); gr.addColorStop(1, '#0d1a38'); }
    else { gr.addColorStop(0, '#040508'); gr.addColorStop(0.6, '#0a0d16'); gr.addColorStop(1, '#121826'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, hy + 1);
    if (clear) {                                  // the Milky Way: a soft band of light and dust across the sky, and the stars
      g.save(); g.translate(W * 0.55, hy * 0.55); g.rotate(-0.42);
      for (let i = 0; i < 40; i++) { const x = (hash(i * 5 + 1) - 0.5) * W * 1.3, y = (hash(i * 5 + 2) - 0.5) * hy * 0.25, r = (0.08 + 0.12 * hash(i * 5 + 3)) * W;
        const q = g.createRadialGradient(x, y, 0, x, y, r); q.addColorStop(0, `rgba(${hash(i * 5 + 4) < 0.3 ? '255,220,190' : '170,190,255'},${0.035 + 0.03 * hash(i * 5 + 5)})`); q.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = q; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
      for (let i = 0; i < 900; i++) { const x = (hash(i * 3 + 7) - 0.5) * W * 1.3, y = (hash(i * 3 + 8) + hash(i * 3 + 9) - 1) * hy * 0.16; g.fillStyle = `rgba(230,236,255,${0.15 + 0.4 * hash(i * 3 + 10)})`; g.fillRect(x, y, 1, 1); }
      g.restore();
    }
    for (let i = 0; i < (clear ? 700 : 120); i++) {
      const x = hash(i * 7 + 1) * W, y = Math.pow(hash(i * 7 + 2), 1.3) * hy * 0.97, b = hash(i * 7 + 3);
      g.fillStyle = `rgba(${b > 0.92 ? '255,232,210' : '214,224,255'},${(0.15 + 0.7 * b * b) * (clear ? 1 : 0.5) * (1 - 0.6 * y / hy)})`;
      const d = b > 0.97 ? 1.8 : b > 0.8 ? 1.3 : 0.9; g.fillRect(x, y, d, d);
    }
    if (!clear) {                                 // low cloud, faintly lit from below by the glow of the sea
      for (let i = 0; i < 26; i++) {
        const x = hash(i * 9 + 1) * W * 1.2 - W * 0.1, y = hy * (0.15 + 0.8 * hash(i * 9 + 2)), r = W * (0.08 + 0.16 * hash(i * 9 + 3));
        g.save(); g.translate(x, y); g.scale(1, 0.32);
        const q = g.createRadialGradient(0, 0, 0, 0, 0, r); q.addColorStop(0, 'rgba(24,30,44,0.85)'); q.addColorStop(0.7, 'rgba(18,24,36,0.5)'); q.addColorStop(1, 'rgba(10,14,22,0)');
        g.fillStyle = q; g.fillRect(-r, -r, 2 * r, 2 * r); g.restore();
      }
      gr = g.createLinearGradient(0, hy * 0.6, 0, hy); gr.addColorStop(0, 'rgba(30,110,150,0)'); gr.addColorStop(1, 'rgba(30,110,150,0.12)');
      g.fillStyle = gr; g.fillRect(0, hy * 0.6, W, hy * 0.4);
    }
    // the sea: dark, a little lighter toward the horizon, faint streaks of starlight on the swell
    gr = g.createLinearGradient(0, hy, 0, ys);
    gr.addColorStop(0, clear ? '#0c1a34' : '#0d141f'); gr.addColorStop(0.25, clear ? '#061024' : '#070c14'); gr.addColorStop(1, '#03070e');
    g.fillStyle = gr; g.fillRect(0, hy, W, ys - hy + 1);
    if (clear) {                                  // the Milky Way's faint reflection on the swell
      g.save(); g.translate(W * 0.6, hy); g.scale(1, 2.2);
      const q = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.16); q.addColorStop(0, 'rgba(150,170,255,0.08)'); q.addColorStop(1, 'rgba(150,170,255,0)');
      g.fillStyle = q; g.fillRect(-W * 0.2, 0, W * 0.4, (ys - hy) / 2.2); g.restore();
    }
    g.fillStyle = clear ? 'rgba(160,190,255,0.25)' : 'rgba(120,150,190,0.12)'; g.fillRect(0, hy - 0.5, W, 1);
    // the beach: wet dark sand catching a little light, dry sand further up
    gr = g.createLinearGradient(0, ys, 0, H);
    gr.addColorStop(0, '#05080d'); gr.addColorStop(0.35, '#080a0e'); gr.addColorStop(1, '#0e0d0f');
    g.fillStyle = gr; g.fillRect(0, ys, W, H - ys);
    for (let i = 0; i < 2600; i++) { const y = ys + Math.pow(hash(i * 3 + 21), 0.8) * (H - ys); g.fillStyle = `rgba(${hash(i * 3 + 23) < 0.5 ? '120,130,150' : '0,0,0'},${0.06 + 0.1 * hash(i * 3 + 24)})`; g.fillRect(hash(i * 3 + 22) * W, y, 1.2, 1.2); }
    return cv;
  }
  /* the glow of the water: light left in a small field that drifts to the shore with the water and fades */
  const SEA_LUT = (() => {
    const S = [[0, 0, 0, 0], [0.18, 0, 26, 60], [0.45, 0, 90, 170], [0.8, 0, 170, 255], [1.3, 70, 230, 255], [2.2, 210, 252, 255], [3.5, 255, 255, 255]], L = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) { const v = i / 255 * 3.5; let k = 1; while (k < S.length - 1 && S[k][0] < v) k++; const a = S[k - 1], b = S[k], t = clamp((v - a[0]) / (b[0] - a[0]), 0, 1); for (let c = 0; c < 3; c++) L[i * 3 + c] = lerp(a[c + 1], b[c + 1], t); }
    return L;
  })();
  function seaDep(st, x, y, a, r) {                // add light at screen (x, y): a small soft spot (r in field cells)
    const f = st.fld, gw = st.gw, gh = st.gh, X = x * st.fs, Y = y * st.fs, R = Math.max(0.8, r), x0 = Math.max(0, Math.floor(X - R)), x1 = Math.min(gw - 1, Math.ceil(X + R)), y0 = Math.max(0, Math.floor(Y - R)), y1 = Math.min(gh - 1, Math.ceil(Y + R)), ir = 1 / (R * R);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { const d = ((i - X) * (i - X) + (j - Y) * (j - Y)) * ir; if (d < 1) f[j * gw + i] += a * (1 - d); }
  }
  function seaLine(st, x0, y0, x1, y1, a, r) {     // ... along a line (the points jittered, so lines laid frame after frame leave no stripes)
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * st.fs / Math.max(0.7, r * 0.8))), j = rnd();
    for (let k = 0; k < n; k++) seaDep(st, lerp(x0, x1, (k + j) / n), lerp(y0, y1, (k + j) / n), a, r);
  }
  const seaglow = {
    name: 'seaglow', title: 'Sea Glow', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, W, H, st, storm, e } = E, dt = Math.min(E.dt, 1 / 30), calm = calmOf(E), wx = windX(E), sk = W / 1600;
      if (st.W !== W || st.H !== H || !st.skyC) {
        st.W = W; st.H = H; st.hy = H * 0.36; st.ys = H * 0.76; st.K = H - st.hy; st.Zs = st.K / (st.ys - st.hy); st.F = W / 2 * st.Zs / 3;
        st.skyC = seaSky(st, W, H, E.dpr, true); st.skyR = seaSky(st, W, H, E.dpr, false);
        st.gw = Math.round(W / 4); st.gh = Math.round(H / 4); st.fs = st.gw / W; st.fld = new Float32Array(st.gw * st.gh); st.tmp = new Float32Array(st.gw * st.gh);
        st.gc = canvas(st.gw, st.gh); st.gx = st.gc.getContext('2d'); st.img = st.gx.createImageData(st.gw, st.gh);
        st.waves = []; st.pt = []; st.wk = []; st.wash = []; st.nextW = 0; st.burst = new Map();
        for (let i = 0; i < 4; i++) st.waves.push({ Z: 2 + i * 2.5, sd: i * 17 + 3, h: 0.8 + 0.4 * hash(i + 5) });
      }
      const { hy, ys, K, Zs, F, gw, gh } = st, yOf = Z => hy + K / Z, xOf = (X, Z) => W / 2 + X * F / Z, sites = E.sites;
      const [fl, bolt] = flicker(R, T);
      const dir = Math.abs(wx) > 0.1 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const gust = e * (0.85 + 0.15 * Math.sin(T * 6)), bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, bys = 0.5 + 0.4 * clamp(E.my, -1, 1);
      const amp = (0.4 + 0.6 * (1 - calm)) * (1 + 1.5 * storm) * (1 + 0.2 * e), spd = 1 + 0.35 * (1 - calm) + 1.3 * storm, glo = (0.35 + 0.65 * (1 - calm)) * (1 + 0.8 * storm);
      // ---- the sky and the sea (clouded in rain, the Milky Way in calm)
      c.globalCompositeOperation = 'source-over';
      c.drawImage(fade2(st, 'fsky', st.skyR, st.skyC, smoothstep(0.2, 0.9, calm)), 0, 0, W, H);
      if (bolt && T - bolt.t < 1.2) { c.save(); c.beginPath(); c.rect(0, 0, W, hy); c.clip(); R._bolt(c, bolt, T - bolt.t, E.lw); c.restore(); c.globalCompositeOperation = 'source-over'; }
      // ---- the light already in the water drifts toward the shore (as the surf does) and fades; on the sand it lingers
      {
        const f = st.fld, t2 = st.tmp, cell = H / gh, rowS = Math.floor((ys - 2) * st.fs), kd = Math.exp(-dt * (1.9 + 0.6 * calm)), ks = Math.exp(-dt * 1.3), sh = gust * dir * 260 * sk * dt * st.fs;
        for (let j = 0; j < gh; j++) {
          const y = (j + 0.5) * cell;
          if (j >= rowS) { for (let i = 0, o = j * gw; i < gw; i++, o++) t2[o] = f[o] * ks; continue; }
          if (y < hy) { for (let i = 0, o = j * gw; i < gw; i++, o++) t2[o] = 0; continue; }
          const Z = K / Math.max(1, y - hy), v = K / (Z * Z) * spd * 0.3 * dt * st.fs, sy = j - v, j0 = Math.floor(sy), u = sy - j0, sx = sh * Math.min(2, 2.5 / Z);
          for (let i = 0, o = j * gw; i < gw; i++, o++) {
            const xi = clamp(i - sx, 0, gw - 1.001), i0 = Math.floor(xi), w = xi - i0;
            if (j0 < 0) { t2[o] = 0; continue; }
            const a0 = j0 * gw + i0, b0 = a0 + gw;
            const q = ((f[a0] * (1 - w) + f[a0 + 1] * w) * (1 - u) + (f[b0] * (1 - w) + f[b0 + 1] * w) * u) * kd; t2[o] = q > 4 ? 4 : q;
          }
        }
        st.fld = t2; st.tmp = f;
      }
      // ---- the swell: waves roll in out of the dark; their crests flare where they break
      if (T > st.nextW) { st.waves.push({ Z: 12, sd: (rnd() * 1e4) | 0, h: 0.7 + 0.6 * rnd() }); st.nextW = T + (2.4 + 1.2 * rnd()) / (1 + 0.8 * storm); }
      const NX = 80, faces = new Path2D(), backs = new Path2D(), lit = [new Path2D(), new Path2D()];
      st.waves.sort((a, b) => b.Z - a.Z);
      for (const w of st.waves) {
        w.Z -= spd * dt * (0.35 + 0.65 * Math.min(1, w.Z / 5));
        let prev = null;
        for (let i = 0; i <= NX; i++) {
          const x = i / NX * (W + 60) - 30, X = (x - W / 2) / F * w.Z;
          const Zx = w.Z + 0.5 * vnoise(X * 0.3 + w.sd, w.sd * 0.3) + 0.18 * Math.sin(X * 0.8 + w.sd);
          if (Zx < Zs * 0.97) { prev = null; continue; }
          const zb = 2.4 + 1.6 * (vnoise(X * 0.35 + w.sd * 1.7, 4.2) * 0.5 + 0.5) * (0.5 + 0.5 * (1 - calm)) + 1.2 * storm;   // where it breaks: further out in a storm
          const br = clamp((zb - Zx) / 1.4, 0, 1) * (0.55 + 0.45 * (vnoise(X * 0.6 + T * 0.3, w.sd) * 0.5 + 0.5)), sz = K / Zx, hh = 0.075 * amp * w.h * (1 - 0.5 * br) * sz, y = yOf(Zx) - hh;
          const cur = [x, y, br, hh, Zx];
          if (prev) {
            faces.moveTo(prev[0], prev[1]); faces.lineTo(x, y); faces.lineTo(x, y + hh * 1.4); faces.lineTo(prev[0], prev[1] + prev[3] * 1.4);
            backs.moveTo(prev[0], prev[1]); backs.lineTo(x, y);
            const b2 = (br + prev[2]) / 2;
            if (b2 > 0.03) {
              lit[b2 > 0.5 ? 1 : 0].moveTo(prev[0], prev[1]); lit[b2 > 0.5 ? 1 : 0].lineTo(x, y);
              const a = b2 * Math.min(2.2, glo * (0.5 + 0.9 * amp)) * dt * 4.5, r = Math.max(0.8, hh * st.fs * 0.8);
              seaLine(st, prev[0], prev[1] + hh * 0.3, x, y + hh * 0.3, a, r);                          // the breaking face lights up
              if (rnd() < b2 * dt * (10 + 30 * storm)) st.pt.push({ x: lerp(prev[0], x, rnd()), y: y + rnd() * hh, vx: (rnd() - 0.5) * 30 * sk, vy: -rnd() * 40 * sk * (0.4 + storm), life: 0.6 + rnd(), t: T, b: 0.6 + 0.4 * b2 });
              if (gust > 0.1 && rnd() < b2 * gust * dt * 30) st.wk.push({ x, y: y - hh * 0.3, vx: dir * (300 + 300 * rnd()) * sk * gust * Math.min(1.6, 3 / Zx), vy: -(20 + 40 * rnd()) * sk, t: T, life: 0.6 + 0.6 * rnd(), a: 0.5 });   // spray torn off the crest
            }
          }
          prev = cur;
        }
        if (!w.washed && w.Z < Zs + 0.2) { w.washed = true; st.wash.push({ t: T, sd: w.sd, a: (0.45 + 0.55 * amp) * w.h }); }
      }
      st.waves = st.waves.filter(w => w.Z > Zs - 0.25);
      c.fillStyle = 'rgba(16,30,52,0.75)'; c.fill(faces);
      c.lineWidth = Math.max(1, sk); c.strokeStyle = 'rgba(110,150,210,0.2)'; c.stroke(backs);
      // ---- rain out at sea: a shower per raining place, its drops sparking where they hit
      const amt = (0.1 + 0.9 * (1 - calm)) * (1 + 1.8 * storm), lean = wx * gust * 0.6 + dir * storm * 0.35, curt = new Path2D();
      for (const z of sites) {
        const kind = kindOf(E, z), k = z.k, Z = lerp(9, 2.2, southOf(z)), X = (z.u - 0.5) * 2 * 3 * 1.5 * (Z / Zs) * 0.62;
        const bur = (st.burst.get(z.id) || 0) > T ? 3.5 : 1, sw = kind === 2 ? 0.15 + 1.3 * smoothstep(0.1, 0.6, vnoise(T * 0.35 + z.id * 0.1, z.id * 0.37)) : 1;
        const xs = xOf(X, Z), yw = yOf(Z), wid = (0.4 + 1.1 * k) * F / Z, top = yw - (0.9 + 0.9 * k) * K / Z * 0.5, n = Math.round((4 + 14 * k) * amt * sw * bur * (kind === 0 ? 1.5 : 1));
        for (let i = 0; i < n; i++) {
          const h1 = hash(z.id * 31 + i), h2 = hash(z.id * 31 + i + 7), ph = (T * (1.5 + 0.8 * h2) + h1) % 1, x = xs + (h1 - 0.5) * wid + lean * (yw - top) * ph * 0.5, y = top + (yw - top) * ph, l = (yw - top) * (kind === 0 ? 0.05 : 0.13);
          curt.moveTo(x, y); curt.lineTo(x - lean * l * 0.5, y - l);
        }
        let m = (3 + 22 * k * k) * amt * sw * bur * (kind === 0 ? 2 : kind === 3 ? 1.3 : 1) * dt;
        const big = kind === 3 ? 2 : kind === 0 ? 0.45 : 1;
        while (m > 0) {
          if (m < 1 && rnd() > m) break; m -= 1;
          const Zd = Math.max(Zs + 0.1, Z + (rnd() - 0.5) * 1.4 * (0.4 + k)), x = xs + (rnd() - 0.5) * wid * 1.1 + lean * (yw - top) * 0.5, y = yOf(Zd);
          seaDep(st, x, y, 0.22 * big * (0.5 + k), 0.75);
          st.pt.push({ x, y, vx: 0, vy: 0, life: 0.25 + 0.5 * rnd() * big, t: T, b: (0.5 + 0.5 * k) * Math.min(1.4, big) });
        }
      }
      c.strokeStyle = 'rgba(150,175,210,0.3)'; c.lineWidth = Math.max(0.8, 0.9 * sk); c.stroke(curt);
      // ---- the breath: a glowing wake racing away from where it blows
      if (gust > 0.05) {
        const Zb = lerp(7, 1.9, bys), n = gust * 40 * dt * 60 * (W / 1280);
        for (let i = 0; i < n; i++) { const Zr = Math.max(Zs + 0.1, Zb + (rnd() - 0.5) * 3), y = yOf(Zr), x = bxs + dir * rnd() * 0.3 * W + (rnd() - 0.5) * 60 * sk;   // (spread out: no blinding spot where it starts)
          st.wk.push({ x, y, vx: dir * (300 + 420 * rnd()) * sk * gust * Math.min(1.6, 2.6 / Zr), vy: 0, t: T, life: 0.6 + 0.8 * rnd(), a: 0.15 * Math.min(1.3, 3 / Zr) }); }
      }
      if (st.wk.length > 900) st.wk.splice(0, st.wk.length - 900);
      st.wk = st.wk.filter(q => { const a = T - q.t; if (a > q.life) return false; const x0 = q.x, y0 = q.y; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 60 * sk * dt;
        seaLine(st, x0, y0, q.x, q.y, q.a * (1 - a / q.life) * dt * 9, 0.9); return true; });
      // ---- taps: a stone thrown in (a ring of light), a footprint on the sand; on a raining place a downpour there
      for (const t of tapsOf(R, E).fresh) {
        if (t.site != null) { st.burst.set(t.site, T + (t.echo ? 1 : 2.5)); continue; }
        if (t.echo) continue;
        if (t.y > ys + 8 * sk) { for (let k = 0; k < 4; k++) { const s2 = k % 2 ? 1 : -1; st.pend = (st.pend || []).concat([{ t: T + k * 0.4, x: t.x + s2 * 12 * sk + k * 30 * sk * dir, y: t.y - k * 10 * sk }]); } }
        else { const Z = Math.max(Zs + 0.05, K / Math.max(6, t.y - hy)); for (let k = 0; k < 64; k++) { const a = k / 64 * TAU; st.wk.push({ x: t.x, y: Math.max(hy + 3, t.y), vx: Math.cos(a) * 150 * sk * 2.5 / Z, vy: Math.sin(a) * 150 * sk * 0.3 * 2.5 / Z, t: T, life: 1.1, a: 1.2 }); } }
      }
      st.pend = (st.pend || []).filter(p => { if (T < p.t) return true; const sc = sk * (0.7 + 0.6 * (p.y - ys) / (H - ys));
        seaDep(st, p.x, p.y, 1.4, 9 * sc * st.fs + 0.8); seaDep(st, p.x + 2 * sc, p.y - 16 * sc, 1.1, 7 * sc * st.fs + 0.8); return false; });
      // ---- lightning: the whole sea sparks
      for (const b of newBolts(R, st, T)) for (let i = 0; i < 500; i++) { const Zr = Zs + 0.05 + Math.pow(rnd(), 1.6) * 10; seaDep(st, rnd() * W, yOf(Zr), 0.6 * (b.power || 0.7), 0.9); }
      // ---- the foam running up the sand
      st.wash = st.wash.filter(w => T - w.t < 3.5);
      const washP = new Path2D();
      for (const w of st.wash) {
        const a = T - w.t, run = 1 - Math.exp(-a * 2.4), back = smoothstep(1.4, 3.4, a), reach = (H - ys) * 0.38 * w.a * (run - 0.45 * back), al = Math.exp(-a * 1.1) * glo;
        let px = null, py = 0;
        for (let i = 0; i <= 64; i++) {
          const x = i / 64 * W, y = ys + reach * (0.6 + 0.4 * (vnoise(x * 0.005 + w.sd, w.sd) * 0.5 + 0.5)) + 5 * sk * Math.sin(x * 0.02 + w.sd);
          if (px != null) { if (a < 1.6) seaLine(st, px, py, x, y, al * dt * 5, 1.1); washP.moveTo(px, py); washP.lineTo(x, y); }
          px = x; py = y;
        }
      }
      c.strokeStyle = `rgba(150,240,255,${0.35 * glo})`; c.lineWidth = Math.max(1, 1.2 * sk); c.stroke(washP);
      // ---- lay the glow over the picture
      {
        const f = st.fld, d = st.img.data, L = SEA_LUT;
        for (let i = 0, o = 0; i < f.length; i++, o += 4) { const v = f[i]; let q = (v * 72.86) | 0; if (q > 255) q = 255; if (q < 0) q = 0; const l = q * 3; d[o] = L[l]; d[o + 1] = L[l + 1]; d[o + 2] = L[l + 2]; d[o + 3] = 255; }
        st.gx.putImageData(st.img, 0, 0);
        const r0 = Math.max(0, Math.floor(hy * st.fs) - 1);              // (the sky holds no glow: only the water and the sand are laid over)
        c.globalCompositeOperation = 'lighter'; c.imageSmoothingEnabled = true; c.drawImage(st.gc, 0, r0, gw, gh - r0, 0, r0 / st.fs, W, H - r0 / st.fs);
        // the wet sand mirrors the glow of the surf
        const by = Math.floor(ys * st.fs) - 1, bh = Math.min(gh - by, Math.round((ys - hy) * st.fs * 0.6));
        c.save(); c.beginPath(); c.rect(0, ys, W, H - ys); c.clip(); c.globalAlpha = 0.32; c.translate(0, ys * 2); c.scale(1, -1.15);
        if (bh > 2) c.drawImage(st.gc, 0, by - bh, gw, bh, 0, ys - bh / st.fs, W, bh / st.fs);
        c.restore(); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      }
      lit.forEach((pp, i) => { c.strokeStyle = i ? 'rgba(230,252,255,0.9)' : 'rgba(120,230,255,0.6)'; c.lineWidth = Math.max(1, (1 + i) * sk); c.stroke(pp); });
      // the sparks: points of light that flare and fade
      if (st.pt.length > 2500) st.pt.splice(0, st.pt.length - 2500);
      const SP = [new Path2D(), new Path2D()];
      st.pt = st.pt.filter(q => { const a = T - q.t; if (a > q.life) return false; q.x += q.vx * dt; q.y += q.vy * dt; q.vy += 120 * sk * dt;
        const br = q.b * (1 - a / q.life), d = Math.max(1, 2 * sk * (0.6 + br)); if (br > 0.08) SP[br > 0.5 ? 1 : 0].rect(q.x - d / 2, q.y - d / 2, d, d); return true; });
      c.fillStyle = 'rgba(110,225,255,0.7)'; c.fill(SP[0]); c.fillStyle = 'rgba(235,253,255,0.95)'; c.fill(SP[1]);
      if (fl > 0.02) { const q = c.createLinearGradient(0, 0, 0, ys); q.addColorStop(0, `rgba(120,140,190,${0.2 * fl})`); q.addColorStop(0.45, `rgba(150,175,225,${0.26 * fl})`); q.addColorStop(1, `rgba(40,170,255,${0.08 * fl})`); c.fillStyle = q; c.fillRect(0, 0, W, ys); }
    },
  };

  return [murm, umbrellas, marbling, cymatics, seaglow];
})();
