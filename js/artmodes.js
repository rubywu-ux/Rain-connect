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

  /* ============================================================== 1  Currents
     Every place where it is raining right now becomes a source in a slowly turning sunflower spiral
     (in east-to-west order); heavier rain = a brighter source that releases more ink. The ink drifts
     through an invisible current that swirls around the middle, leaving long trails. A storm churns the
     current and speeds it up; calm thins it to a few slow threads. A breath on the mist stirs it at once
     and blows the ink away from the side of the pot it came from. */
  const currents = {
    name: 'currents', title: 'Currents',
    draw(R, c, E) {
      const { T, dt, W: Wd, H: Hd, s, lw, st, storm, pres, e } = E, boost = E.boost;
      // long trails need a very soft fade, but on 8-bit pixels a very soft fade never quite reaches the
      // background (faint tinted ghosts stay behind). Every 4th frame a stronger pass clears them.
      st.n = (st.n || 0) + 1;
      const fa = E.fresh ? 1 : (st.n % 4 === 0 ? 0.16 : 0.055) + 0.05 * storm + 0.025 * e;
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = `rgba(${PAL.bg},${fa})`;
      c.fillRect(0, 0, Wd, Hd);
      const cx = Wd / 2, cy = Hd * 0.5, R0 = Math.min(Wd, Hd) * 0.42, rot = T * 0.012;
      // sources: the raining places, on a golden-angle spiral
      const sites = [...E.sites].sort((a, b) => a.u - b.u), n = sites.length;
      const src = sites.map((z, i) => {
        const a = i * 2.39996 + rot, r = R0 * Math.sqrt((i + 0.6) / Math.max(1, n));
        return { x: cx + Math.cos(a) * r * 1.35, y: cy + Math.sin(a) * r * 0.82, k: z.k, id: z.id };
      });
      // the ink
      const P = st.P || (st.P = []);
      const MAX = 3400;
      for (const z of src) {
        let m = (3 + 26 * z.k * z.k) * (0.25 + pres) * (1 + 1.2 * storm + 0.5 * e) * dt;
        while (m > 0 && P.length < MAX) {
          if (m < 1 && rnd() > m) break;
          m -= 1;
          const a = rnd() * TAU, r = rnd() * (3 + 10 * z.k) * s;
          P.push({ x: z.x + Math.cos(a) * r, y: z.y + Math.sin(a) * r, px: 0, py: 0, age: 0, life: 4 + 6 * rnd() * (0.5 + z.k), k: z.k });
        }
      }
      // the current drifts through time; integrated, so a sudden breath speeds it up without a jump
      st.ph = (st.ph == null ? (T * 0.03) % 1000 : st.ph) + dt * (0.03 + 0.1 * storm + 0.45 * e);
      const fq = 0.0019 / s * (1 + 0.8 * storm + 0.7 * e), sp = (18 + 22 * pres + 150 * storm + 120 * e) * s;
      const turb = 1.3 + storm + 1.3 * e;
      // the breath: wind from the side of the pot where the mist moves
      const gust = 230 * s * e * (0.75 + 0.25 * Math.sin(T * 3.1)), gx = -E.mx * gust, gy = -E.my * gust * 0.7;
      const L = [new Path2D(), new Path2D(), new Path2D()];
      let keep = 0;
      for (let i = 0; i < P.length; i++) {
        const q = P[i];
        q.age += dt;
        if (q.age > q.life || q.x < -40 || q.y < -40 || q.x > Wd + 40 || q.y > Hd + 40) continue;
        q.px = q.x; q.py = q.y;
        const ang = TAU * fbm(q.x * fq + 3.1, q.y * fq - st.ph) * turb;
        const dx = q.x - cx, dy = q.y - cy, dd = Math.hypot(dx, dy) + 1;
        // the current: noise + a slow swirl around the middle + a gentle drift outward (+ the breath)
        const vx = Math.cos(ang) * sp - dy / dd * sp * 0.55 + dx / dd * sp * 0.12 + gx;
        const vy = Math.sin(ang) * sp + dx / dd * sp * 0.55 + dy / dd * sp * 0.12 + gy;
        const [ix, iy] = R.disp(q.x / s + R.view.x, q.y / s + R.view.y, T);   // taps push the ink
        q.x += vx * dt + ix * 0.05 * s; q.y += vy * dt + iy * 0.05 * s;
        const f = q.age / q.life, env = Math.sin(Math.PI * f) * (0.45 + 0.55 * q.k);
        const b = env > 0.55 ? 2 : env > 0.28 ? 1 : 0;
        L[b].moveTo(q.px, q.py); L[b].lineTo(q.x, q.y);
        P[keep++] = q;
      }
      P.length = keep;
      c.globalCompositeOperation = PAL.comp;
      c.lineCap = 'round';
      [[0.07, 0.6], [0.16, 0.8], [0.32, 1.0]].forEach(([al, wd], b) => {
        c.strokeStyle = `rgba(${PAL.ink},${Math.min(1, al * boost)})`; c.lineWidth = lw * wd; c.stroke(L[b]);
      });
      // the sources themselves: a soft breathing point, bigger where it rains harder
      for (const z of src) {
        const pulse = 0.75 + 0.25 * Math.sin(T * (0.6 + z.k) + z.id), r = (1.5 + 5 * z.k) * s * pulse;
        const g = c.createRadialGradient(z.x, z.y, 0, z.x, z.y, r * 3);
        g.addColorStop(0, `rgba(${PAL.ink},${(0.012 + 0.03 * z.k) * (0.4 + 0.6 * pres) * (INK ? 0.45 : 1)})`); g.addColorStop(1, `rgba(${PAL.ink},0)`);
        c.fillStyle = g; c.beginPath(); c.arc(z.x, z.y, r * 3, 0, TAU); c.fill();
        c.fillStyle = `rgba(${PAL.ink},${0.12 + 0.25 * z.k})`; c.fillRect(z.x - lw * 0.7, z.y - lw * 0.7, lw * 1.4, lw * 1.4);
      }
    },
  };

  /* ============================================================== 2  Planet
     The Earth as a slowly turning sphere of dots (land on an even lattice, plus all 320 points checked
     for rain, at their true latitude and longitude). Where it is raining a glowing column rises from the
     surface: taller and hotter where it rains harder (deep blue -> violet -> white). A breath spins the
     planet faster (blowing from the left turns its face to the right) and leans it toward the blow; a
     storm makes the columns flicker and throws arcs between nearby raining places. */
  const PLANET_COL = [[38, 78, 255], [72, 92, 255], [122, 84, 255], [176, 92, 255], [232, 128, 255], [255, 236, 255]];
  const unit = (lat, lon) => { const f = lat * Math.PI / 180, l = lon * Math.PI / 180; return [Math.cos(f) * Math.sin(l), Math.sin(f), Math.cos(f) * Math.cos(l)]; };
  function planetSetup(st, W, H, dpr) {
    st.W = W; st.H = H;
    const R0 = Math.min(W, H) * 0.35, D = 3.6, Rb = R0 * D / Math.sqrt(D * D - 1);
    Object.assign(st, { R0, D, Rb });
    // deep navy into black, faint nebulae, a dust of stars
    const bg = st.bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) * 0.62);
    gr.addColorStop(0, '#0d1b44'); gr.addColorStop(0.32, '#081230'); gr.addColorStop(0.68, '#030718'); gr.addColorStop(1, '#010208');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (const [x, y, r, col, a] of [[0.16, 0.22, 0.55, '96,60,210', 0.12], [0.86, 0.78, 0.5, '30,110,210', 0.1], [0.74, 0.12, 0.32, '170,60,200', 0.06], [0.3, 0.9, 0.4, '40,60,180', 0.07]]) {
      const q = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W);
      q.addColorStop(0, `rgba(${col},${a})`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.fillRect(0, 0, W, H);
    }
    for (let i = 0; i < 700; i++) {
      const x = hash(i * 3 + 11) * W, y = hash(i * 3 + 12) * H, b = hash(i * 3 + 13);
      g.fillStyle = `rgba(${b > 0.93 ? '255,236,214' : b > 0.6 ? '206,218,255' : '160,175,235'},${0.12 + 0.6 * b * b})`;
      const d = b > 0.985 ? 2 : b > 0.75 ? 1.3 : 0.8;
      g.fillRect(x, y, d, d);
    }
    // the body: a navy night side with a lit limb and a thin atmosphere
    const S = Math.ceil(Rb * 2.9), body = st.body = canvas(S * dpr, S * dpr), b = body.getContext('2d'), m = S / 2;
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    gr = b.createRadialGradient(m, m, Rb * 0.97, m, m, Rb * 1.42);
    gr.addColorStop(0, 'rgba(80,140,255,0.34)'); gr.addColorStop(0.22, 'rgba(70,100,240,0.13)'); gr.addColorStop(1, 'rgba(40,60,200,0)');
    b.fillStyle = gr; b.fillRect(0, 0, S, S);
    gr = b.createRadialGradient(m - Rb * 0.4, m - Rb * 0.45, Rb * 0.05, m, m, Rb * 1.02);
    gr.addColorStop(0, '#1a3478'); gr.addColorStop(0.5, '#0b1844'); gr.addColorStop(1, '#040a24');
    b.fillStyle = gr; b.beginPath(); b.arc(m, m, Rb, 0, TAU); b.fill();
    gr = b.createRadialGradient(m, m, Rb * 0.7, m, m, Rb);
    gr.addColorStop(0, 'rgba(90,150,255,0)'); gr.addColorStop(1, 'rgba(120,175,255,0.3)');
    b.fillStyle = gr; b.beginPath(); b.arc(m, m, Rb, 0, TAU); b.fill();
    b.strokeStyle = 'rgba(160,200,255,0.5)'; b.lineWidth = 1.2; b.beginPath(); b.arc(m, m, Rb, 0, TAU); b.stroke();
    st.S = S;
    // land as an even lattice of dots, so the continents show
    if (!st.land) {
      st.land = [];
      const N = 11000, ga = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i + 0.5) / N * 2, lat = Math.asin(y) * 180 / Math.PI;
        const lon = ((i * ga * 180 / Math.PI) % 360) - 180;
        if (typeof isLand === 'function' && isLand(lat, lon)) st.land.push(unit(lat, lon));
      }
      st.eq = [];                                   // the equator, as a dotted line
      for (let i = 0; i < 180; i++) st.eq.push(unit(0, i * 2 - 180));
    }
  }
  const planet = {
    name: 'globe', title: 'Planet', dark: true,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E);
      if (st.W !== W || st.H !== H || !st.bg) planetSetup(st, W, H, E.dpr);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(st.bg, 0, 0, W, H);
      const cx = W / 2, cy = H / 2, R0 = st.R0, D = st.D, lim = 1 / D;
      // motion. A breath spins it up (it keeps turning a while after, then settles) and leans it
      const spin = 0.05 + 0.05 * (1 - calm) + 0.3 * storm + e * (1.1 + 1.3 * wx);
      st.w = st.w == null ? spin : st.w + (spin - st.w) * (1 - Math.exp(-dt * (Math.abs(spin) > Math.abs(st.w) ? 5 : 0.6)));
      st.yaw = (st.yaw == null ? (T * 0.06) % TAU : st.yaw) + st.w * dt;
      const pT = 0.38 + 0.6 * e * wy + 0.05 * storm * Math.sin(T * 2.3), rT = -0.55 * e * wx + 0.06 * storm * Math.sin(T * 1.7) - 0.12;
      const kt = 1 - Math.exp(-dt * 3);
      st.p = st.p == null ? pT : st.p + (pT - st.p) * kt; st.r = st.r == null ? rT : st.r + (rT - st.r) * kt;
      const cyw = Math.cos(st.yaw), syw = Math.sin(st.yaw), cp = Math.cos(st.p), sp = Math.sin(st.p), cr = Math.cos(st.r), sr = Math.sin(st.r);
      // rotation = roll(r) * pitch(p) * yaw(y)
      const m00 = cyw * cr - syw * sp * sr, m01 = -cp * sr, m02 = syw * cr + cyw * sp * sr;
      const m10 = cyw * sr + syw * sp * cr, m11 = cp * cr, m12 = syw * sr - cyw * sp * cr;
      const m20 = -syw * cp, m21 = sp, m22 = cyw * cp;
      const P = [0, 0, 0, 0];                                       // projected x, y, depth z, perspective k
      const proj = (v, rad) => {
        const X = v[0] * rad, Y = v[1] * rad, Z = v[2] * rad;
        const z = m20 * X + m21 * Y + m22 * Z, k = D / (D - z);
        P[0] = cx + (m00 * X + m01 * Y + m02 * Z) * R0 * k; P[1] = cy - (m10 * X + m11 * Y + m12 * Z) * R0 * k; P[2] = z; P[3] = k;
        return P;
      };
      c.drawImage(st.body, cx - st.S / 2, cy - st.S / 2, st.S, st.S);
      c.globalCompositeOperation = 'lighter';
      // the breath and the storm light up the air around it; calm gives a soft, bright halo
      const halo = Math.min(1, 0.55 * e + 0.3 * storm + 0.22 * calm);
      if (halo > 0.01) { c.globalAlpha = halo; const g = glow('70,120,255', 256, 0.3), z = st.Rb * 3.4; c.drawImage(g, cx - z / 2, cy - z / 2, z, z); c.globalAlpha = 1; }
      // dots: the far side faintly through the planet, the near side brighter toward the middle
      const back = new Path2D(), fr = [new Path2D(), new Path2D(), new Path2D()], ocean = [new Path2D(), new Path2D()];
      const d0 = lw * 0.85;
      for (const v of st.land) {
        proj(v, 1);
        if (P[2] < lim) { if (P[2] < -0.3) back.rect(P[0] - 0.5, P[1] - 0.5, 1, 1); continue; }
        const d = d0 * P[3] * (0.7 + 0.5 * P[2]);
        fr[P[2] > 0.75 ? 2 : P[2] > 0.4 ? 1 : 0].rect(P[0] - d / 2, P[1] - d / 2, d, d);
      }
      for (const v of st.eq) {
        proj(v, 1);
        if (P[2] > lim) ocean[0].rect(P[0] - 0.6, P[1] - 0.6, 1.2, 1.2);
      }
      const pts = points(E), rain = [];
      for (const q of pts) {
        if (!q.v) q.v = unit(q.lat, q.lon);
        if (q.rain) { rain.push(q); continue; }
        proj(q.v, 1);
        if (P[2] < lim) continue;
        const d = lw * 1.1 * P[3];                                   // the other places checked: dry right now
        ocean[1].rect(P[0] - d / 2, P[1] - d / 2, d, d);
      }
      c.fillStyle = 'rgba(120,160,255,0.09)'; c.fill(back);
      ['0.3', '0.55', '0.85'].forEach((a, i) => { c.fillStyle = `rgba(150,200,255,${a})`; c.fill(fr[i]); });
      c.fillStyle = 'rgba(120,150,255,0.28)'; c.fill(ocean[0]);
      c.fillStyle = 'rgba(200,190,255,0.32)'; c.fill(ocean[1]);
      // the rain: a glowing footprint on the surface and a column of light above it
      const pres = 0.6 + 0.4 * E.pres, NB = PLANET_COL.length;
      const lo = [], hi = [], glo = [], tops = [];
      for (let b = 0; b < NB * 2; b++) { lo.push(new Path2D()); hi.push(new Path2D()); glo.push(new Path2D()); }
      for (let i = 0; i < rain.length; i++) {
        const q = rain[i], k = q.k;
        const surge = 1 + e * 0.75 * (0.6 + 0.4 * Math.sin(T * 7 + i * 1.7)) + storm * 0.35 * (rnd() - 0.3);
        const h = (0.025 + 0.16 * k * k + 0.035 * k) * pres * surge * (1 + 0.08 * Math.sin(T * (0.8 + k) + i));
        const [bx, by, bz, bk] = proj(q.v, 1);
        const [mx_, my_] = proj(q.v, 1 + h * 0.45);
        const [tx, ty, tz, tk] = proj(q.v, 1 + h);
        const far = tz < lim + 0.04 ? 1 : 0;                       // behind the limb: seen through the planet, dimmer
        tops.push([tx, ty, tk, k, far, bx, by, bz, bk]);
        if (storm > 0.05 && rnd() < storm * 0.3) continue;          // flicker
        const b = Math.min(NB - 1, Math.floor((k - 0.12) / 0.88 * NB)) + far * NB;
        lo[b].moveTo(bx, by); lo[b].lineTo(mx_, my_);
        hi[b].moveTo(mx_, my_); hi[b].lineTo(tx, ty);
        glo[b].moveTo(bx, by); glo[b].lineTo(tx, ty);
      }
      for (const [, , , k, , bx, by, bz, bk] of tops) {
        if (bz < lim) continue;
        const b = Math.min(NB - 1, Math.floor((k - 0.12) / 0.88 * NB)), z = (16 + 46 * k) * s * bk * (0.9 + 0.35 * e);
        c.globalAlpha = (0.35 + 0.4 * k) * (0.4 + 0.6 * bz);
        c.drawImage(glow(PLANET_COL[b].join(','), 64, 0.18), bx - z / 2, by - z / 2, z, z);
      }
      c.globalAlpha = 1;
      c.lineCap = 'round';
      for (let b = 0; b < NB * 2; b++) {
        const far = b >= NB, kb = (b % NB + 0.5) / NB, col = PLANET_COL[b % NB].join(','), fa = far ? 0.22 : 1;
        c.strokeStyle = `rgba(${col},${0.12 * fa})`; c.lineWidth = lw * (3.5 + 5 * kb); c.stroke(glo[b]);
        c.strokeStyle = `rgba(${col},${0.5 * fa})`; c.lineWidth = lw * (0.8 + 1.2 * kb); c.stroke(lo[b]);
        c.strokeStyle = `rgba(${col},${0.95 * fa})`; c.lineWidth = lw * (0.9 + 1.4 * kb); c.stroke(hi[b]);
      }
      for (const [tx, ty, tk, k, far] of tops) {
        const b = Math.min(NB - 1, Math.floor((k - 0.12) / 0.88 * NB)), g = glow(PLANET_COL[b].join(','), 64, 0.25);
        const z = (7 + 18 * k) * s * tk * (1 + 0.4 * e);
        c.globalAlpha = far ? 0.22 : 0.9;
        c.drawImage(g, tx - z / 2, ty - z / 2, z, z);
        if (k > 0.75 && !far) { const w = glow('255,250,255', 32, 0.3); c.drawImage(w, tx - z / 5, ty - z / 5, z / 2.5, z / 2.5); }
      }
      c.globalAlpha = 1;
      // storm: arcs leap between raining places near each other
      if (storm > 0.08 && rain.length > 1) {
        if (st.arcKey !== pts) {
          st.arcKey = pts; st.pairs = [];
          for (let i = 0; i < rain.length; i++) for (let j = i + 1; j < rain.length; j++) {
            const a = rain[i].v, b = rain[j].v, dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
            if (dot > Math.cos(0.5)) st.pairs.push([rain[i], rain[j], Math.acos(Math.min(1, dot))]);
          }
          st.pairs = st.pairs.sort((p, q) => p[2] - q[2]).slice(0, 80);
        }
        const arcs = new Path2D();
        for (const [A, B] of st.pairs) {
          if (rnd() > storm * 0.45) continue;
          const ha = 0.025 + 0.16 * A.k * A.k + 0.035 * A.k, hb = 0.025 + 0.16 * B.k * B.k + 0.035 * B.k;
          let first = true;
          for (let n = 0; n <= 12; n++) {
            const t = n / 12, v = [lerp(A.v[0], B.v[0], t), lerp(A.v[1], B.v[1], t), lerp(A.v[2], B.v[2], t)], l = Math.hypot(v[0], v[1], v[2]);
            const rad = (1 + lerp(ha, hb, t) * pres + Math.sin(Math.PI * t) * 0.07) / l;
            proj(v, rad);
            if (P[2] < lim) { first = true; continue; }
            const j = n > 0 && n < 12 ? (rnd() - 0.5) * 10 * s * storm : 0;
            if (first) { arcs.moveTo(P[0] + j, P[1] + j); first = false; } else arcs.lineTo(P[0] + j, P[1] - j);
          }
        }
        c.strokeStyle = `rgba(170,120,255,${0.16 * storm})`; c.lineWidth = lw * 5; c.stroke(arcs);
        c.strokeStyle = `rgba(240,225,255,${0.85 * storm})`; c.lineWidth = lw * 0.9; c.stroke(arcs);
      }
      c.globalCompositeOperation = 'source-over';
    },
  };

  /* ============================================================== 3  Rain Garden
     Each raining place is a flower growing from the ground: across by longitude, taller and fuller where
     it rains harder, with as many petals as the kind of rain (drizzle 5, rain 6, showers 7,
     thunderstorm 8) and coloured by latitude: warm coral and orange in the tropics, teal and green in the
     middle latitudes, icy lavender near the poles. Paper in the light theme, dusk in the dark.
     A breath bends the stems and the grass away from it; a storm tears the petals off and the wind carries
     them away (they grow back once it is calm); in calm the flowers open fully and stand still. */
  function latColor(lat) {
    const a = Math.abs(lat);
    const S = [[0, 12, 86, 63], [16, 22, 92, 61], [24, 40, 92, 58], [31, 96, 52, 50], [41, 166, 58, 45], [52, 190, 58, 52], [61, 250, 55, 72], [90, 268, 45, 84]];
    for (let i = 1; i < S.length; i++) if (a <= S[i][0]) {
      const p = S[i - 1], q = S[i], t = (a - p[0]) / (q[0] - p[0]);
      return [lerp(p[1], q[1], t), lerp(p[2], q[2], t), lerp(p[3], q[3], t)];
    }
    return S[S.length - 1].slice(1);
  }
  const petalsOf = code => code == null ? 6 : code >= 95 ? 8 : code >= 80 ? 7 : code >= 61 ? 6 : code >= 51 ? 5 : 6;
  function gardenSetup(st, W, H, dpr, light, s) {
    st.W = W; st.H = H; st.light = light;
    const bg = st.bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, H);
    if (light) { gr.addColorStop(0, '#f5f0e6'); gr.addColorStop(0.6, '#f1e9dc'); gr.addColorStop(1, '#e9dfcf'); }
    else { gr.addColorStop(0, '#0f1230'); gr.addColorStop(0.38, '#272150'); gr.addColorStop(0.64, '#56315a'); gr.addColorStop(0.8, '#a2525a'); gr.addColorStop(0.9, '#d07a5c'); gr.addColorStop(1, '#2b1a2c'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // a low sun (paper) or the last glow of one (dusk)
    gr = g.createRadialGradient(W * 0.72, H * 0.8, 0, W * 0.72, H * 0.8, W * 0.5);
    gr.addColorStop(0, light ? 'rgba(255,214,170,0.35)' : 'rgba(255,170,120,0.35)'); gr.addColorStop(1, 'rgba(255,170,120,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    if (!light) for (let i = 0; i < 160; i++) {
      const b = hash(i * 7 + 3);
      g.fillStyle = `rgba(255,240,230,${(0.1 + 0.5 * b * b) * (1 - hash(i * 7 + 2))})`;
      g.fillRect(hash(i * 7 + 1) * W, Math.pow(hash(i * 7 + 2), 1.6) * H * 0.55, b > 0.9 ? 1.6 : 1, b > 0.9 ? 1.6 : 1);
    }
    // two rows of far hills
    [[0.74, 0.07, 0.0016, light ? 'rgba(160,178,150,0.28)' : 'rgba(46,30,66,0.85)'], [0.81, 0.05, 0.0026, light ? 'rgba(138,160,128,0.32)' : 'rgba(30,22,46,0.95)']].forEach(([y0, amp, f, col], n) => {
      g.beginPath(); g.moveTo(0, H);
      for (let x = 0; x <= W + 8; x += 8) g.lineTo(x, H * (y0 + amp * fbm(x * f + n * 9.1, 3.3 + n)));
      g.lineTo(W, H); g.closePath(); g.fillStyle = col; g.fill();
    });
    if (light) {                                          // paper grain
      for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(90,70,40,${0.02 + 0.05 * hash(i * 5 + 1)})`; g.fillRect(hash(i * 5 + 2) * W, hash(i * 5 + 3) * H, 1, 1); }
      gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.hypot(W, H) * 0.62);
      gr.addColorStop(0, 'rgba(120,90,60,0)'); gr.addColorStop(1, 'rgba(120,90,60,0.16)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    // grass blades: a row behind the flowers and a row in front
    st.grass = [[], []];
    for (let L = 0; L < 2; L++) {
      const n = Math.round(W / (L ? 7 : 6));
      for (let i = 0; i < n; i++) {
        const sd = i * 13 + L * 7001;
        st.grass[L].push({ x: (i + hash(sd)) / n * W, h: H * (L ? 0.05 + 0.08 * hash(sd + 1) : 0.06 + 0.07 * hash(sd + 1)) * (0.6 + 0.6 * hash(sd + 5) * hash(sd + 5)),
                           w: (1.4 + 1.6 * hash(sd + 2)) * s * 0.85, tone: Math.floor(hash(sd + 3) * 3), ph: hash(sd + 4) * TAU });
      }
    }
  }
  const garden = {
    name: 'garden', title: 'Rain Garden',
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), light = E.light, wx = windX(E);
      if (st.W !== W || st.H !== H || st.light !== light || !st.bg) gardenSetup(st, W, H, E.dpr, light, s);
      c.globalCompositeOperation = 'source-over';
      c.drawImage(st.bg, 0, 0, W, H);
      const dir = Math.abs(wx) > 0.15 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      // the wind right now: the breath (direction from where the mist moves), storm gusts on top
      const wave = x => 0.5 + 0.5 * Math.sin(x * 0.0045 - T * 2.6 * dir);
      const windAt = x => wx * e * 1.15 * (0.65 + 0.35 * wave(x)) + dir * storm * (0.35 + 0.45 * wave(x));
      const stillness = 1 - 0.85 * calm;
      // a little rain falls through the garden
      const nr = Math.round((20 + 90 * (1 - calm) + 260 * storm) * W / 1600), rain = new Path2D();
      const slant = clamp(windAt(W / 2) * 0.9, -1.2, 1.2);
      for (let i = 0; i < nr; i++) {
        const v = (520 + 380 * hash(i * 3 + 1)) * s * (1 + 0.6 * storm), span = H + 160;
        const y = ((hash(i * 3 + 2) * span + T * v) % span) - 80, len = (10 + 18 * hash(i * 3 + 4)) * s * (1 + storm);
        const x = hash(i * 3 + 3) * (W + 400) - 200 + y * slant * 0.5;
        rain.moveTo(x, y); rain.lineTo(x - slant * len * 0.5, y - len);
      }
      c.strokeStyle = light ? 'rgba(80,100,135,0.2)' : 'rgba(205,215,255,0.16)'; c.lineWidth = lw * 0.6; c.stroke(rain);
      const grassTones = light ? ['118,146,104', '96,128,90', '140,162,118'] : ['20,30,34', '14,22,26', '30,40,44'];
      const drawGrass = (row, alpha) => {
        const P = [new Path2D(), new Path2D(), new Path2D()];
        for (const b of row) {
          const lean = windAt(b.x) * 0.75 + 0.07 * Math.sin(T * 1.2 + b.ph + b.x * 0.01) * stillness * (1 + 2 * e);
          const by = H + 4, tx = b.x + Math.sin(lean) * b.h, ty = by - Math.cos(lean) * b.h;
          const qx = b.x + Math.sin(lean * 0.45) * b.h * 0.55, qy = by - b.h * 0.55;
          const p = P[b.tone];
          p.moveTo(b.x - b.w, by); p.quadraticCurveTo(qx - b.w * 0.5, qy, tx, ty); p.quadraticCurveTo(qx + b.w * 0.5, qy, b.x + b.w, by); p.closePath();
        }
        P.forEach((p, i) => { c.fillStyle = `rgba(${grassTones[i]},${alpha})`; c.fill(p); });
      };
      drawGrass(st.grass[0], light ? 0.55 : 0.9);
      // the flowers, far ones first
      const fl = st.fl || (st.fl = new Map()), seen = new Set(), list = [];
      for (const z of E.sites) {
        seen.add(z.id);
        let f = fl.get(z.id);
        if (!f) {
          const lat = 90 - z.v * 180, [h, sa, l] = latColor(lat);
          f = { id: z.id, th: 0, om: 0, lost: 0, grow: E.fresh ? 0.6 : 0, d: hash(z.id * 7 + 1), h: h + (hash(z.id * 7 + 2) - 0.5) * 14, sa, l,
                rot0: hash(z.id * 7 + 3) * TAU, h1: hash(z.id * 7 + 4), h2: hash(z.id * 7 + 5) };
          fl.set(z.id, f);
        }
        f.k = z.k; f.n = petalsOf(codeOf(E, z));
        f.grow = Math.min(1, f.grow + dt * 0.45);
        const sc = 0.72 + 0.42 * f.d;
        f.x = W * (0.04 + 0.92 * z.u) + (hash(z.id * 3) - 0.5) * W * 0.014;
        f.y = H * (0.925 + (f.d - 0.5) * 0.06);
        f.L = H * (0.13 + 0.46 * z.k) * sc * (0.82 + 0.3 * f.h2) * (0.25 + 0.75 * smoothstep(0, 1, f.grow));
        f.rB = (8 + 22 * z.k) * s * sc * smoothstep(0.2, 1, f.grow);
        list.push(f);
      }
      for (const id of [...fl.keys()]) if (!seen.has(id)) fl.delete(id);
      list.sort((a, b) => a.d - b.d);
      const fly = st.fly || (st.fly = []);
      const stems = new Path2D(), leaves = new Path2D(), stam = new Path2D();
      for (const f of list) {
        // a springy stem: the wind pushes, it sways back
        const sway = (0.012 + 0.2 * e + 0.22 * storm) * stillness * Math.sin(T * (1.1 + 0.9 * f.h1) + f.h2 * TAU);
        const target = clamp(windAt(f.x) * (0.45 + 0.55 * f.k) + sway, -1.15, 1.15);
        f.om += ((target - f.th) * 16 - f.om * 4.2) * dt; f.th += f.om * dt;
        const th = f.th, L = f.L, bx = f.x, by = f.y;
        f.tx = bx + Math.sin(th) * L * 0.97; f.ty = by - Math.cos(th) * L * 0.97;
        const qx = bx + Math.sin(th * 0.35) * L * 0.55, qy = by - Math.cos(th * 0.35) * L * 0.55;
        stems.moveTo(bx, by); stems.quadraticCurveTo(qx, qy, f.tx, f.ty);
        for (const [t, side] of [[0.3, f.h1 < 0.5 ? 1 : -1], [0.52, f.h1 < 0.5 ? -1 : 1]]) {
          if (f.k < 0.3 && t > 0.4) continue;
          const u = 1 - t, px = u * u * bx + 2 * u * t * qx + t * t * f.tx, py = u * u * by + 2 * u * t * qy + t * t * f.ty;
          const ang = Math.atan2(f.ty - by, f.tx - bx) + side * (0.95 - 0.25 * t) + windAt(f.x) * 0.4 + Math.sin(T * 3 + f.h2 * 9) * 0.12 * e;
          const ll = Math.min(L * (0.11 + 0.04 * f.h2), 70 * s), lwd = ll * 0.3, ca = Math.cos(ang), sa = Math.sin(ang);
          leaves.moveTo(px, py);
          leaves.quadraticCurveTo(px + ca * ll * 0.5 - sa * lwd, py + sa * ll * 0.5 + ca * lwd, px + ca * ll, py + sa * ll);
          leaves.quadraticCurveTo(px + ca * ll * 0.5 + sa * lwd, py + sa * ll * 0.5 - ca * lwd, px, py);
        }
        // a storm tears petals off; they fly with the wind
        if (storm > 0.12 && f.lost < f.n - 1 && rnd() < storm * (0.25 + 2.2 * e) * (0.5 + 0.5 * f.k) * dt) {
          const j = Math.floor(f.lost), a = f.rot0 + j * TAU / f.n;
          f.lost += 1;
          if (fly.length < 260) fly.push({ x: f.tx + Math.cos(a) * f.rB * 0.6, y: f.ty + Math.sin(a) * f.rB * 0.5, vx: dir * (60 + 160 * rnd()) * s, vy: -(20 + 60 * rnd()) * s,
            a, va: (rnd() - 0.5) * 9, fp: rnd() * TAU, fv: 3 + 6 * rnd(), L: f.rB * 0.9, w: f.rB * 1.6 / f.n + f.rB * 0.12, col: `hsl(${f.h},${f.sa}%,${f.l}%)`, age: 0, sd: rnd() * 100 });
        }
        if (storm < 0.1) f.lost = Math.max(0, f.lost - dt * 0.35);
      }
      c.lineCap = 'round';
      c.strokeStyle = light ? 'rgba(78,106,76,0.85)' : 'rgba(16,30,30,0.95)'; c.lineWidth = lw * 1.25; c.stroke(stems);
      c.fillStyle = light ? 'rgba(104,138,92,0.8)' : 'rgba(18,36,34,0.95)'; c.fill(leaves);
      // heads: two rings of petals, a centre and its stamens
      const open = (1 - 0.25 * storm) * (1 - 0.08 * e);
      for (const f of list) {
        if (f.rB < 1) continue;
        const n = f.n, rB = f.rB * open, th = f.th, hx = f.tx, hy = f.ty;
        const rot = f.rot0 + T * 0.02 * (f.h1 - 0.5) + th * 0.6 + Math.sin(T * 6 + f.h2 * 20) * 0.12 * (e + storm);
        const sq = 0.8, ct = Math.cos(th), stt = Math.sin(th);
        const put = (path, px, py, a, move) => {                    // petal space -> screen (head tilted with the stem)
          const ca = Math.cos(a), sa = Math.sin(a);
          const ux = px * ca - py * sa, uy = (px * sa + py * ca) * sq;
          const X = hx + ux * ct - uy * stt, Y = hy + ux * stt + uy * ct;
          if (move) path.moveTo(X, Y); else return [X, Y];
        };
        const ring = (len, wid, off, skip) => {
          const p = new Path2D();
          for (let j = 0; j < n; j++) {
            if (j < skip) continue;
            const a = rot + (j + off) * TAU / n;
            put(p, 0, 0, a, true);
            const [x1, y1] = put(null, len * 0.3, -wid, a), [x2, y2] = put(null, len * 0.92, -wid * 0.7, a), [x3, y3] = put(null, len, 0, a);
            const [x4, y4] = put(null, len * 0.92, wid * 0.7, a), [x5, y5] = put(null, len * 0.3, wid, a), [x6, y6] = put(null, 0, 0, a);
            p.bezierCurveTo(x1, y1, x2, y2, x3, y3); p.bezierCurveTo(x4, y4, x5, y5, x6, y6);
          }
          return p;
        };
        const skip = Math.floor(f.lost);
        if (!light) {
          c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.28 * f.grow;
          const g = glow(hsl2rgb(Math.round(f.h / 10) * 10, f.sa, 60), 64, 0.2), z = rB * 4.2;
          c.drawImage(g, hx - z / 2, hy - z / 2, z, z);
          c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
        }
        const wid = rB * 1.75 / n + rB * 0.1, dl = light ? -4 : 2;
        const p1 = ring(rB, wid, 0, skip), p2 = ring(rB * 0.68, wid * 0.82, 0.5, skip);
        c.fillStyle = `hsl(${f.h + 6},${f.sa}%,${f.l - 12 + dl}%)`; c.fill(p1);
        if (light) { c.strokeStyle = `hsla(${f.h},${f.sa * 0.7}%,${f.l - 34}%,0.55)`; c.lineWidth = lw * 0.6; c.stroke(p1); }
        c.fillStyle = `hsl(${f.h - 4},${f.sa - 6}%,${Math.min(92, f.l + 8 + dl)}%)`; c.fill(p2);
        if (light) c.stroke(p2);
        const cr = rB * 0.2;
        c.fillStyle = f.h < 70 ? 'hsl(330,45%,26%)' : f.h < 230 ? 'hsl(44,85%,55%)' : 'hsl(50,70%,78%)';
        c.beginPath(); c.ellipse(hx, hy, cr, cr * sq, th, 0, TAU); c.fill();
        for (let q = 0; q < 9; q++) {
          const a = q * TAU / 9 + rot, d = cr * 1.35;
          stam.rect(hx + Math.cos(a) * d - lw * 0.6, hy + Math.sin(a) * d * sq - lw * 0.6, lw * 1.2, lw * 1.2);
        }
      }
      c.fillStyle = light ? 'rgba(120,70,40,0.7)' : 'rgba(255,230,170,0.85)'; c.fill(stam);
      // torn petals tumbling on the wind
      let keep = 0;
      const dpr = E.dpr;
      for (let i = 0; i < fly.length; i++) {
        const p = fly[i];
        p.age += dt;
        const wv = (wx * e * 300 + dir * storm * 340) * s * (0.7 + 0.3 * Math.sin(T * 2 + p.sd));
        p.vx += (wv - p.vx) * dt * 1.2; p.vy += (34 * s - p.vy * 0.45) * dt + Math.sin(T * 4 + p.sd) * 60 * s * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.a += p.va * dt; p.fp += p.fv * dt;
        if (p.age > 7 || p.x < -60 || p.x > W + 60 || p.y > H + 30) continue;
        fly[keep++] = p;
        const ca = Math.cos(p.a), sa = Math.sin(p.a), w = p.w * (0.2 + 0.8 * Math.abs(Math.cos(p.fp))), L = p.L;
        c.setTransform(ca * dpr, sa * dpr, -sa * dpr, ca * dpr, p.x * dpr, p.y * dpr);
        c.globalAlpha = Math.min(1, (7 - p.age) * 0.8);
        c.fillStyle = p.col;
        c.beginPath(); c.moveTo(-L / 2, 0);
        c.bezierCurveTo(-L * 0.2, -w, L * 0.42, -w * 0.7, L / 2, 0); c.bezierCurveTo(L * 0.42, w * 0.7, -L * 0.2, w, -L / 2, 0);
        c.fill();
      }
      fly.length = keep;
      c.setTransform(dpr, 0, 0, dpr, 0, 0); c.globalAlpha = 1;
      drawGrass(st.grass[1], light ? 0.85 : 1);
      // seeds (paper) or fireflies (dusk) drifting on the air: they show the breath too
      const motes = st.motes || (st.motes = Array.from({ length: 70 }, (_, i) => ({ x: hash(i * 3 + 1) * W, y: H * (0.3 + 0.6 * hash(i * 3 + 2)), sd: i })));
      const mp = new Path2D();
      for (const m of motes) {
        m.x += ((wx * e * 420 + dir * storm * 300) * s + 10 * s * Math.sin(T * 0.3 + m.sd)) * dt;
        m.y += (-6 * s + 14 * s * Math.sin(T * 0.7 + m.sd * 1.7) + (e + storm) * 30 * s * Math.sin(T * 5 + m.sd)) * dt;
        if (m.x < -20) m.x += W + 40; if (m.x > W + 20) m.x -= W + 40;
        if (m.y < H * 0.2) m.y = H * 0.95; if (m.y > H) m.y = H * 0.3;
        const d = lw * (light ? 1.2 : 1.6);
        mp.rect(m.x - d / 2, m.y - d / 2, d, d);
      }
      if (light) { c.fillStyle = 'rgba(110,90,60,0.5)'; c.fill(mp); }
      else {
        c.globalCompositeOperation = 'lighter';
        const tw = 0.5 + 0.5 * Math.sin(T * 1.7);
        c.fillStyle = `rgba(255,226,150,${0.55 + 0.3 * tw})`; c.fill(mp);
        const g = glow('255,200,120', 32, 0.25);
        for (let i = 0; i < motes.length; i += 3) { const m = motes[i], z = 14 * s * (0.6 + 0.4 * Math.sin(T * 2 + i)); c.globalAlpha = 0.5; c.drawImage(g, m.x - z / 2, m.y - z / 2, z, z); }
        c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      }
    },
  };

  /* ============================================================== 4  Radar
     A sonar / radar scope over the whole Earth, seen from above the North Pole (the edge is 60°S, the
     bearing is the longitude). A rotating beam leaves a phosphor-green afterglow; every place where it is
     raining shows up as an echo when the beam passes, then fades. A breath speeds the sweep up and fills
     the screen with static and jitter, thickest where the mist moved; a storm tears the picture into
     bands and sends interference across the whole screen; lightning shows as strikes on the scope. */
  const G = '96,255,150';
  const polar = (Rr, lat) => Rr * (90 - lat) / 150;
  function radarSetup(st, W, H, dpr, pts) {
    st.W = W; st.H = H; st.ptsRef = pts;
    const cx = W / 2, cy = H / 2, Rr = Math.min(W, H) * 0.44;
    Object.assign(st, { cx, cy, Rr });
    const sc = st.scope = canvas(W * dpr, H * dpr), g = sc.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#010402'; g.fillRect(0, 0, W, H);
    let gr = g.createRadialGradient(cx, cy, 0, cx, cy, Rr * 1.08);
    gr.addColorStop(0, '#06200f'); gr.addColorStop(0.7, '#031309'); gr.addColorStop(0.97, '#020a05'); gr.addColorStop(1, '#000');
    g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, Rr * 1.08, 0, TAU); g.fill();
    // the land, faint, like ground clutter
    g.fillStyle = `rgba(${G},0.09)`;
    if (typeof LAND_MASK !== 'undefined') for (let r = 0; r < 90; r++) for (let q = 0; q < 180; q++) {
      if (!LAND_MASK[r * 180 + q]) continue;
      const lat = 89 - r * 2, lon = -179 + q * 2;
      if (lat < -60) continue;
      const rr = polar(Rr, lat), a = lon * Math.PI / 180 - Math.PI / 2, d = 0.9 + rr / Rr * 1.2;
      g.fillRect(cx + Math.cos(a) * rr - d / 2, cy + Math.sin(a) * rr - d / 2, d, d);
    }
    // every point checked for rain, as a faint grid
    g.fillStyle = `rgba(${G},0.22)`;
    for (const p of pts) { if (p[0] < -60) continue; const rr = polar(Rr, p[0]), a = p[1] * Math.PI / 180 - Math.PI / 2; g.fillRect(cx + Math.cos(a) * rr - 0.7, cy + Math.sin(a) * rr - 0.7, 1.4, 1.4); }
    // range rings: 60N, 30N, the equator, 30S, and the edge at 60S
    g.lineWidth = 1;
    for (const lat of [60, 30, 0, -30]) {
      g.strokeStyle = `rgba(${G},${lat === 0 ? 0.3 : 0.15})`; g.setLineDash(lat === 0 ? [] : [2, 4]);
      g.beginPath(); g.arc(cx, cy, polar(Rr, lat), 0, TAU); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = `rgba(${G},0.55)`; g.lineWidth = 1.5; g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.stroke();
    // spokes and bearing ticks
    g.strokeStyle = `rgba(${G},0.1)`; g.lineWidth = 1; g.beginPath();
    for (let d = 0; d < 360; d += 30) { const a = d * Math.PI / 180 - Math.PI / 2; g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr); }
    g.stroke();
    g.strokeStyle = `rgba(${G},0.5)`; g.beginPath();
    for (let d = 0; d < 360; d += 2) {
      const a = d * Math.PI / 180 - Math.PI / 2, l = d % 30 === 0 ? 14 : d % 10 === 0 ? 8 : 4;
      g.moveTo(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr); g.lineTo(cx + Math.cos(a) * (Rr + l), cy + Math.sin(a) * (Rr + l));
    }
    g.stroke();
    const fs = Math.max(10, Math.round(Rr * 0.03));
    g.font = `400 ${fs}px "IBM Plex Mono", ui-monospace, Menlo, monospace`; g.fillStyle = `rgba(${G},0.6)`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let d = -180; d < 180; d += 30) {
      const a = d * Math.PI / 180 - Math.PI / 2, t = d === 0 ? '0°' : d === -180 ? '180°' : Math.abs(d) + (d > 0 ? 'E' : 'W');
      g.fillText(t, cx + Math.cos(a) * (Rr + 30), cy + Math.sin(a) * (Rr + 30));
    }
    g.fillStyle = `rgba(${G},0.38)`; g.textAlign = 'left';
    for (const [lat, t] of [[60, '60N'], [30, '30N'], [0, 'EQ'], [-30, '30S']]) g.fillText(t, cx + 4, cy - polar(Rr, lat) - fs * 0.7);
    // the glass: scanlines, a vignette, a faint reflection
    const crt = st.crt = canvas(W * dpr, H * dpr), k = crt.getContext('2d');
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    k.fillStyle = 'rgba(0,0,0,0.2)';
    for (let y = 0; y < H; y += 3) k.fillRect(0, y, W, 1);
    gr = k.createRadialGradient(cx, cy, Math.min(W, H) * 0.35, cx, cy, Math.hypot(W, H) * 0.58);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.85)');
    k.fillStyle = gr; k.fillRect(0, 0, W, H);
    gr = k.createLinearGradient(0, 0, W * 0.6, H);
    gr.addColorStop(0, 'rgba(200,255,220,0.035)'); gr.addColorStop(0.45, 'rgba(200,255,220,0)'); gr.addColorStop(1, 'rgba(200,255,220,0)');
    k.fillStyle = gr; k.fillRect(0, 0, W, H);
    st.buf = canvas(W * dpr, H * dpr); st.bctx = st.buf.getContext('2d');
  }
  const radar = {
    name: 'radar', title: 'Radar', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), dpr = E.dpr;
      if (st.W !== W || st.H !== H || st.ptsRef !== E.pts || !st.scope) radarSetup(st, W, H, dpr, E.pts);
      const tear = storm > 0.12;
      const g = tear ? st.bctx : c;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
      // a breath shakes the picture
      const jit = (e * 4 + storm * 3) * s, jx = (rnd() - 0.5) * jit, jy = (rnd() - 0.5) * jit * 0.6;
      g.drawImage(st.scope, jx, jy, W, H);
      const cx = st.cx + jx, cy = st.cy + jy, Rr = st.Rr;
      // the sweep: ~6 rpm in calm, much faster while someone blows
      const spdT = 0.55 * (1 - 0.3 * calm) + 4.2 * e + 1.4 * storm;
      st.spd = st.spd == null ? spdT : st.spd + (spdT - st.spd) * (1 - Math.exp(-dt * (spdT > st.spd ? 6 : 1.2)));
      const a0 = st.sw == null ? (T * 0.6) % TAU : st.sw, a1 = a0 + st.spd * dt;
      st.sw = a1 % TAU;
      const span = a1 - a0;
      g.globalCompositeOperation = 'lighter';
      if (calm > 0.02) { g.fillStyle = `rgba(${G},${0.035 * calm})`; g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.fill(); }
      // the afterglow behind the beam: its length follows the speed (the phosphor fades in time, not angle)
      const Ltr = clamp(0.5 + st.spd * 0.9, 0.6, 3.8), tA = 0.2 * (1 - 0.3 * calm);
      if (g.createConicGradient) {                                 // one smooth sweep of light
        const cg = g.createConicGradient(a1 - Ltr, cx, cy), f = Ltr / TAU;
        cg.addColorStop(0, `rgba(${G},0)`);
        for (let j = 1; j <= 8; j++) { const t = j / 8; cg.addColorStop(f * t, `rgba(${G},${tA * Math.exp(-3.4 * (1 - t))})`); }
        cg.addColorStop(Math.min(1, f + 0.0005), `rgba(${G},0)`); cg.addColorStop(1, `rgba(${G},0)`);
        g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, Rr, 0, TAU); g.fill();
      } else {                                                    // older browsers: thin slices
        const NS = 30;
        for (let j = 0; j < NS; j++) {
          const t0 = j / NS, t1 = (j + 1) / NS;
          g.fillStyle = `rgba(${G},${tA * Math.exp(-3.4 * t0)})`;
          g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, Rr, a1 - Ltr * t1, a1 - Ltr * t0); g.closePath(); g.fill();
        }
      }
      const bxe = cx + Math.cos(a1) * Rr, bye = cy + Math.sin(a1) * Rr;
      g.lineCap = 'round';
      g.strokeStyle = `rgba(${G},0.18)`; g.lineWidth = lw * 7; g.beginPath(); g.moveTo(cx, cy); g.lineTo(bxe, bye); g.stroke();
      g.strokeStyle = 'rgba(200,255,215,0.9)'; g.lineWidth = lw * 1.3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(bxe, bye); g.stroke();
      // echoes: a raining place lights up as the beam passes, then fades over about a turn
      const pts = points(E), hit = st.hit || (st.hit = new Map());
      const decay = clamp(TAU / Math.max(0.3, st.spd) * 0.55, 0.8, 5);
      const NB = 5, arcs = [], cores = new Path2D(), glows = [];
      for (let b = 0; b < NB; b++) arcs.push(new Path2D());
      let echoes = 0, maxmm = 0;
      for (const q of pts) {
        if (!q.rain) continue;
        echoes++; if (q.mm > maxmm) maxmm = q.mm;
        if (q.lat < -60) continue;
        if (q.ang == null) { q.ang = (((q.lon * Math.PI / 180 - Math.PI / 2) % TAU) + TAU) % TAU; q.rr = polar(1, q.lat); }
        const d = (((q.ang - a0) % TAU) + TAU) % TAU;
        if (d <= span || span >= TAU) hit.set(q.id, T - (span - d) / Math.max(0.05, st.spd));
        const t0 = hit.get(q.id);
        if (t0 == null) continue;
        const age = T - t0, br = Math.exp(-age / decay);
        if (br < 0.03) continue;
        const k = q.k, r = q.rr * Rr, ji = e * 3 * s;
        const x = cx + Math.cos(q.ang) * r + (rnd() - 0.5) * ji, y = cy + Math.sin(q.ang) * r + (rnd() - 0.5) * ji;
        const ext = Math.min(0.5, (3 + 9 * k) * s / Math.max(8, r));
        const b = Math.min(NB - 1, Math.floor(br * NB));
        arcs[b].moveTo(cx + Math.cos(q.ang - ext) * r, cy + Math.sin(q.ang - ext) * r); arcs[b].arc(cx, cy, r, q.ang - ext, q.ang + ext);
        if (age < 0.25) { const d2 = (2 + 3 * k) * lw; cores.rect(x - d2 / 2, y - d2 / 2, d2, d2); }
        glows.push([x, y, br, k]);
      }
      for (let b = 0; b < NB; b++) {
        const al = (b + 0.5) / NB;
        g.strokeStyle = `rgba(${G},${0.12 * al})`; g.lineWidth = lw * 9; g.stroke(arcs[b]);
        g.strokeStyle = `rgba(150,255,185,${0.85 * al})`; g.lineWidth = lw * 2.6; g.stroke(arcs[b]);
      }
      const sp = glow(G, 64, 0.2);
      for (const [x, y, br, k] of glows) { const z = (16 + 40 * k) * s * (0.6 + 0.4 * br); g.globalAlpha = 0.55 * br; g.drawImage(sp, x - z / 2, y - z / 2, z, z); }
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(235,255,240,0.95)'; g.fill(cores);
      // lightning: a strike flares on the scope (at its longitude) and the whole screen flashes
      let strike = 0;
      for (const b of R.bolts) {
        const age = T - b.t; if (age < 0) continue;
        const fl = age < 0.07 ? 1 : age < 0.12 ? 0.3 : age < 0.2 ? 0.9 : Math.max(0, 1 - (age - 0.2) / 0.9);
        strike = Math.max(strike, fl * (b.power || 0.6));
        const a = (b.u || 0.5) * TAU - Math.PI, rr = Rr * (0.25 + 0.6 * hash((b.seed | 0) + 9));
        const x = cx + Math.cos(a - Math.PI / 2) * rr, y = cy + Math.sin(a - Math.PI / 2) * rr, z = (40 + 90 * fl) * s;
        g.globalAlpha = fl; g.drawImage(glow('210,255,225', 64, 0.3), x - z / 2, y - z / 2, z, z);
        g.strokeStyle = `rgba(220,255,230,${fl})`; g.lineWidth = lw * 1.4; g.beginPath();
        g.moveTo(x - z * 0.3, y); g.lineTo(x + z * 0.3, y); g.moveTo(x, y - z * 0.3); g.lineTo(x, y + z * 0.3); g.stroke();
        g.globalAlpha = 1;
      }
      if (strike > 0.35 && !(st.flash > T - 0.4)) st.flash = T;
      // static: the breath fills the scope with noise, thickest where the mist moved
      const nz = Math.round((0.03 + 0.95 * e + 0.6 * storm) * 1500 * (W * H) / (1600 * 900));
      if (nz > 0) {
        const p1 = new Path2D(), p2 = new Path2D();
        const fx = cx + clamp(E.mx, -1, 1) * Rr * 0.75, fy = cy + clamp(E.my, -1, 1) * Rr * 0.75;
        for (let i = 0; i < nz; i++) {
          let x, y;
          if (i & 1) { const a = rnd() * TAU, r = Rr * 0.32 * Math.sqrt(-2 * Math.log(rnd() + 1e-6)) * 0.6; x = fx + Math.cos(a) * r; y = fy + Math.sin(a) * r; }
          else { const a = rnd() * TAU, r = Rr * Math.sqrt(rnd()); x = cx + Math.cos(a) * r; y = cy + Math.sin(a) * r; }
          const d = (rnd() < 0.2 ? 2.2 : 1.2) * lw * 0.8;
          (rnd() < 0.3 ? p2 : p1).rect(x, y, d, d * 0.8);
        }
        g.fillStyle = `rgba(${G},0.35)`; g.fill(p1);
        g.fillStyle = 'rgba(210,255,225,0.6)'; g.fill(p2);
        const streaks = Math.round(e * 10 + storm * 8), sl = new Path2D();
        for (let i = 0; i < streaks; i++) { const y = rnd() * H, x = rnd() * W; sl.rect(x, y, (40 + rnd() * 260) * s, lw * 0.8); }
        g.fillStyle = `rgba(${G},0.16)`; g.fill(sl);
      }
      // interference: the storm (and lightning) rolls a bright band and a flash over the whole screen
      if (storm > 0.15 && rnd() < storm * 0.7 * dt) st.flash = T;
      if (st.flash != null && T - st.flash < 0.5) {
        const fa = 1 - (T - st.flash) / 0.5;
        g.fillStyle = `rgba(${G},${0.16 * fa})`; g.fillRect(0, 0, W, H);
        const yb = ((T - st.flash) / 0.5) * H * 1.3 - H * 0.15;
        g.fillStyle = `rgba(190,255,210,${0.2 * fa})`; g.fillRect(0, yb, W, 26 * s);
      }
      // the readout
      g.globalCompositeOperation = 'source-over';
      const fsz = Math.round(10.5 * s), x0 = Math.max(24 * s, W * 0.045), y0 = H * 0.11;
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      g.fillStyle = `rgba(${G},0.62)`; g.font = `400 ${fsz}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
      g.fillText('PRECIP · WORLD SCAN', x0, y0);
      g.fillStyle = 'rgba(170,255,200,0.95)'; g.font = `300 ${Math.round(fsz * 4)}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
      g.fillText(String(echoes), x0 - fsz * 0.2, y0 + fsz * 4.4);
      g.font = `400 ${fsz}px "IBM Plex Mono", ui-monospace, Menlo, monospace`; g.fillStyle = `rgba(${G},0.8)`;
      const n = pts.length || 1, pct = (echoes / n * 100).toFixed(1);
      const lines = [`${echoes === 1 ? 'ECHO' : 'ECHOES'}`, '', E.pts.length ? `${pct}% OF ${n} PTS` : 'AWAITING SNAPSHOT', `MAX ${maxmm ? maxmm.toFixed(1) : '—'} MM/H`, `SWEEP ${(st.spd / TAU * 60).toFixed(1)} RPM`,
        `NOISE [${'#'.repeat(Math.round(e * 8))}${'·'.repeat(8 - Math.round(e * 8))}]`,
        `WX ${storm > 0.25 ? 'STORM' : calm > 0.5 ? 'CALM' : e > 0.3 ? 'GUSTS' : 'RAIN'}`];
      lines.forEach((t, i) => g.fillText(t, x0, y0 + fsz * (5.9 + i * 1.6)));
      if (storm > 0.25 && (T * 2) % 1 < 0.6) { g.fillStyle = 'rgba(200,255,215,0.95)'; g.fillText('▲ STORM CELLS', x0, y0 + fsz * (6 + lines.length * 1.6 + 0.6)); }
      const d = new Date();
      g.fillStyle = `rgba(${G},0.55)`;
      const yb = H * 0.8;
      g.fillText(`UTC ${d.toISOString().slice(11, 19)}`, x0, yb);
      g.fillText(`BRG ${String(Math.round(((st.sw + Math.PI / 2) / TAU * 360 + 360) % 360)).padStart(3, '0')}°`, x0, yb + fsz * 1.6);
      g.fillText('POLAR · 90N–60S', x0, yb + fsz * 3.2);
      // storm: the picture tears into shifted bands
      if (tear) {
        c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = 'source-over';
        c.drawImage(st.buf, 0, 0);
        if (!st.bands || rnd() < 0.3) {
          st.bands = [];
          const nb = 1 + Math.floor(storm * 6 + e * 3);
          for (let i = 0; i < nb; i++) st.bands.push([rnd() * H, (4 + rnd() * 46) * s, (rnd() - 0.5) * 2 * (10 + 70 * storm) * s]);
        }
        for (const [y, h, dx] of st.bands) {
          const Y = Math.round(y * dpr), Hh = Math.max(1, Math.round(h * dpr)), DX = Math.round(dx * dpr);
          c.fillStyle = '#000'; c.fillRect(0, Y, st.buf.width, Hh);
          c.drawImage(st.buf, 0, Y, st.buf.width, Hh, DX, Y, st.buf.width, Hh);
        }
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      c.globalCompositeOperation = 'source-over';
      c.drawImage(st.crt, 0, 0, W, H);
    },
  };

  /* ============================================================== 5  Glass
     Looking out through a rainy window at night: a blur of coloured city lights behind the glass, and on
     it raindrops that land where it is raining right now (across by longitude, bigger where it rains
     harder), gather, and slide down leaving clear trails. Blowing on the mist fogs the glass where the mist
     moved (and a little everywhere); the fog slowly lifts, and the drops wipe clear streaks through it.
     A storm brings many fast drops slanting in the wind and lightning flickering behind the city;
     calm leaves a few slow drops and clear glass. */
  const CITY = ['255,176,72', '255,214,150', '255,96,74', '92,206,232', '232,96,196', '112,150,255', '255,238,214', '150,236,170'];
  function glassSetup(st, W, H, dpr, s) {
    st.W = W; st.H = H;
    const bg = st.bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, '#03040b'); gr.addColorStop(0.45, '#0a0d1d'); gr.addColorStop(0.78, '#191326'); gr.addColorStop(1, '#0c0911');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const blur = 'filter' in g;
    // wide washes of light: a sodium glow low down, a neon haze at one side
    for (const [x, y, r, col, a] of [[0.5, 1.0, 0.7, '255,140,60', 0.22], [0.12, 0.6, 0.35, '80,200,230', 0.1], [0.86, 0.55, 0.3, '230,80,190', 0.09], [0.6, 0.35, 0.4, '90,110,230', 0.06]]) {
      const q = g.createRadialGradient(x * W, y * H, 0, x * W, y * H, r * W);
      q.addColorStop(0, `rgba(${col},${a})`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.fillRect(0, 0, W, H);
    }
    // far windows: a soft scatter of tiny lights
    if (blur) g.filter = `blur(${1.5 * s}px)`;
    for (let i = 0; i < 380; i++) {
      const x = hash(i * 9 + 1) * W, y = H * (0.25 + 0.4 * hash(i * 9 + 2)), col = hash(i * 9 + 3) < 0.7 ? '255,210,150' : '170,200,255';
      g.fillStyle = `rgba(${col},${0.12 + 0.3 * hash(i * 9 + 4)})`; g.fillRect(x, y, 2.4 * s, 3 * s);
    }
    // bokeh: soft discs with a slightly brighter rim, bigger and more of them toward the street
    if (blur) g.filter = `blur(${0.8 * s}px)`;
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 190; i++) {
      const hy = Math.pow(hash(i * 5 + 2), 0.65), y = H * (0.22 + 0.75 * hy), x = W * (hash(i * 5 + 3) * 1.1 - 0.05);
      const r = (5 + 40 * Math.pow(hash(i * 5 + 4), 2.2) * (0.4 + hy)) * s, col = CITY[Math.floor(hash(i * 5 + 5) * CITY.length)];
      const a = (0.07 + 0.26 * hash(i * 5 + 6)) * (r > 30 * s ? 0.6 : 1);
      const q = g.createRadialGradient(x, y, 0, x, y, r);
      q.addColorStop(0, `rgba(${col},${a * 0.65})`); q.addColorStop(0.78, `rgba(${col},${a * 0.85})`); q.addColorStop(0.9, `rgba(${col},${a * 1.2})`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    }
    g.filter = 'none'; g.globalCompositeOperation = 'source-over';
    // the fog lives on a coarse grid of floats (so it can thin out smoothly, with no 8-bit leftovers);
    // it is drawn up in two steps (grid -> a third of the screen -> the screen), which keeps its edges soft
    const gw = 240, gh = Math.max(60, Math.round(gw * H / W));
    Object.assign(st, { gw, gh, cw: W / gw, ch: H / gh });
    const mw = Math.round(W / 3), mh = Math.round(H / 3);
    // the fogged view: the same city, much softer and milky
    const tiny = st.tiny = canvas(mw, mh), t = tiny.getContext('2d');
    if ('filter' in t) t.filter = `blur(${3 * s}px)`;
    t.drawImage(bg, -8, -8, mw + 16, mh + 16); t.filter = 'none';
    t.fillStyle = 'rgba(150,160,188,0.26)'; t.fillRect(0, 0, mw, mh);
    t.globalCompositeOperation = 'lighter'; t.fillStyle = 'rgba(20,22,30,1)'; t.fillRect(0, 0, mw, mh); t.globalCompositeOperation = 'source-over';
    // colours behind each spot of glass (what a drop there refracts)
    const sm = canvas(64, 36), sx = sm.getContext('2d'); sx.drawImage(bg, 0, 0, 64, 36);
    st.col = sx.getImageData(0, 0, 64, 36).data;
    st.fog = new Float32Array(gw * gh);
    st.grain = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) st.grain[j * gw + i] = 0.5 + 0.5 * (fbm(i * 0.08, j * 0.08) * 0.5 + 0.5);
    st.fogCv = canvas(gw, gh); st.fogX = st.fogCv.getContext('2d'); st.fogImg = st.fogX.createImageData(gw, gh);
    st.mid = canvas(mw, mh); st.midX = st.mid.getContext('2d');
    // a drop's dark rim and its glints, drawn once (the lens inside is filled per drop, in the colour behind it)
    const D = 96, spr = st.drop = canvas(D, D), q = spr.getContext('2d'), m = D / 2, u = D / 2.2;
    q.fillStyle = 'rgba(0,0,8,0.55)'; q.beginPath(); q.arc(m, m + u * 0.1, u * 1.04, 0, TAU); q.fill();
    q.globalCompositeOperation = 'destination-out'; q.beginPath(); q.arc(m, m, u * 0.84, 0, TAU); q.fill();
    q.globalCompositeOperation = 'source-over';
    q.fillStyle = 'rgba(255,255,255,0.9)'; q.beginPath(); q.ellipse(m - u * 0.3, m - u * 0.38, u * 0.24, u * 0.17, -0.5, 0, TAU); q.fill();
    q.fillStyle = 'rgba(255,240,220,0.34)'; q.beginPath(); q.ellipse(m + u * 0.18, m + u * 0.5, u * 0.28, u * 0.13, 0, 0, TAU); q.fill();
    // a few moving lights: cars passing on the street below
    st.cars = Array.from({ length: 22 }, (_, i) => ({ x: hash(i * 3 + 1) * W, y: H * (0.72 + 0.22 * hash(i * 3 + 2)), v: (18 + 50 * hash(i * 3 + 3)) * s * (hash(i * 3 + 4) < 0.5 ? -1 : 1), r: (10 + 26 * hash(i * 3 + 5)) * s }));
    st.beads = []; st.drops = [];
  }
  /* what a drop at (x, y) shows: the light from behind the glass a little below it (a lens turns it over),
     brightened, as one of a few hundred shared colours so the drops can be filled in batches */
  function refract(st, W, H, x, y) {
    const i = clamp(Math.floor(x / W * 64), 0, 63), j = clamp(Math.floor(y / H * 36), 0, 35), o = (j * 64 + i) * 4, d = st.col;
    const q = v => Math.min(255, (Math.round(v / 12) * 12));
    return `rgb(${q(d[o] * 1.7 + 34)},${q(d[o + 1] * 1.7 + 38)},${q(d[o + 2] * 1.7 + 50)})`;
  }
  const glass = {
    name: 'window', title: 'Glass', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E);
      if (st.W !== W || st.H !== H || !st.bg) glassSetup(st, W, H, E.dpr, s);
      if (!st.seeded && E.sites.length) {                         // the window has been out in the rain a while already
        st.seeded = true;
        for (const z of E.sites) for (let n = Math.round(2 + 9 * z.k); n > 0; n--) st.beads.push({ x: W * (0.03 + 0.94 * z.u) + (rnd() + rnd() - 1) * W * 0.035, y: rnd() * H, r: (0.6 + 2.2 * z.k * rnd()) * s * 0.75 });
      }
      c.globalCompositeOperation = 'source-over';
      c.drawImage(st.bg, 0, 0, W, H);
      // the street: car lights drifting by
      c.globalCompositeOperation = 'lighter';
      for (let i = 0; i < st.cars.length; i++) {
        const q = st.cars[i];
        q.x += q.v * dt; if (q.x < -60) q.x += W + 120; if (q.x > W + 60) q.x -= W + 120;
        c.globalAlpha = 0.22 + 0.12 * Math.sin(T * 0.7 + i) + 0.12 * calm;
        c.drawImage(glow(q.v < 0 ? '255,70,60' : '255,226,180', 64, 0.35), q.x - q.r, q.y - q.r, q.r * 2, q.r * 2);
      }
      c.globalAlpha = 1;
      // lightning behind the city: the sky flickers, the bolt is soft behind the glass
      let fl = 0;
      if (storm > 0.25 && rnd() < storm * 1.2 * dt) st.flick = T;
      if (st.flick != null && T - st.flick < 0.35) { const a = T - st.flick; fl = (a < 0.06 ? 1 : a < 0.12 ? 0.3 : 0.8 * (1 - a / 0.35)) * 0.5 * storm; }
      for (const b of R.bolts) {
        const age = T - b.t; if (age < 0) continue;
        fl = Math.max(fl, (age < 0.07 ? 1 : age < 0.12 ? 0.25 : age < 0.2 ? 0.9 : Math.max(0, 1 - (age - 0.2) / 0.9)) * (b.power || 0.6));
        c.globalAlpha = 0.55; R._bolt(c, b, age, lw * 0.8); c.globalAlpha = 1;
        c.globalCompositeOperation = 'lighter';
      }
      if (fl > 0.01) { c.fillStyle = `rgba(120,140,220,${0.2 * fl})`; c.fillRect(0, 0, W, H); }
      // ---- the fog on the glass: the breath fogs it where the mist moved, a little everywhere; it slowly lifts
      const F = st.fog, N = st.grain, gw = st.gw, gh = st.gh, cw = st.cw, ch = st.ch;
      const ev = Math.exp(-dt * (0.08 + 0.3 * calm + (e < 0.05 ? 0.06 : 0)));
      const bx = (0.5 + 0.42 * clamp(E.mx, -1, 1)) * gw, by = (0.5 + 0.4 * clamp(E.my, -1, 1)) * gh;
      const br = (0.12 + 0.16 * e) * gw, add = e * dt * 2.6, glob = e * dt * 0.05 + storm * dt * 0.012;
      for (let i = 0; i < F.length; i++) F[i] = F[i] * ev + glob * N[i];
      if (add > 0.0005) {
        const x0 = Math.max(0, Math.floor(bx - br * 2)), x1 = Math.min(gw - 1, Math.ceil(bx + br * 2));
        const y0 = Math.max(0, Math.floor(by - br * 1.7)), y1 = Math.min(gh - 1, Math.ceil(by + br * 1.7));
        for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
          const dx = (i - bx) / br, dy = (j - by) / (br * 0.82), d2 = dx * dx + dy * dy, o = j * gw + i;
          if (d2 < 4) F[o] = Math.min(1, F[o] + add * Math.exp(-d2 * (1.1 + 1.2 * (1 - N[o]))) * N[o]);
        }
      }
      // ---- rain on the glass: beads land where it is raining (across by longitude), heavier rain = bigger drops
      const beads = st.beads, drops = st.drops;
      const amt = (0.06 + 0.94 * (1 - 0.9 * calm)) * (1 + 5 * storm) * (1 + 0.4 * e);
      for (const z of E.sites) {
        const xz = W * (0.03 + 0.94 * z.u);
        let nb = (0.6 + 2.6 * z.k) * amt * dt;
        while (nb > 0) {
          if (nb < 1 && rnd() > nb) break; nb -= 1;
          if (beads.length > 900) beads.splice(0, 30);
          beads.push({ x: xz + (rnd() + rnd() - 1) * W * 0.035, y: rnd() * H, r: (0.6 + 2.2 * z.k * rnd()) * s * 0.75 });
        }
        let nd = (0.04 + 0.3 * z.k) * amt * dt;
        while (nd > 0 && drops.length < 200) {
          if (nd < 1 && rnd() > nd) break; nd -= 1;
          drops.push({ x: xz + (rnd() + rnd() - 1) * W * 0.03, y: rnd() * H * 0.7 - 10, r: (1.6 + 4.2 * z.k) * s * (0.7 + 0.5 * rnd()), vy: 0, stick: rnd() * 0.8, seed: rnd() * 100 });
        }
      }
      // beads in a coarse grid, so a sliding drop can pick up the ones in its way
      const GC = 40, gcols = Math.ceil(W / GC) + 1, grid = new Map();
      for (const b of beads) { const key = Math.floor(b.y / GC) * gcols + Math.floor(b.x / GC); let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(b); }
      const slant = wx * (30 * e + 40 * storm) * s + (Math.abs(wx) < 0.15 ? 1 : Math.sign(wx)) * storm * 150 * s;
      let keep = 0;
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        // stick-slip: drops hold, then let go and run; bigger ones run more
        d.stick -= dt;
        if (d.stick < 0 && rnd() < dt * (0.25 + 0.4 * calm) * (8 * s / (d.r + 2 * s))) d.stick = 0.2 + 0.8 * rnd();
        const run = d.stick > 0 ? 0 : (14 + 11 * d.r / s) * s * (1 + 2.4 * storm) * (0.35 + 0.65 * (1 - calm));
        d.vy += (run - d.vy) * Math.min(1, dt * (run > d.vy ? 3 : 8));
        d.x += (slant * (d.vy / (60 * s + d.vy)) + Math.sin(T * 1.7 + d.seed) * 2.5 * s * (d.vy > 1 ? 1 : 0)) * dt;
        d.y += d.vy * dt;
        // it leaves a few tiny beads behind and loses a little water
        if (d.vy > 2 && rnd() < dt * 6 && beads.length < 950) { beads.push({ x: d.x + (rnd() - 0.5) * d.r * 0.8, y: d.y - d.r * 1.3, r: d.r * (0.16 + 0.18 * rnd()) }); d.r *= 0.986; }
        // and swallows the beads it runs into
        const gx = Math.floor(d.x / GC), gy = Math.floor(d.y / GC);
        for (let yy = gy - 1; yy <= gy + 1; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
          const a = grid.get(yy * gcols + xx); if (!a) continue;
          for (const b of a) {
            if (b.dead) continue;
            const ddx = b.x - d.x, ddy = b.y - d.y, rr = d.r + b.r;
            if (ddx * ddx + ddy * ddy < rr * rr) { b.dead = true; d.r = Math.min(11 * s, Math.sqrt(d.r * d.r + b.r * b.r * 0.7)); }
          }
        }
        // it wipes the fog where it runs
        if (d.vy > 1) {
          const fi = Math.floor(d.x / cw), fj = Math.floor(d.y / ch), rc = 0.6 + d.r / cw;
          for (let jj = fj - 1; jj <= fj + 1; jj++) for (let ii = fi - 1; ii <= fi + 1; ii++) {
            if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
            const q = Math.hypot((ii + 0.5) * cw - d.x, (jj + 0.5) * ch - d.y) / cw;
            if (q < rc) F[jj * gw + ii] *= 0.4 + 0.6 * (q / rc) * (q / rc);
          }
        }
        if (d.y - d.r > H + 4 || d.r < 0.9 * s || d.x < -30 || d.x > W + 30) continue;
        drops[keep++] = d;
      }
      drops.length = keep;
      // beads evaporate slowly (faster when calm)
      let kb = 0;
      for (let i = 0; i < beads.length; i++) {
        const b = beads[i];
        if (b.dead) continue;
        b.r -= dt * (0.02 + 0.12 * calm) * s;
        if (b.r < 0.35) continue;
        beads[kb++] = b;
      }
      beads.length = kb;
      // ---- draw the fog: the blurred milky city where it is fogged, with a white haze (only where there is any)
      const img = st.fogImg.data;
      let i0 = gw, i1 = -1, j0 = gh, j1 = -1;
      for (let j = 0, o = 0; j < gh; j++) for (let i = 0; i < gw; i++, o++) {
        const v = F[o], a = v > 0.004 ? Math.min(230, v * 260) : 0;
        img[o * 4] = 228; img[o * 4 + 1] = 232; img[o * 4 + 2] = 242; img[o * 4 + 3] = a;
        if (a) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
      }
      if (i1 >= 0) {
        st.fogX.putImageData(st.fogImg, 0, 0);
        const m = st.midX, mw = st.mid.width, mh = st.mid.height;
        m.imageSmoothingEnabled = true;
        m.globalCompositeOperation = 'copy'; m.globalAlpha = 1; m.drawImage(st.fogCv, 0, 0, mw, mh);
        m.globalCompositeOperation = 'source-in'; m.drawImage(st.tiny, 0, 0);
        m.globalCompositeOperation = 'source-over'; m.globalAlpha = 0.12 + 0.15 * fl; m.drawImage(st.fogCv, 0, 0, mw, mh); m.globalAlpha = 1;
        // just the part of the glass that is fogged, up to the screen
        const kx = mw / gw, ky = mh / gh, ax = Math.max(0, (i0 - 2) * kx), ay = Math.max(0, (j0 - 2) * ky);
        const bw = Math.min(mw, (i1 + 3) * kx) - ax, bh = Math.min(mh, (j1 + 3) * ky) - ay;
        c.globalCompositeOperation = 'source-over'; c.imageSmoothingEnabled = true;
        c.drawImage(st.mid, ax, ay, bw, bh, ax * W / mw, ay * H / mh, bw * W / mw, bh * H / mh);
      }
      // ---- the water: beads and drops, each a little lens (a dark rim, the city upside down inside, a bright glint)
      const rim = new Path2D(), body = new Path2D(), hi = new Path2D();
      for (const b of beads) {
        if (b.r < 1.6) { rim.rect(b.x - b.r, b.y - b.r * 0.6, b.r * 2, b.r * 2); hi.rect(b.x - b.r * 0.5, b.y - b.r * 0.6, b.r * 0.8, b.r * 0.8); continue; }
        rim.moveTo(b.x + b.r, b.y + b.r * 0.15); rim.arc(b.x, b.y + b.r * 0.15, b.r, 0, TAU);
        body.moveTo(b.x + b.r * 0.8, b.y); body.arc(b.x, b.y, b.r * 0.8, 0, TAU);
        hi.rect(b.x - b.r * 0.45, b.y - b.r * 0.5, b.r * 0.45, b.r * 0.45);
      }
      c.fillStyle = 'rgba(0,0,6,0.38)'; c.fill(rim);
      c.fillStyle = 'rgba(190,200,230,0.14)'; c.fill(body);
      c.fillStyle = `rgba(255,255,255,${0.45 + 0.4 * fl})`; c.fill(hi);
      const lens = new Map();
      for (const d of drops) {
        const el = 1 + Math.min(0.45, d.vy / (160 * s)), r = d.r, col = refract(st, W, H, d.x, d.y + r * 9);
        let p = lens.get(col); if (!p) lens.set(col, p = new Path2D());
        p.moveTo(d.x + r * 0.88, d.y); p.ellipse(d.x, d.y, r * 0.88, r * 0.88 * el, 0, 0, TAU);
      }
      c.globalAlpha = 0.9;
      for (const [col, p] of lens) { c.fillStyle = col; c.fill(p); }
      c.globalAlpha = 1;
      for (const d of drops) {                                   // rim and glints over each lens
        const el = 1 + Math.min(0.45, d.vy / (160 * s)), z = d.r * 2.2;
        c.drawImage(st.drop, d.x - z / 2, d.y - z * el / 2, z, z * el);
      }
    },
  };

  return [currents, planet, garden, radar, glass];
})();
