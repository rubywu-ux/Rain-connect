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
    name: 'garden', title: 'Rain Garden', turn: 'dissolve',
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

  /* ============================================================== 6  Mobile
     A hanging mobile, after Calder. Every raining place is a painted metal plate on a wire arm: bigger
     where it rains harder; red in the tropics, black to the north, blue to the south, white near the poles,
     and the heaviest rain is the one yellow plate. The arms are balanced like a real mobile, so how many
     places there are and how hard it rains at each sets its whole shape. It turns slowly on the air of the
     room; a breath blows it: the plates catch the air, the arms swing away from the side it came from and
     spin. A storm throws it about (a long exposure shows the blur of it); a lightning strike is a camera
     flash: the wall goes white and the shadows jump. A pale wall in the light theme, a dark gallery with a
     spotlight in the dark. */
  const CALDER = { red: [206, 42, 30], black: [24, 23, 25], yellow: [240, 178, 18], blue: [28, 68, 158], white: [240, 235, 224] };
  const MOBILE_IDLE = Array.from({ length: 7 }, (_, i) => ({ id: 91 + i * 7, u: (i + 0.5) / 7, v: 0.25 + 0.5 * hash(i * 5 + 1), k: 0.2 + 0.6 * hash(i * 5 + 2) }));
  function plateOutline(shape) {                       // in plate units: x across the plate, y down
    const out = [];
    for (let j = 0; j < 20; j++) {
      const t = j / 20 * TAU;
      if (shape === 0) out.push([Math.cos(t), Math.sin(t)]);
      else if (shape === 1) out.push([Math.cos(t) * 1.3, Math.sin(t) * 0.78]);
      else { const w = Math.pow(Math.abs(Math.sin(t / 2)), 1.3); out.push([1.1 * Math.sin(t) * w, -Math.cos(t) * 1.05]); }
    }
    return out;
  }
  /* one arm: A on one tip, B on the other, hung at the point where they balance. Either side by side, or
     staggered (the smaller one hangs short, the other on a long thread below it), whichever keeps the
     whole mobile closest to the shape of the screen */
  function mobileRod(A, B, sd, aspect, rods, d) {
    const thr = q => q.leaf ? 0 : 0.5;
    const lay = (L, tA, tB) => { const a = L * B.wt / (A.wt + B.wt), b = L - a; return { L, a, b, tA, tB, rho: Math.max(a + A.rho, b + B.rho), h: Math.max(tA + A.h, tB + B.h) + 0.12 }; };
    const wide = lay(A.rho + B.rho + 0.3, thr(A), thr(B));
    const sm = A.h <= B.h ? A : B, ts = thr(sm), tl = ts + sm.h + 0.35, Ls = Math.max(sm.rho + 0.5, 1.2);
    const stag = sm === A ? lay(Ls, ts, tl) : lay(Ls, tl, ts);
    const score = o => Math.max(o.rho / aspect, o.h);
    const o = score(stag) < score(wide) * (d < 2 ? 0.72 : 0.9 + 0.2 * hash(sd * 11 + 3)) ? stag : wide;
    const n = Object.assign(o, { leaf: false, A, B, id: sd, wt: A.wt + B.wt + 0.03 * o.L, th: hash(sd * 13 + 2) * TAU, om: 0, sx: 0, sz: 0, vx: 0, vz: 0, F: [0, 0],
                                 pitch: (hash(sd * 13 + 4) < 0.5 ? -1 : 1) * (0.5 + 0.5 * hash(sd * 13 + 5)) });   // bent plates catch the air like a sail
    A.thr = o.tA; B.thr = o.tB;
    rods.push(n);
    return n;
  }
  function mobileBuild(sites, aspect) {
    const src = sites.length ? [...sites] : MOBILE_IDLE.slice();
    if (src.length === 1) src.push({ id: 77, u: 1, v: 0.3, k: 0.04 });          // one place: a little counterweight
    let top = src[0]; for (const z of src) if (z.k > top.k) top = z;
    const leaves = src.sort((a, b) => a.u - b.u).map(z => {
      const lat = 90 - z.v * 180, al = Math.abs(lat), h = hash(z.id * 31 + 7), shape = h < 0.5 ? 0 : h < 0.78 ? 1 : 2;
      const r = 0.5 + 0.95 * Math.sqrt(z.k);
      return { leaf: true, id: z.id, k: z.k, r, wt: r * r, rho: r * 1.25, h: r * 2.2, shape, out: plateOutline(shape),
               col: z === top ? 'yellow' : al > 55 ? 'white' : al < 23.5 ? 'red' : lat > 0 ? 'black' : 'blue',
               off: r * (shape === 1 ? 0.8 : shape === 2 ? 1.05 : 1), tw: (hash(z.id * 31 + 8) < 0.55 ? 0 : Math.PI / 2) + (hash(z.id * 31 + 10) - 0.5) * 0.7,
               rot: shape ? (hash(z.id * 31 + 9) - 0.5) * 1.2 : 0, thr: 0, F: [0, 0] };
    });
    const rods = []; let sd = 5;
    const build = (list, d) => {
      if (list.length === 1) return list[0];
      const me = ++sd; let A, B;
      if (list.length <= 3 || d >= 6 || hash(me * 7 + list.length) < 0.3) {   // the heaviest alone on one tip, the rest on the other
        let im = 0; list.forEach((q, i) => { if (q.wt > list[im].wt) im = i; });
        A = [list[im]]; B = list.filter((_, i) => i !== im);
        if (hash(me * 7 + 1) < 0.5) { const t = A; A = B; B = t; }
      } else {                                                                 // or split east / west by weight
        const tot = list.reduce((a, q) => a + q.wt, 0); let acc = 0, m = 1;
        for (let i = 0; i < list.length - 1; i++) { acc += list[i].wt; m = i + 1; if (acc >= tot / 2) break; }
        A = list.slice(0, m); B = list.slice(m);
      }
      return mobileRod(build(A, d + 1), build(B, d + 1), me, aspect, rods, d);
    };
    const root = build(leaves, 0);
    return { root, down: rods.slice().reverse(), up: rods, leaves };
  }
  function mobileBg(st, W, H, dpr, light) {
    const bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, H);
    if (light) { gr.addColorStop(0, '#f1ede5'); gr.addColorStop(1, '#e2dccf'); }
    else { gr.addColorStop(0, '#16161a'); gr.addColorStop(1, '#0c0c0e'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // the light: a soft wash from the upper left (paper) or a warm spotlight from above (gallery)
    gr = light ? g.createRadialGradient(W * 0.3, H * 0.15, 0, W * 0.3, H * 0.15, W * 0.8) : g.createRadialGradient(W * 0.5, H * 0.38, 0, W * 0.5, H * 0.42, H * 0.95);
    gr.addColorStop(0, light ? 'rgba(255,252,244,0.75)' : 'rgba(92,84,70,0.75)'); gr.addColorStop(0.5, light ? 'rgba(255,252,244,0.2)' : 'rgba(60,54,46,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 7000; i++) {                  // a little grain in the plaster
      g.fillStyle = light ? `rgba(80,64,40,${0.015 + 0.03 * hash(i * 5 + 1)})` : `rgba(255,240,220,${0.008 + 0.018 * hash(i * 5 + 1)})`;
      g.fillRect(hash(i * 5 + 2) * W, hash(i * 5 + 3) * H, 1, 1);
    }
    gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, light ? 'rgba(90,70,40,0.14)' : 'rgba(0,0,0,0.5)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    return bg;
  }
  const mobile = {
    name: 'mobile', title: 'Mobile', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E);
      if (st.W !== W || st.H !== H || !st.bgD) {
        st.W = W; st.H = H; st.bgD = mobileBg(st, W, H, E.dpr, false); st.bgL = mobileBg(st, W, H, E.dpr, true);
        st.sh = canvas(W / 4, H / 4); st.shx = st.sh.getContext('2d');
      }
      // the gallery lights come up slowly in the light theme (calm), and go down again for the rain
      st.day = st.day == null ? (E.light ? 1 : 0) : st.day + ((E.light ? 1 : 0) - st.day) * (1 - Math.exp(-dt / 1.4));
      const day = st.day, light = day > 0.5;
      if (st.ref !== E.sites || st.tW !== W || st.tH !== H) {
        st.ref = E.sites; st.tW = W; st.tH = H;
        const m = st.m = mobileBuild(E.sites, (0.56 * W) / (0.84 * H));
        m.sc = Math.min(0.56 * W / m.root.rho, 0.84 * H / m.root.h);
      }
      const m = st.m, sc = m.sc, root = m.root, FOC = 2.6 * W, VY = H * 0.45, cx = W / 2;
      const ceil = -0.04 * H, hangY = Math.max(H * 0.07, H * 0.52 - root.h * sc / 2);
      root.thr = (hangY - ceil) / sc;
      // ---- the air in the room: a slow drift, the breath (from where the mist moves), storm gusts
      const bX = clamp(E.mx, -1, 1) * W * 0.45, bY = (0.5 + 0.4 * clamp(E.my, -1, 1)) * H;
      const gust = e * 1.6 * (0.75 + 0.25 * Math.sin(T * 2.3) * Math.sin(T * 0.9 + 1));
      const gx = gust * wx + storm * 1.7 * vnoise(T * 0.7, 3.1) + 0.05 * vnoise(T * 0.05, 1.7);
      const gz = gust * (1 - Math.abs(wx)) * 0.9 + gust * 0.3 * Math.sin(T * 1.7) + storm * 1.3 * vnoise(T * 0.6, 8.3) + 0.04 * vnoise(T * 0.04, 6.1);
      const airAt = (X, Y) => 0.35 + 0.65 * Math.exp(-((X - bX) * (X - bX)) / (0.25 * W * W) - ((Y - bY) * (Y - bY)) / (0.3 * H * H));
      // ---- where everything hangs right now (top down)
      const place = (q, ax, ay, az, th) => {
        if (q.leaf) { q.x = ax; q.y = ay + (q.thr + q.off) * sc; q.z = az; q.ty = ay + q.thr * sc; q.ps = th + q.tw; return; }
        const L = q.thr * sc, lim = (q === root ? 0.3 : 0.55) * L; q.sx = clamp(q.sx, -lim, lim); q.sz = clamp(q.sz, -lim, lim);
        q.ax = ax; q.ay = ay; q.az = az;
        q.hx = ax + q.sx; q.hy = ay + Math.sqrt(Math.max(L * L * 0.2, L * L - q.sx * q.sx - q.sz * q.sz)); q.hz = az + q.sz;
        const ct = Math.cos(q.th), sn = Math.sin(q.th);
        q.Ax = q.hx - q.a * sc * ct; q.Az = q.hz - q.a * sc * sn; q.Bx = q.hx + q.b * sc * ct; q.Bz = q.hz + q.b * sc * sn;
        place(q.A, q.Ax, q.hy, q.Az, q.th); place(q.B, q.Bx, q.hy, q.Bz, q.th);
      };
      if (root.leaf) place(root, 0, ceil, 0, 0); else place(root, 0, ceil, 0, root.th);
      // ---- the plates catch the air; the arms turn and swing (bottom up)
      for (const q of m.leaves) {
        const n0 = -Math.sin(q.ps), n2 = Math.cos(q.ps), gm = Math.hypot(gx, gz) + 1e-6;
        const face = 0.3 + 0.7 * Math.abs((n0 * gx + n2 * gz) / gm), f = q.wt * face * airAt(q.x, q.y);
        q.F[0] = gx * f; q.F[1] = gz * f;
      }
      const seenB = st.bolt || 0; let flash = 0, fb = null;
      for (const b of R.bolts) {
        const age = T - b.t; if (age < 0) continue;
        // a flash bulb fires twice, then its light dies away quickly (no dim flicker in between: that would read as fog)
        const fl = (age < 0.07 ? 1 : age < 0.12 ? 0 : age < 0.2 ? 0.9 : age < 0.45 ? 0.9 * (1 - (age - 0.2) / 0.25) : 0) * Math.min(1, 0.4 + (b.power || 0.6));
        if (fl > flash) { flash = fl; fb = b; }
      }
      const newBolt = R.bolts.find(b => b.t > seenB && T >= b.t);
      if (newBolt) st.bolt = Math.max(...R.bolts.map(b => b.t));
      // a tap from a phone gives the nearest arms a push
      const taps = R.ripples.filter(r => r.t > (st.rip || 0) && T >= r.t);
      if (taps.length) st.rip = Math.max(...taps.map(r => r.t));
      for (const q of m.up) {
        const A = q.A, B = q.B; q.F[0] = A.F[0] + B.F[0]; q.F[1] = A.F[1] + B.F[1];
        const ct = Math.cos(q.th), sn = Math.sin(q.th);
        const tq = -q.a * (-sn * A.F[0] + ct * A.F[1]) + q.b * (-sn * B.F[0] + ct * B.F[1]);
        const I = A.wt * q.a * q.a + B.wt * q.b * q.b + 0.15;
        const turb = (e * 0.9 + storm * 1.6) * vnoise(T * 1.1 + q.id * 1.7, q.id * 0.37) + 0.3 * vnoise(T * 0.045 + q.id, q.id * 2.3);
        const sail = q.pitch * Math.hypot(q.F[0], q.F[1]) * 2.2;            // the breath spins every arm its own way
        q.om += ((14 * tq + sail * (q.a + q.b)) / I + 4 * turb / Math.sqrt(I) - (0.22 + 0.45 * calm) * q.om - 0.16 * q.om * Math.abs(q.om)) * dt;
        if (newBolt) { q.om += (hash((newBolt.seed | 0) + q.id * 3) - 0.5) * 5 * (newBolt.power || 0.6); q.vx += (hash((newBolt.seed | 0) + q.id * 5) - 0.5) * 420; q.vz += (hash((newBolt.seed | 0) + q.id * 7) - 0.5) * 300; }
        for (const r of taps) {
          const tx = (r.x - R.view.x) * s - cx, ty = (r.y - R.view.y) * s, d = Math.hypot(tx - q.hx, ty - q.hy) / W;
          if (d < 0.28) { q.om += 2.4 * (1 - d / 0.28) * (tx < q.hx ? 1 : -1); q.vx += (q.hx - tx) * 2; }
        }
        q.om = clamp(q.om, -7, 7); q.th += q.om * dt;
        const L = Math.max(8, q.thr * sc), g = 1000, kx = 1500 / q.wt;
        q.vx += (kx * q.F[0] - g / L * q.sx - 1.7 * q.vx) * dt; q.sx += q.vx * dt;
        q.vz += (kx * q.F[1] - g / L * q.sz - 1.7 * q.vz) * dt; q.sz += q.vz * dt;
      }
      // ---- draw. A storm leaves the last frames showing through: a long exposure of the whirling plates
      c.globalCompositeOperation = 'source-over';
      const ga = E.fresh || flash > 0.05 ? 1 : 1 - 0.6 * storm;
      c.globalAlpha = ga; c.drawImage(st.bgD, 0, 0, W, H);
      if (day > 0.004) { c.globalAlpha = ga * day; c.drawImage(st.bgL, 0, 0, W, H); }
      c.globalAlpha = 1;
      const pr = (X, Y, Z, out) => { const k = FOC / (FOC + Z); out[0] = cx + X * k; out[1] = VY + (Y - VY) * k; return out; };
      const p0 = [0, 0], p1 = [0, 0], p2 = [0, 0];
      // shadows on the wall behind (soft, drawn small and scaled up); a flash throws hard ones from its side
      const shadow = (g, Lx, Ly, Zw, wires) => {
        const prS = (X, Y, Z, out) => { const t = (Zw - Z); return pr(X + Lx * t, Y + Ly * t, Zw, out); };
        const path = new Path2D(), wp = new Path2D();
        for (const q of m.leaves) {
          const dx = Math.cos(q.ps), dz = Math.sin(q.ps), cr = Math.cos(q.rot), sr = Math.sin(q.rot), rs = q.r * sc;
          let fx = 0, fy = 0;
          q.out.forEach(([u, v], j) => {
            const a = (u * cr - v * sr) * rs, b = (u * sr + v * cr) * rs;
            prS(q.x + a * dx, q.y + b, q.z + a * dz, p0);
            if (j) path.lineTo(p0[0], p0[1]); else { path.moveTo(p0[0], p0[1]); fx = p0[0]; fy = p0[1]; }
          });
          path.lineTo(fx, fy);
        }
        if (wires) for (const q of m.down) {
          prS(q.ax, q.ay, q.az, p0); wp.moveTo(p0[0], p0[1]); prS(q.hx, q.hy, q.hz, p0); wp.lineTo(p0[0], p0[1]);
          prS(q.Ax, q.hy, q.Az, p0); wp.moveTo(p0[0], p0[1]); prS(q.Bx, q.hy, q.Bz, p0); wp.lineTo(p0[0], p0[1]);
        }
        g.fill(path); if (wires) g.stroke(wp);
      };
      const Zw = 0.3 * W;
      const sx = st.shx; sx.setTransform(1, 0, 0, 1, 0, 0); sx.clearRect(0, 0, st.sh.width, st.sh.height);
      sx.setTransform(st.sh.width / W, 0, 0, st.sh.height / H, 0, 0);
      sx.fillStyle = `rgb(${Math.round(70 * day)},${Math.round(56 * day)},${Math.round(40 * day)})`; sx.strokeStyle = sx.fillStyle; sx.lineWidth = 3;
      shadow(sx, 0.3, 0.36, Zw, true);
      c.globalAlpha = lerp(0.55, 0.2, day) * (1 - 0.7 * flash); c.drawImage(st.sh, 0, 0, W, H); c.globalAlpha = 1;
      if (flash > 0.02) {                                   // a flash bulb: a white wall, hard shadows thrown from the strike's side
        c.fillStyle = `rgba(255,252,246,${Math.min(0.95, 1.1 * flash)})`; c.fillRect(0, 0, W, H);
        c.fillStyle = `rgba(20,16,12,${0.8 * flash})`; c.strokeStyle = c.fillStyle; c.lineWidth = lw * 1.2;
        shadow(c, -((fb.u == null ? 0.5 : fb.u) - 0.5) * 1.8, 0.1, Zw * 1.2, true);
      }
      // the wires
      const wire = new Path2D();
      for (const q of m.down) {
        pr(q.ax, q.ay, q.az, p0); pr(q.hx, q.hy, q.hz, p1); wire.moveTo(p0[0], p0[1]); wire.lineTo(p1[0], p1[1]);
        pr(q.Ax, q.hy, q.Az, p0); pr(q.Bx, q.hy, q.Bz, p2);
        const bow = q.L * sc * 0.07;
        wire.moveTo(p0[0], p0[1]); wire.quadraticCurveTo(p1[0], p1[1] - bow * 2, p2[0], p2[1]);
        for (const ch of [q.A, q.B]) if (ch.leaf) { pr(ch.x, ch.ty - (ch.thr ? ch.thr * sc : 0), ch.z, p0); pr(ch.x, ch.ty + ch.r * sc * 0.2, ch.z, p1); wire.moveTo(p0[0], p0[1]); wire.lineTo(p1[0], p1[1]); }
      }
      c.lineCap = 'round';
      const wc = mix([214, 206, 192], [28, 26, 24], day);
      c.strokeStyle = `rgba(${wc},${lerp(0.7, 0.9, day)})`; c.lineWidth = lw * 0.85; c.stroke(wire);
      // the plates, far ones first
      const order = m.leaves.slice().sort((a, b) => b.z - a.z);
      for (const q of order) {
        const dx = Math.cos(q.ps), dz = Math.sin(q.ps), cr = Math.cos(q.rot), sr = Math.sin(q.rot), rs = q.r * sc;
        c.beginPath();
        q.out.forEach(([u, v], j) => {
          const a = (u * cr - v * sr) * rs, b = (u * sr + v * cr) * rs;
          pr(q.x + a * dx, q.y + b, q.z + a * dz, p0);
          if (j) c.lineTo(p0[0], p0[1]); else c.moveTo(p0[0], p0[1]);
        });
        c.closePath();
        const face = Math.abs(dx), base = CALDER[q.col];
        pr(q.x, q.y, q.z, p1);
        let lit = 0.8 + 0.2 * face + 0.25 * flash;
        lit *= lerp(clamp(1.15 - 0.55 * (((p1[0] - cx) / (0.62 * W)) ** 2 + ((p1[1] - H * 0.4) / (0.75 * H)) ** 2), 0.5, 1.15), 1, day);
        c.fillStyle = `rgb(${Math.min(255, base[0] * lit + (q.col === 'black' ? 14 * face : 0)) | 0},${Math.min(255, base[1] * lit + (q.col === 'black' ? 14 * face : 0)) | 0},${Math.min(255, base[2] * lit + (q.col === 'black' ? 16 * face : 0)) | 0})`;
        c.fill();
        if (light ? q.col === 'white' : q.col === 'black') { c.strokeStyle = light ? 'rgba(40,30,20,0.28)' : 'rgba(255,245,230,0.22)'; c.lineWidth = lw * 0.6; c.stroke(); }
      }
    },
  };

  /* ============================================================== 7  Op Art
     A checkerboard that swells, in the manner of 1960s op art. Every raining place pushes up a bulge under
     the squares (across by longitude, down by latitude; bigger where it rains harder), and colour rises in
     it: ultramarine far north, crimson in the northern tropics, orange in the southern, emerald far south.
     It slowly undulates. A breath sends the whole board streaming away from the side it came from and
     raises a big bulge where the mist moved; a storm makes the squares vibrate and zigzag, and the colours
     split; a lightning strike flips black and white and sends a shock ring through the board. Calm (the
     light theme), it undulates slowly and the colour sinks back toward black and white. */
  const OP_HUE = [[38, 66, 214], [222, 36, 62], [246, 126, 18], [14, 158, 118]];
  const opHueOf = lat => lat > 30 ? 0 : lat > 0 ? 1 : lat > -30 ? 2 : 3;
  const op = {
    name: 'op', title: 'Op Art', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E);
      st.day = st.day == null ? (E.light ? 1 : 0) : st.day + ((E.light ? 1 : 0) - st.day) * (1 - Math.exp(-dt / 1.4));
      const chroma = 1 - 0.7 * st.day;                                   // calm: the colour sinks back toward black and white
      if (st.W !== W || st.H !== H || !st.X) {
        const cs = Math.max(12, Math.round(Math.min(W, H) / 34)), nx = Math.ceil(W / cs) + 6, ny = Math.ceil(H / cs) + 6, n = (nx + 1) * (ny + 1);
        Object.assign(st, { W, H, cs, nx, ny, X: new Float32Array(n), Y: new Float32Array(n), LX: new Float32Array(n), LY: new Float32Array(n), LG: new Float32Array(n),
                            wv: new Float32Array(n), own: new Int16Array(n) });
      }
      const { cs, nx, ny, X, Y, LX, LY, LG, wv, own } = st, N1 = nx + 1, per = 2 * cs;
      // the board streams with the breath (and creeps on its own); integrated so it never jumps
      st.ox = (st.ox || 0) + (wx * e * 560 + 7 + 30 * storm * Math.sin(T * 0.9)) * dt;
      st.oy = (st.oy || 0) + (wy * e * 320 + 4 * Math.sin(T * 0.05)) * dt;
      st.ph = (st.ph || 0) + dt * (0.3 + 0.25 * (1 - calm) + 1.6 * storm + 0.9 * e);
      const ox = ((st.ox % per) + per) % per, oy = ((st.oy % per) + per) % per;
      // undulation everywhere, zigzag in a storm
      const ag = cs * (0.22 + 0.18 * (1 - calm) + 0.55 * storm + 0.3 * e), zz = storm * cs * 0.42, ph = st.ph;
      for (let j = 0, o = 0; j <= ny; j++) {
        const by = (j - 3) * cs + oy;
        const zx = zz * (Math.abs(((j * 0.5 + T * 2.1) % 2) - 1) * 2 - 1);
        for (let i = 0; i <= nx; i++, o++) {
          const bx = (i - 3) * cs + ox;
          X[o] = bx + ag * 0.6 * Math.sin(by * 8.9 / H - ph * 0.8) + zx;
          Y[o] = by + ag * Math.sin(bx * 6.3 / W + by * 2.6 / H - ph) + zz * 0.6 * (Math.abs(((i * 0.5 - T * 1.7) % 2 + 2) % 2 - 1) * 2 - 1);
          wv[o] = 0; own[o] = -1; LX[o] = 0; LY[o] = 0; LG[o] = 0;
        }
      }
      // the bulges: one per raining place, a big one where the breath comes in, a shock from a strike
      const lens = (cx, cy, r, A, id) => {
        if (A < 0.01 || r < 2) return;
        const i0 = Math.max(0, Math.floor((cx - 2.6 * r - ox) / cs) + 3), i1 = Math.min(nx, Math.ceil((cx + 2.6 * r - ox) / cs) + 3);
        const j0 = Math.max(0, Math.floor((cy - 2.6 * r - oy) / cs) + 3), j1 = Math.min(ny, Math.ceil((cy + 2.6 * r - oy) / cs) + 3), ir = 1 / (r * r);
        for (let j = j0; j <= j1; j++) {
          const by = (j - 3) * cs + oy, dy = by - cy;
          for (let i = i0; i <= i1; i++) {
            const dx = (i - 3) * cs + ox - cx, g = A * Math.exp(-(dx * dx + dy * dy) * ir), o = j * N1 + i;
            if (g < 0.004) continue;
            LX[o] += dx * g; LY[o] += dy * g; LG[o] += g;
            if (id >= 0 && g > wv[o]) { wv[o] = g; own[o] = id; }
          }
        }
      };
      const sites = E.sites, Rb = Math.min(W, H) * 0.047;
      for (let n = 0; n < sites.length; n++) {
        const z = sites[n], lat = 90 - z.v * 180, lv = clamp((80 - lat) / 140, 0, 1);
        const br = 1 + 0.1 * Math.sin(T * (0.45 + 0.3 * z.k) + z.id) * (0.4 + calm) + 0.15 * e;
        lens(W * (0.06 + 0.88 * z.u), H * (0.08 + 0.84 * lv), Rb * (0.5 + 1.1 * z.k) * br, (0.5 + 0.7 * z.k) * (1 + 0.2 * e), n);
      }
      if (e > 0.01) {
        const bxp = (0.5 + 0.44 * clamp(E.mx, -1, 1)) * W, byp = (0.5 + 0.38 * clamp(E.my, -1, 1)) * H;
        lens(bxp + wx * e * W * 0.12, byp, Math.min(W, H) * (0.14 + 0.14 * e), 1.3 * e, -1);
      }
      // where bulges overlap they share the room instead of piling up
      for (let o = 0; o < X.length; o++) if (LG[o] > 0) { const q = LG[o] > 1 ? 1 / LG[o] : 1; X[o] += LX[o] * q; Y[o] += LY[o] * q; }
      let flash = 0;
      for (const b of R.bolts) {
        const age = T - b.t; if (age < 0) continue;
        const fl = (age < 0.07 ? 1 : age < 0.12 ? 0.2 : age < 0.2 ? 0.9 : 0) * (b.power || 0.6);
        flash = Math.max(flash, fl);
        const cx = (b.u == null ? 0.5 : b.u) * W, cy = H * (0.3 + 0.4 * hash((b.seed | 0) + 3)), rr = W * (0.04 + 1.1 * age), A = 0.8 * Math.max(0, 1 - age / 1.2) * (b.power || 0.6);
        if (A > 0.01) for (let o = 0; o < X.length; o++) {                     // a ring of push travelling out
          const dx = X[o] - cx, dy = Y[o] - cy, d = Math.sqrt(dx * dx + dy * dy) + 1, q = (d - rr) / (cs * 2.2);
          if (q > -3 && q < 3) { const g = A * Math.exp(-q * q) * cs * 1.6 / d; X[o] += dx * g; Y[o] += dy * g; }
        }
      }
      // ---- draw: the paper, then the squares (tinted where a bulge rises)
      const dark = flash > 0.45;                          // a strike flips black and white for an instant
      const INKc = dark ? [236, 230, 218] : [16, 15, 16], PAP = dark ? [10, 10, 12] : [240, 234, 222];
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = `rgb(${PAP})`; c.fillRect(0, 0, W, H);
      const base = new Path2D(), tint = [], ptint = [];
      for (let b = 0; b < 16; b++) { tint.push(null); ptint.push(null); }
      const xmin = -cs * 2, xmax = W + cs * 2, ymin = -cs * 2, ymax = H + cs * 2;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = j * N1 + i, b = a + 1, d = a + N1, cc = d + 1;
        const x0 = X[a]; if (x0 > xmax || X[b] < xmin) continue;
        const y0 = Y[a]; if (y0 > ymax || Y[d] < ymin) continue;
        let w = wv[a], ow = own[a];
        if (wv[b] > w) { w = wv[b]; ow = own[b]; } if (wv[d] > w) { w = wv[d]; ow = own[d]; } if (wv[cc] > w) { w = wv[cc]; ow = own[cc]; }
        const ink = ((i + j) & 1) === 0;
        let p;
        if (w > 0.16 && ow >= 0) {
          const z = sites[ow], kb = opHueOf(90 - z.v * 180) * 4 + Math.min(3, Math.floor((w - 0.16) / 0.2));
          const arr = ink ? tint : ptint; p = arr[kb] || (arr[kb] = new Path2D());
        } else if (ink) p = base; else continue;
        p.moveTo(x0, y0); p.lineTo(X[b], Y[b]); p.lineTo(X[cc], Y[cc]); p.lineTo(X[d], Y[d]); p.lineTo(x0, y0);   // (closePath is very slow on big paths)
      }
      const split = Math.min(1, storm * 1.3 + flash) * cs * 0.16;
      if (split > 0.4) {                                  // a storm: the colours slip apart, red one side and cyan the other in turn, so it shimmers
        st.flip = !st.flip;
        const dx = st.flip ? split : -split, dy = dx * 0.3;
        c.translate(dx, dy); c.fillStyle = st.flip ? 'rgb(255,40,70)' : 'rgb(0,200,255)'; c.fill(base); c.translate(-dx, -dy);
      }
      c.fillStyle = `rgb(${INKc})`; c.fill(base);
      for (let kb = 0; kb < 16; kb++) {
        const hue = OP_HUE[kb >> 2], lv = ((kb & 3) + 1) / 4;
        if (tint[kb]) { c.fillStyle = `rgb(${mix(INKc, hue, (0.35 + 0.65 * lv) * chroma)})`; c.fill(tint[kb]); }
        if (ptint[kb]) { c.fillStyle = `rgb(${mix(PAP, mix(hue, [255, 250, 235], dark ? 0.15 : 0.55), (0.18 + 0.5 * lv) * chroma)})`; c.fill(ptint[kb]); }
      }
    },
  };

  /* ============================================================== 8  Strings
     A light sculpture of taut threads strung between two rails that twist round each other across the
     room, like the string constructions of the 1930s and 40s. Each of the 320 places checked is a hairline
     at its longitude; every raining place adds a bundle of glowing threads (more and brighter where it
     rains harder), slanted by its latitude, north one way and south the other, and coloured by it: cyan in
     the north, magenta at the equator, amber in the south. It turns slowly in the dark. A breath plucks
     the threads near where it blows, so they ring and blur, and screws the ribbon round in its direction; a
     storm sets every thread thrashing and shakes the whole sculpture; a lightning strike runs a pulse of
     white light out along the rails from where it struck. Calm, it hardly turns and barely hums. */
  const STR_NB = 7;
  const strHue = lat => lat >= 0 ? lerp(318, 186, Math.min(1, lat / 60)) : lerp(318, 398, Math.min(1, -lat / 60));
  const STR_COL = Array.from({ length: STR_NB }, (_, b) => hsl2rgb(186 + b * 212 / (STR_NB - 1), 96, 62).split(',').map(Number));
  /* the room is soft and dark, so it lives on the small canvas too: one blow-up a frame draws the room and
     the glow of the threads together */
  function stringsSetup(st, W, H, dpr) {
    st.W = W; st.H = H;
    st.gc = canvas(W / 4, H / 4); st.gx = st.gc.getContext('2d');
    st.gb = canvas(W / 4, H / 4); st.gbx = st.gb.getContext('2d'); st.blur = 'filter' in st.gbx;
    const bg = st.bg = canvas(W / 4, H / 4), g = bg.getContext('2d');
    g.setTransform(bg.width / W, 0, 0, bg.height / H, 0, 0);
    let gr = g.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.5, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, '#140d26'); gr.addColorStop(0.45, '#080614'); gr.addColorStop(1, '#010103');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    gr = g.createLinearGradient(0, H * 0.74, 0, H);                    // a floor far below catches a little light
    gr.addColorStop(0, 'rgba(90,60,150,0)'); gr.addColorStop(1, 'rgba(70,44,120,0.2)');
    g.fillStyle = gr; g.fillRect(0, H * 0.74, W, H * 0.26);
  }
  function stringsThreads(st, E) {
    st.ref = E.pts; st.ref2 = E.sites;
    const th = [], P = E.pts;
    const n = P.length || 160;
    for (let i = 0; i < n; i++) th.push({ t: P.length ? (P[i][1] + 180) / 360 : (i + 0.5) / n, sl: 0.03 + 0.03 * hash(i * 3 + 1), b: -1, amp: 0, hot: 0, ph: hash(i * 3 + 2) * TAU, fr: 16 + 14 * hash(i * 3 + 3), m: 1 });
    for (const z of E.sites) {
      const lat = 90 - z.v * 180, b = clamp(Math.round((strHue(lat) - 186) / 212 * (STR_NB - 1)), 0, STR_NB - 1), nb = 1 + Math.round(3.5 * z.k);
      for (let j = 0; j < nb; j++) {
        const o = j - (nb - 1) / 2, h = hash(z.id * 17 + j);
        th.push({ t: z.u + o * 0.0045, sl: (lat / 90) * 0.36 + o * 0.012, b, k: z.k, amp: 0, hot: 0, ph: h * TAU, fr: 13 + 18 * z.k + 6 * h, m: h < 0.3 ? 2 : 1 });
      }
    }
    st.th = th;
  }
  const strings = {
    name: 'strings', title: 'Strings', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E);
      if (st.W !== W || st.H !== H || !st.bg) stringsSetup(st, W, H, E.dpr);
      if (st.ref !== E.pts || st.ref2 !== E.sites || !st.th) stringsThreads(st, E);
      // the ribbon screws round slowly; the breath turns it in the direction it blows, a storm jerks it about
      const dir = Math.abs(wx) > 0.1 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      st.ph = (st.ph == null ? (T * 0.08) % TAU : st.ph) + dt * (0.07 + 0.06 * (1 - calm) + 0.7 * storm * Math.sin(T * 0.37) + 2.4 * e * dir);
      st.lean = (st.lean || 0) + (wx * e * 0.45 - (st.lean || 0)) * (1 - Math.exp(-dt * 3));
      const yaw = 0.34 * Math.sin(T * 0.043) + st.lean + storm * 0.06 * Math.sin(T * 5.3);
      const pitch = 0.17 + 0.07 * Math.sin(T * 0.061) + wy * e * 0.18;
      const ky = Math.cos(yaw), sy = Math.sin(yaw), kp = Math.cos(pitch), sp = Math.sin(pitch);
      const FOC = 2.1 * W, L = W * 0.41, cx = W / 2 + storm * 5 * s * (rnd() - 0.5), cy = H * 0.5 + storm * 4 * s * (rnd() - 0.5);
      const proj = (X, Y, Z, out) => {
        const x1 = X * ky + Z * sy, z1 = -X * sy + Z * ky, y2 = Y * kp - z1 * sp, z2 = Y * sp + z1 * kp, k = FOC / (FOC + z2);
        out[0] = cx + x1 * k; out[1] = cy + y2 * k; out[2] = k; return out;
      };
      const TW = 1.75 * Math.PI, ph = st.ph, hum = 1 + 0.03 * Math.sin(T * 0.4);
      const rail = (t, side, out) => {
        const a = ph + TW * (t - 0.5) + storm * 0.5 * Math.sin(t * 9 - T * 2.6) + e * 0.7 * Math.sin(Math.PI * t) * dir;
        const h = H * 0.32 * (0.78 + 0.22 * Math.sin(Math.PI * t)) * hum * side, ay = H * 0.035 * Math.sin(TAU * t + T * 0.11);
        return proj((t - 0.5) * 2 * L, ay - h * Math.cos(a), h * Math.sin(a), out);
      };
      // a strike: pulses of light running out along the ribbon both ways from where it struck
      const fronts = [];
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0 && age < 1.2) fronts.push([b.u == null ? 0.5 : b.u, age * 1.1, (b.power || 0.6) * (1 - age / 1.2)]); }
      const bxs = (0.5 + 0.44 * clamp(E.mx, -1, 1)) * W, decay = Math.exp(-dt * (1.3 + 1.4 * calm));
      const hair = new Path2D(), hairV = new Path2D(), lo = [], hi = [];
      for (let b = 0; b < STR_NB; b++) { lo.push(new Path2D()); hi.push(new Path2D()); }
      const p1 = [0, 0, 0], p2 = [0, 0, 0];
      for (const q of st.th) {
        const t2 = q.t + q.sl > 1 || q.t + q.sl < 0 ? q.t - q.sl : q.t + q.sl;
        rail(q.t, 1, p1); rail(t2, -1, p2);
        const xm = (p1[0] + p2[0]) / 2;
        // energy in: the breath plucks the threads near where it blows, a storm all of them, a strike as its pulse passes
        let ex = e * 300 * (0.22 + Math.exp(-((xm - bxs) * (xm - bxs)) / (0.06 * W * W))) + storm * 190 * (0.3 + rnd());
        for (const [tu, rr, pw] of fronts) if (Math.abs(Math.abs(q.t - tu) - rr) < 0.035) { ex += 1600 * pw; q.hot = 1; }
        q.amp = Math.min(24 * s, q.amp * decay + ex * dt * s * (q.b < 0 ? 0.5 : 1));
        q.hot *= Math.exp(-dt * 5);
        const path = q.b < 0 ? (q.amp > 2 || q.hot > 0.2 ? hairV : hair) : lo[q.b];
        path.moveTo(p1[0], p1[1]);
        const ring = q.b >= 0 && (q.amp > 3.5 || q.hot > 0.2) ? hi[q.b] : null;
        if (ring) ring.moveTo(p1[0], p1[1]);
        if (q.amp < 0.6) { path.lineTo(p2[0], p2[1]); if (ring) ring.lineTo(p2[0], p2[1]); continue; }
        // a ringing thread: plucked, it bends into one bow (or two, for the second harmonic) swinging from side to side.
        // Straight pieces, not curves: curves are far slower to draw
        const dx = p2[0] - p1[0], dy = p2[1] - p1[1], ln = Math.hypot(dx, dy) + 1e-6, w = q.amp * Math.sin(T * q.fr + q.ph), nx = -dy / ln * w, ny = dx / ln * w;
        for (const pa of ring ? [path, ring] : [path]) {
          if (q.b < 0) pa.lineTo(p1[0] + dx * 0.5 + nx, p1[1] + dy * 0.5 + ny);
          else if (q.m === 1) { pa.lineTo(p1[0] + dx * 0.25 + nx * 0.7, p1[1] + dy * 0.25 + ny * 0.7); pa.lineTo(p1[0] + dx * 0.5 + nx, p1[1] + dy * 0.5 + ny); pa.lineTo(p1[0] + dx * 0.75 + nx * 0.7, p1[1] + dy * 0.75 + ny * 0.7); }
          else { pa.lineTo(p1[0] + dx * 0.25 + nx, p1[1] + dy * 0.25 + ny); pa.lineTo(p1[0] + dx * 0.75 - nx, p1[1] + dy * 0.75 - ny); }
          pa.lineTo(p2[0], p2[1]);
        }
      }
      const breathe = 0.86 + 0.14 * Math.sin(T * 0.7), heat = Math.min(1, storm * 0.3 + fronts.reduce((a, f) => Math.max(a, f[2]), 0) * 0.3);
      // the small canvas: the room, then every coloured thread and the rails as hairlines, softened and blown up
      // to the screen as the glow (strokes under a pixel wide take the fast hairline path)
      const gx = st.gx, gthin = 0.95 * W / st.gc.width, thin = 0.95 / E.dpr;
      gx.setTransform(1, 0, 0, 1, 0, 0); gx.globalCompositeOperation = 'copy'; gx.drawImage(st.bg, 0, 0);
      gx.setTransform(st.gc.width / W, 0, 0, st.gc.height / H, 0, 0); gx.globalCompositeOperation = 'lighter'; gx.lineWidth = gthin;
      const cols = [];
      for (let b = 0; b < STR_NB; b++) {
        const col = cols[b] = mix(STR_COL[b], [255, 255, 255], heat).join(',');
        gx.strokeStyle = `rgb(${col})`; gx.stroke(lo[b]); gx.stroke(hi[b]);
      }
      const rp = [new Path2D(), new Path2D()];
      for (let side = 0; side < 2; side++) for (let j = 0; j <= 96; j++) { rail(j / 96, side ? -1 : 1, p1); if (j) rp[side].lineTo(p1[0], p1[1]); else rp[side].moveTo(p1[0], p1[1]); }
      gx.strokeStyle = `rgba(255,224,200,${breathe})`; gx.stroke(rp[0]); gx.stroke(rp[1]);
      let gsrc = st.gc;
      if (st.blur) { const g2 = st.gbx; g2.fillStyle = '#020104'; g2.fillRect(0, 0, st.gb.width, st.gb.height); g2.filter = 'blur(1.3px)'; g2.drawImage(st.gc, 0, 0); g2.filter = 'none'; gsrc = st.gb; }
      c.globalCompositeOperation = 'source-over'; c.drawImage(gsrc, 0, 0, W, H);
      // then the threads themselves, sharp (plain blending: adding light up is far slower to draw, and the glow
      // underneath already adds up where they cross)
      c.lineCap = 'round';
      c.strokeStyle = `rgba(190,182,255,${0.1 * breathe})`; c.lineWidth = lw * 0.55 / E.dpr; c.stroke(hair);
      c.strokeStyle = `rgba(226,218,255,${0.24 * breathe})`; c.lineWidth = lw * 0.7 / E.dpr; c.stroke(hairV);
      c.lineWidth = thin;
      for (let b = 0; b < STR_NB; b++) {
        c.strokeStyle = `rgba(${mix(STR_COL[b], [255, 255, 255], 0.15).join(',')},${0.78 * breathe})`; c.stroke(lo[b]);
        c.strokeStyle = `rgb(${mix(STR_COL[b], [255, 255, 255], 0.4 + heat * 0.5).join(',')})`; c.stroke(hi[b]);
      }
      // the two rails, and the strike's pulses running along them
      c.strokeStyle = `rgba(255,240,228,${0.7 * breathe})`; c.lineWidth = lw * 1.3; c.stroke(rp[0]); c.stroke(rp[1]);
      c.globalCompositeOperation = 'lighter';
      const gs = glow('255,246,236', 64, 0.3);
      for (const [tu, rr, pw] of fronts) for (const t of [tu - rr, tu + rr]) {
        if (t < 0 || t > 1) continue;
        for (const side of [1, -1]) { rail(t, side, p1); const z = (40 + 80 * pw) * s * p1[2]; c.globalAlpha = Math.min(1, pw * 1.4); c.drawImage(gs, p1[0] - z / 2, p1[1] - z / 2, z, z); }
      }
      c.globalAlpha = 1;
      if (fronts.length) { const f = fronts[fronts.length - 1], a = f[1] < 0.07 ? 1 : f[1] < 0.12 ? 0.3 : f[1] < 0.2 ? 0.8 : 0; if (a) { c.fillStyle = `rgba(150,120,255,${0.12 * a * f[2]})`; c.fillRect(0, 0, W, H); } }
      c.globalCompositeOperation = 'source-over';
    },
  };

  /* ============================================================== 9  Maze
     A floor of Truchet tiles (two quarter-circle arcs in each square) that join up into long winding loops,
     drawn as three-stripe 1970s supergraphics. Every raining place sits on one tile (across by longitude,
     down by latitude) and colours a stretch of the loop that runs through it, longer where it rains harder:
     blue far north, teal north, orange in the tropics, magenta south, mustard far south; a bead of light
     runs up and down each stretch. A breath turns the tiles over in a wave rolling away from the side it
     came from, so the loops break and re-join and the colours run off along new paths; a storm keeps tiles
     turning everywhere; a lightning strike turns them in a ring spreading from where it struck. Calm, a
     tile turns only now and then and the beads glow and fade slowly. */
  const MAZE_FAM = [[[70, 124, 246], [176, 208, 255]], [[22, 178, 160], [164, 242, 216]], [[252, 118, 38], [255, 212, 124]], [[238, 60, 122], [255, 178, 202]], [[242, 186, 42], [255, 240, 178]]];
  const mazeFam = lat => lat > 40 ? 0 : lat > 12 ? 1 : lat > -12 ? 2 : lat > -40 ? 3 : 4;
  //               corner x, y, start angle, edge at the start, edge at the end        (orientation 0: arcs 0, 1; orientation 1: arcs 0, 1)
  const MAZE_ARC = [[[0, 0, 0, 'T', 'L'], [1, 1, Math.PI, 'B', 'R']], [[1, 0, Math.PI / 2, 'R', 'T'], [0, 1, Math.PI * 1.5, 'L', 'B']]];
  const MAZE_IN = [{ T: 0, L: 0, B: 1, R: 1 }, { T: 0, R: 0, B: 1, L: 1 }];       // which arc of a tile touches each edge
  const MAZE_STEP = { T: [0, -1, 'B'], B: [0, 1, 'T'], L: [-1, 0, 'R'], R: [1, 0, 'L'] };
  function mazeSetup(st, W, H, dpr) {
    st.W = W; st.H = H;
    const cs = st.cs = Math.round(Math.min(W, H) / 11.5), cols = st.cols = Math.ceil(W / cs) + 1, rows = st.rows = Math.ceil(H / cs) + 1;
    st.x0 = (W - cols * cs) / 2; st.y0 = (H - rows * cs) / 2;
    const n = cols * rows;
    st.o = new Uint8Array(n); st.a0 = new Float32Array(n).fill(-99); st.dr = new Int8Array(n);
    for (let i = 0; i < n; i++) st.o[i] = hash(i * 17 + 3) < 0.5 ? 1 : 0;
    st.fr = []; st.topo = 1;
    // one quarter-circle of three stripes per colour, drawn once (blitting them is far cheaper than stroking ~700 arcs a frame)
    const r0 = cs / 2, dd = cs * 0.15, sw = cs * 0.085, S = Math.ceil(r0 + dd + sw), NEU = [66, 54, 92];
    const sprite = (o, m) => {
      const cv = canvas(S * dpr, S * dpr), x = cv.getContext('2d');
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.lineCap = 'butt';
      x.strokeStyle = `rgb(${o})`; x.lineWidth = sw; x.beginPath(); x.arc(0, 0, r0 - dd, 0, Math.PI / 2); x.moveTo(r0 + dd, 0); x.arc(0, 0, r0 + dd, 0, Math.PI / 2); x.stroke();
      x.strokeStyle = `rgb(${m})`; x.lineWidth = sw * 1.15; x.beginPath(); x.arc(0, 0, r0, 0, Math.PI / 2); x.stroke();
      return cv;
    };
    st.S = S; st.spr = [sprite(NEU, NEU)];
    for (const q of [1, 0.55]) for (const f of MAZE_FAM) st.spr.push(sprite(mix(NEU, f[0], q), mix(NEU, f[1], q)));
    const bg = st.bg = canvas(W * dpr, H * dpr), g = bg.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, '#1d1630'); gr.addColorStop(1, '#130e1f');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(255,230,200,${0.01 + 0.025 * hash(i * 3 + 1)})`; g.fillRect(hash(i * 3 + 2) * W, hash(i * 3 + 3) * H, 1, 1); }
    gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.4, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.42)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // the floor as it stands: tiles at rest are drawn here, and only a tile that changes is drawn again
    st.floor = canvas(W * dpr, H * dpr); st.flx = st.floor.getContext('2d'); st.flx.drawImage(bg, 0, 0);
    st.cur = new Int16Array(n * 2).fill(-1);
  }
  const maze = {
    name: 'maze', title: 'Maze', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E);
      if (st.W !== W || st.H !== H || !st.bg) mazeSetup(st, W, H, E.dpr);
      const { cs, cols, rows, x0, y0, o, a0, dr } = st, N = cols * rows, DUR = 0.32;
      const flip = (t, d) => { if (T - a0[t] < DUR) return; o[t] ^= 1; a0[t] = T; dr[t] = d; st.topo++; };
      // ---- what turns the tiles: waves from the breath, a strike or a tap; the storm everywhere; calm now and then
      const bx = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, by = (0.5 + 0.42 * clamp(E.my, -1, 1)) * H;
      if (e > 0.2 && T - (st.lastFr || -9) > 0.7 - 0.25 * e) {
        st.lastFr = T;
        const d = Math.abs(wx) > 0.15 ? Math.sign(wx) : 0;
        st.fr.push(d ? { line: true, x: bx - d * cs, d, v: (0.75 + 0.9 * e) * W, y: by, hh: H * (0.2 + 0.35 * e), p: 0.4 + 0.35 * e, sd: rnd() * 1e6 | 0 }
                     : { x: bx, y: by, r: 0, v: (0.5 + 0.6 * e) * W, rmax: W * (0.25 + 0.4 * e), p: 0.4 + 0.35 * e, sd: rnd() * 1e6 | 0, d: rnd() < 0.5 ? 1 : -1 });
      }
      for (const b of R.bolts) if (b.t > (st.bolt || 0) && T >= b.t) {
        st.bolt = b.t;
        st.fr.push({ x: (b.u == null ? 0.5 : b.u) * W, y: H * (0.3 + 0.4 * hash((b.seed | 0) + 1)), r: 0, v: 1.5 * W, rmax: Math.hypot(W, H), p: 0.95, sd: b.seed | 0, d: 1 });
      }
      for (const r of R.ripples) if (r.t > (st.rip || 0) && T >= r.t) {
        st.rip = r.t;
        st.fr.push({ x: (r.x - R.view.x) * s, y: (r.y - R.view.y) * s, r: 0, v: 0.6 * W, rmax: W * 0.16, p: 0.9, sd: (r.seed || 1) | 0, d: 1 });
      }
      for (const f of st.fr) {
        if (f.line) {
          const xa = f.x; f.x += f.d * f.v * dt;
          const lo = Math.min(xa, f.x), hi = Math.max(xa, f.x);
          for (let t = 0; t < N; t++) {
            const tx = x0 + (t % cols + 0.5) * cs, ty = y0 + (Math.floor(t / cols) + 0.5) * cs;
            if (tx > lo && tx <= hi && Math.abs(ty - f.y) < f.hh * (0.6 + 0.4 * hash(t * 7 + f.sd)) && hash(t * 13 + f.sd) < f.p) flip(t, f.d);
          }
          f.dead = f.x < -cs || f.x > W + cs;
        } else {
          const ra = f.r; f.r += f.v * dt;
          for (let t = 0; t < N; t++) {
            const d = Math.hypot(x0 + (t % cols + 0.5) * cs - f.x, y0 + (Math.floor(t / cols) + 0.5) * cs - f.y);
            if (d > ra && d <= f.r && hash(t * 13 + f.sd) < f.p) flip(t, f.d);
          }
          f.dead = f.r > f.rmax;
        }
      }
      st.fr = st.fr.filter(f => !f.dead);
      let nf = (storm * 0.42 + 0.012 + 0.04 * (1 - calm)) * N * dt * (storm > 0.05 ? 1 : 0.25);
      while (nf > 0) { if (nf < 1 && rnd() > nf) break; nf -= 1; flip(Math.floor(rnd() * N), rnd() < 0.5 ? 1 : -1); }
      // ---- the loops: from each raining place, walk along its loop both ways, arc by arc through the tiles;
      //      the stretch it colours is longer where it rains harder
      if (st.sref !== E.sites || st.done !== st.topo && (T - (st.doneT || 0) > 0.05 || T < (st.doneT || 0))) {    // (at most 20 times a second)
        st.done = st.topo; st.doneT = T; st.sref = E.sites;
        const walk = (t, a, ein, max) => {
          const out = [];
          for (let n = 0; n < max; n++) {
            const A = MAZE_ARC[o[t]][a], fwd = A[3] === ein, eout = fwd ? A[4] : A[3];
            out.push([t, a, fwd]);
            const [di, dj, enext] = MAZE_STEP[eout], i = t % cols + di, j = (t - t % cols) / cols + dj;
            if (i < 0 || j < 0 || i >= cols || j >= rows) break;
            t = j * cols + i; ein = enext; a = MAZE_IN[o[t]][ein];
            if (t === out[0][0] && a === out[0][1]) break;
          }
          return out;
        };
        const col = st.col = new Map();
        st.seeds = [];
        for (const z of E.sites) {
          const lat = 90 - z.v * 180, i = clamp(Math.floor((0.03 + 0.94 * z.u) * cols), 0, cols - 1), j = clamp(Math.floor((0.05 + 0.9 * clamp((80 - lat) / 140, 0, 1)) * rows), 0, rows - 1);
          const t = j * cols + i, a = hash(z.id * 3) < 0.5 ? 0 : 1, fam = mazeFam(lat), len = Math.round(5 + 26 * z.k), A = MAZE_ARC[o[t]][a];
          const fw = walk(t, a, A[3], len + 1), bw = walk(t, a, A[4], len + 1);
          const path = bw.slice(1).reverse().map(([tt, aa, f]) => [tt, aa, !f]).concat(fw);
          path.forEach(([tt, aa], n) => {
            const key = tt * 2 + aa, tail = Math.min(n, path.length - 1 - n) < len * 0.3 ? 1 : 0, cur = col.get(key);
            if (!cur || z.k > cur.k) col.set(key, { fam, k: z.k, tail });
          });
          st.seeds.push({ path, k: z.k, fam, id: z.id });
        }
      }
      // ---- draw: three stripes along every arc; a raining place's stretch in its family's colours
      c.globalCompositeOperation = 'source-over';
      const geo = (t, a, out) => {                          // an arc's centre and start angle, turned with its tile
        const i = t % cols, j = (t - i) / cols, A = MAZE_ARC[o[t]][a], p = clamp((T - a0[t]) / DUR, 0, 1);
        const rot = p < 1 ? -dr[t] * (Math.PI / 2) * (1 - p * p * (3 - 2 * p)) : 0;
        const mx = x0 + (i + 0.5) * cs, my = y0 + (j + 0.5) * cs, ux = (A[0] - 0.5) * cs, uy = (A[1] - 0.5) * cs, cr = Math.cos(rot), sr = Math.sin(rot);
        out[0] = mx + ux * cr - uy * sr; out[1] = my + ux * sr + uy * cr; out[2] = A[2] + rot; return out;
      };
      // a tile at rest lives on the floor canvas (drawn again only when it changes); a tile turning is stroked on top
      const r0 = cs / 2, dd = cs * 0.15, sw = cs * 0.085, g3 = [0, 0, 0], NF = MAZE_FAM.length, S = st.S, dpr = E.dpr, spr = st.spr;
      const flr = st.flx, cur = st.cur;
      if (E.fresh) cur.fill(-1);
      const strokes = spr.map(() => [new Path2D(), new Path2D()]);
      const arcTo = (p, r, a1) => {                     // a turning arc as four straight pieces: the motion hides them, and they draw much faster
        p.moveTo(g3[0] + r * Math.cos(a1), g3[1] + r * Math.sin(a1));
        for (let k = 1; k <= 4; k++) { const a = a1 + k * Math.PI / 8; p.lineTo(g3[0] + r * Math.cos(a), g3[1] + r * Math.sin(a)); }
      };
      for (let t = 0; t < N; t++) {
        const turning = T - a0[t] < DUR, k0 = t * 2;
        const c0 = st.col.get(k0), c1 = st.col.get(k0 + 1), s0 = turning ? -2 : c0 ? 1 + c0.fam + c0.tail * NF : 0, s1 = turning ? -2 : c1 ? 1 + c1.fam + c1.tail * NF : 0;
        if (s0 !== cur[k0] || s1 !== cur[k0 + 1]) {           // this tile changed: draw its square of the floor again
          cur[k0] = s0; cur[k0 + 1] = s1;
          const i = t % cols, j = (t - i) / cols, X = x0 + i * cs, Y = y0 + j * cs;
          flr.setTransform(1, 0, 0, 1, 0, 0); flr.drawImage(st.bg, X * dpr, Y * dpr, cs * dpr, cs * dpr, X * dpr, Y * dpr, cs * dpr, cs * dpr);
          if (!turning) for (let a = 0; a < 2; a++) {
            const A = MAZE_ARC[o[t]][a], q = Math.round(A[2] / (Math.PI / 2)) & 3, ca = [1, 0, -1, 0][q], sa = [0, 1, 0, -1][q];
            flr.setTransform(ca * dpr, sa * dpr, -sa * dpr, ca * dpr, (X + A[0] * cs) * dpr, (Y + A[1] * cs) * dpr);
            flr.drawImage(spr[a ? s1 : s0], 0, 0, S, S);
          }
        }
        if (turning) for (let a = 0; a < 2; a++) {
          geo(t, a, g3);
          const cl = a ? c1 : c0, [po, pm] = strokes[cl ? 1 + cl.fam + cl.tail * NF : 0];
          arcTo(po, r0 - dd, g3[2]); arcTo(po, r0 + dd, g3[2]); arcTo(pm, r0, g3[2]);
        }
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.drawImage(st.floor, 0, 0, W, H);
      c.lineCap = 'butt';
      strokes.forEach(([po, pm], si) => {
        const f = si ? MAZE_FAM[(si - 1) % NF] : null, q = si > NF ? 0.55 : 1, NEU = [66, 54, 92];
        c.strokeStyle = `rgb(${f ? mix(NEU, f[0], q) : NEU})`; c.lineWidth = sw; c.stroke(po);
        c.strokeStyle = `rgb(${f ? mix(NEU, f[1], q) : NEU})`; c.lineWidth = sw * 1.15; c.stroke(pm);
      });
      const breathe = 1 + 0.25 * Math.sin(T * 0.8) * (0.4 + calm);
      // ---- a bead of light runs up and down each coloured stretch, faster where it rains harder
      const spd = 0.6 + 1.1 * (1 - calm) + 5 * e + 6 * storm;
      st.run = (st.run || 0) + dt * spd;
      const beads = new Path2D(), trail = new Path2D(), gl = [];
      for (const sd of st.seeds || []) {
        const walk = sd.path, n = walk.length; if (!n) continue;
        const q0 = (st.run * (0.6 + 0.8 * sd.k) + hash(sd.id) * n) % (2 * n), pos = q0 < n ? q0 : 2 * n - q0 - 1e-3, back = q0 < n ? 1 : -1;
        for (let k = 0; k < 3; k++) {
          const q = pos - back * k * 0.4; if (q < 0 || q >= n) break;
          const [tt, aa, fw] = walk[Math.floor(q)], fr = q - Math.floor(q);
          geo(tt, aa, g3);
          const ang = g3[2] + (fw ? fr : 1 - fr) * Math.PI / 2, x = g3[0] + r0 * Math.cos(ang), y = g3[1] + r0 * Math.sin(ang);
          if (!k) { const rr = sw * (1.1 + 0.5 * sd.k); gl.push([x, y, sd.fam, sd.k]); beads.moveTo(x + rr, y); beads.arc(x, y, rr, 0, TAU); }
          else trail.rect(x - sw * 0.5, y - sw * 0.5, sw, sw);
        }
      }
      for (const [x, y, f, k] of gl) { const z = cs * (0.75 + 0.6 * k) * breathe; c.globalAlpha = 0.42; c.drawImage(glow(MAZE_FAM[f][1].join(','), 64, 0.25), x - z / 2, y - z / 2, z, z); }
      c.globalAlpha = 1;
      c.fillStyle = 'rgba(255,248,232,0.55)'; c.fill(trail);
      c.fillStyle = '#fffaf0'; c.fill(beads);
      // a strike: the floor flashes
      let fl = 0;
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0) fl = Math.max(fl, (age < 0.07 ? 1 : age < 0.12 ? 0.25 : age < 0.2 ? 0.8 : Math.max(0, 0.8 - (age - 0.2) * 2)) * (b.power || 0.6)); }
      if (fl > 0.01) { c.globalCompositeOperation = 'lighter'; c.fillStyle = `rgba(255,200,150,${0.22 * fl})`; c.fillRect(0, 0, W, H); c.globalCompositeOperation = 'source-over'; }
    },
  };

  /* ============================================================== 10  Murmuration
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
      if (storm > 0.05) for (let h = 0; h < 2; h++) hawks.push([Cx + 0.36 * W * vnoise(T * 0.35, h * 9 + 1), Cy + 0.26 * H * vnoise(T * 0.4, h * 9 + 4), Cz + 0.2 * W * vnoise(T * 0.3, h * 9 + 7), 0.11 * W, storm * 3200 * sc, h]);
      let startle = 0;
      for (const b of R.bolts) if (b.t > (st.bolt || 0) && T >= b.t) { st.bolt = b.t; startle = Math.max(startle, b.power || 0.6); }
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
        for (const [hx, hy, hz, hr, hs] of hawks) {
          const dx = px - hx, dy = py - hy, dz = pz - hz, dd = dx * dx + dy * dy + dz * dz;
          if (dd < hr * hr) { const q = Math.sqrt(dd) + 1, f = hs * (1 - q / hr) * (1 - q / hr) / q; axx += dx * f; ayy += dy * f; azz += dz * f; }
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
      const FOC = 1.7 * W, cx = W / 2, cy = H / 2, sz0 = 0.0042 * W;
      const B3 = [new Path2D(), new Path2D(), new Path2D()], dots = new Path2D(), xs = [], ys = [];
      for (let b = 0; b < N; b++) {
        const i3 = b * 3, k = FOC / (FOC + P[i3 + 2]);
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
        const k = FOC / (FOC + hk[2]), x = cx + hk[0] * k, y = cy + hk[1] * k, prev = st.hk[h] || [x - 1, y];
        let fx = x - prev[0], fy = y - prev[1]; const fm = Math.hypot(fx, fy) + 1e-3; fx /= fm; fy /= fm;
        st.hk[h] = [lerp(prev[0], x, 0.3), lerp(prev[1], y, 0.3)];
        const sz = sz0 * 4.5 * k, fp = Math.sin(T * 9 + h * 2), span = sz * (0.7 + 0.3 * fp), swp = sz * (0.35 - 0.25 * fp);
        c.fillStyle = 'rgba(14,9,3,0.95)'; c.beginPath();
        c.moveTo(x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.quadraticCurveTo(x - fy * span * 0.5 + fx * sz * 0.1, y + fx * span * 0.5 + fy * sz * 0.1, x - fy * span - fx * swp, y + fx * span - fy * swp);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2); c.lineTo(x - fx * sz * 0.6 - fy * sz * 0.12, y - fy * sz * 0.6 + fx * sz * 0.12); c.lineTo(x - fx * sz * 0.6 + fy * sz * 0.12, y - fy * sz * 0.6 - fx * sz * 0.12);
        c.lineTo(x - fx * sz * 0.2, y - fy * sz * 0.2);
        c.lineTo(x + fy * span - fx * swp, y - fx * span - fy * swp);
        c.quadraticCurveTo(x + fy * span * 0.5 + fx * sz * 0.1, y - fx * span * 0.5 + fy * sz * 0.1, x + fx * sz * 0.55, y + fy * sz * 0.55);
        c.fill();
      }
    },
  };

  /* ================================================================ modes 11-15: the rain itself
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
  /* a maple leaf (unit size, stem down), for the puddle */
  const LEAF = (() => {
    const lobes = [[-Math.PI / 2, 1], [-Math.PI / 2 - 0.92, 0.84], [-Math.PI / 2 + 0.92, 0.84], [-Math.PI / 2 - 1.85, 0.52], [-Math.PI / 2 + 1.85, 0.52]];
    const p = [];
    for (let i = 0; i < 72; i++) {
      const a = -Math.PI / 2 + i / 72 * TAU;
      let r = 0.24;
      for (const [c0, w] of lobes) { const d = Math.cos(a - c0); if (d > 0) r = Math.max(r, w * Math.pow(d, 9)); }
      r += 0.07 * Math.abs(Math.sin(a * 13)) * Math.max(0, r - 0.3);          // a serrated edge on the lobes
      p.push([Math.cos(a) * r, Math.sin(a) * r + 0.1]);
    }
    return p;
  })();
  let _leafPath = null;
  const leafPath = () => {
    if (_leafPath) return _leafPath;
    const P = new Path2D(); LEAF.forEach(([x, y], i) => i ? P.lineTo(x, y) : P.moveTo(x, y)); P.closePath();
    const V = new Path2D(); for (const a of [-Math.PI / 2, -Math.PI / 2 - 0.92, -Math.PI / 2 + 0.92, -Math.PI / 2 - 1.85, -Math.PI / 2 + 1.85]) { V.moveTo(0, 0.1); V.lineTo(Math.cos(a) * 0.8, Math.sin(a) * 0.8 + 0.1); }
    V.moveTo(0, 0.1); V.lineTo(0.02, 0.62);
    return (_leafPath = [P, V]);
  };
  const LEAF_COL = ['196,52,30', '222,98,28', '234,160,32', '176,36,30', '214,128,42', '150,40,36'];

  /* ============================================================== 11  Puddle
     Looking straight down into a rain puddle on a Seattle street. The water mirrors the sky: at night a
     violet sky, a sodium streetlight and the bare branches of a maple, with a star for every place checked
     where it is dry right now; by day a pale sky with clouds. Every raining place is a spot of the puddle
     where drops land (across by longitude, down by latitude): heavier rain = more and bigger drops;
     drizzle is a fine stipple of tiny rings, showers come in bursts, a thunderstorm throws big drops that
     bounce. The rings spread, cross and interfere (a real wave simulation) and break the reflection up.
     A breath is a gust over the water: cat's-paws race away from the side it came from, the reflection
     shatters and the fallen leaves sail across. A storm whips the whole puddle and the lightning flashes in
     it; calm, the water stills to a mirror with a drip from the branches now and then. A tap drops a big
     drop where it lands (on a raining place: a burst of drops there). */
  function puddleBlob(st, W, H) {
    const N = 256, rT = new Float32Array(N);
    for (let i = 0; i < N; i++) { const a = i / N * TAU, ca = Math.cos(a), sa = Math.sin(a); rT[i] = 1 + 0.15 * vnoise(ca * 1.3 + 3.1, sa * 1.3 + 7.7) + 0.05 * vnoise(ca * 3.6 + 1.3, sa * 3.6 + 2.9); }
    const b = { cx: W * 0.5, cy: H * 0.5, rx: W * 0.53, ry: H * 0.56, rT };
    b.rho = (x, y) => {                              // 0 at the middle, 1 at the shore
      const dx = (x - b.cx) / b.rx, dy = (y - b.cy) / b.ry, a = Math.atan2(dy, dx);
      return Math.hypot(dx, dy) / rT[(Math.round(a / TAU * N) % N + N) % N];
    };
    b.path = (sc = 1) => { const p = new Path2D(); for (let i = 0; i <= N; i += 2) { const a = i / N * TAU, r = rT[i % N] * sc; const x = b.cx + Math.cos(a) * b.rx * r, y = b.cy + Math.sin(a) * b.ry * r; i ? p.lineTo(x, y) : p.moveTo(x, y); } p.closePath(); return p; };
    st.blob = b;
  }
  /* the sky over the puddle, as the water mirrors it (drawn at any size: crisp for the still mirror, small for the moving one) */
  function puddleSky(st, E, day, w, h) {
    const cv = canvas(w, h), g = cv.getContext('2d'), u = h / 100;
    let gr = g.createLinearGradient(0, 0, w * 0.5, h);
    if (day) { gr.addColorStop(0, '#f3f6f8'); gr.addColorStop(0.45, '#c8dae8'); gr.addColorStop(1, '#8fb0cc'); }
    else { gr.addColorStop(0, '#03051a'); gr.addColorStop(0.5, '#0a0d30'); gr.addColorStop(1, '#140b33'); }
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const lx = w * 0.64, ly = h * 0.36;
    const blob = (x, y, r, col, a) => { const q = g.createRadialGradient(x, y, 0, x, y, r); q.addColorStop(0, `rgba(${col},${a})`); q.addColorStop(0.5, `rgba(${col},${a * 0.35})`); q.addColorStop(1, `rgba(${col},0)`); g.fillStyle = q; g.fillRect(x - r, y - r, 2 * r, 2 * r); };
    if (day) {
      for (let i = 0; i < 30; i++) blob(hash(i * 5 + 1) * w, hash(i * 5 + 2) * h, (9 + 24 * hash(i * 5 + 3)) * u, '255,255,255', 0.55 + 0.35 * hash(i * 5 + 4));
      blob(w * 0.22, h * 0.72, 48 * u, '255,248,226', 0.75);                       // the sun behind thin cloud
    } else {
      blob(w * 0.04, h * 0.98, 60 * u, '220,70,40', 0.34);                         // the city's glow low on one side
      blob(-w * 0.02, h * 0.5, 38 * u, '30,210,200', 0.42);                        // a shop's neon round the corner
      blob(w * 1.02, h * 0.06, 44 * u, '236,50,170', 0.4);
      for (let i = 0; i < 6; i++) blob(hash(i * 5 + 9) * w, hash(i * 5 + 8) * h, (10 + 20 * hash(i * 5 + 7)) * u, '110,60,140', 0.1);   // clouds lit from below
      g.fillStyle = '#e8e6ff';
      for (const q of points(E)) if (!q.rain) {          // a star for each place checked where it is dry right now
        const x = (q.lon + 180) / 360 * w, y = (0.04 + 0.92 * clamp((80 - q.lat) / 140, 0, 1)) * h, hh = hash(q.id * 3 + 1), d = Math.max(1, u * (hh > 0.85 ? 0.32 : 0.2));
        g.globalAlpha = 0.25 + 0.65 * hh * hh; g.fillRect(x, y, d, d);
      }
      g.globalAlpha = 1;
      blob(lx, ly, 46 * u, '255,120,40', 0.55); blob(lx, ly, 18 * u, '255,180,90', 0.75); blob(lx, ly, 8 * u, '255,236,190', 1);   // the sodium lamp
    }
    // the streetlight: its arm from the kerb and its head, dark from below; the lens lit at night
    g.strokeStyle = day ? '#34343a' : '#030206'; g.lineCap = 'round';
    g.lineWidth = 1.5 * u; g.beginPath(); g.moveTo(w * 1.05, ly - 7 * u); g.quadraticCurveTo(lx + 30 * u, ly - 7 * u, lx + 7 * u, ly - 0.5 * u); g.stroke();
    g.fillStyle = day ? '#3e3e45' : '#050408'; g.beginPath(); g.ellipse(lx, ly, 8.5 * u, 3.3 * u, -0.08, 0, TAU); g.fill();
    g.fillStyle = day ? '#9a9da4' : '#fff6e2'; g.beginPath(); g.ellipse(lx - 0.6 * u, ly + 0.2 * u, 5.8 * u, 1.9 * u, -0.08, 0, TAU); g.fill();
    // a maple overhead: bare branches reaching in from two sides (where they end, drops gather and fall)
    const tips = [];
    g.strokeStyle = day ? 'rgba(48,40,36,0.94)' : 'rgba(3,2,6,0.97)';
    const branch = (x, y, a, len, wd, d, sd) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len, bend = (hash(sd * 3 + 7) - 0.5) * 0.6;
      g.lineWidth = wd; g.beginPath(); g.moveTo(x, y);
      g.quadraticCurveTo((x + x2) / 2 - Math.sin(a) * len * bend * 0.3, (y + y2) / 2 + Math.cos(a) * len * bend * 0.3, x2, y2); g.stroke();
      if (d === 0 || len < 1.2 * u) { tips.push([x2 / w, y2 / h]); return; }
      const n = hash(sd * 5 + 1) < 0.3 ? 3 : 2;
      for (let i = 0; i < n; i++) branch(x2, y2, a + (i - (n - 1) / 2) * (0.5 + 0.3 * hash(sd * 11 + i)) + (hash(sd * 13 + i) - 0.5) * 0.55,
                                         len * (0.68 + 0.16 * hash(sd * 17 + i)), Math.max(0.12 * u, wd * 0.66), d - 1, sd * 7 + i + 1);
    };
    branch(-w * 0.03, -h * 0.06, 0.6, 30 * u, 2.6 * u, 8, 11);
    branch(w * 1.03, h * 1.06, Math.PI + 0.72, 27 * u, 2.3 * u, 7, 29);
    st.tips = tips;
    return cv;
  }
  function envOf(sky, gw, gh) {                      // the small copy the moving water reads from
    const cv = canvas(gw, gh), g = cv.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; if ('filter' in g) g.filter = 'blur(0.8px)'; g.drawImage(sky, 0, 0, gw, gh); g.filter = 'none';
    const d = g.getImageData(0, 0, gw, gh).data, env = new Uint8ClampedArray(gw * gh * 3);
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { env[j] = d[i]; env[j + 1] = d[i + 1]; env[j + 2] = d[i + 2]; }
    return env;
  }
  function puddleGround(st, W, H, dpr, day) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), b = st.blob, sk = W / 1600;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = day ? '#6b6863' : '#121115'; g.fillRect(0, 0, W, H);
    let gr = g.createRadialGradient(W * 0.68, H * 0.32, 0, W * 0.68, H * 0.32, W * 0.75);       // wet asphalt catches the lamp (or the daylight)
    gr.addColorStop(0, day ? 'rgba(255,255,255,0.12)' : 'rgba(255,140,60,0.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const grains = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];       // the stones in the asphalt
    for (let i = 0; i < 36000; i++) { const h = hash(i * 7 + 1), d = (0.8 + 2.2 * hash(i * 7 + 4) ** 3) * Math.max(0.7, sk * 1.3); grains[Math.floor(h * 4)].rect(hash(i * 7 + 2) * W, hash(i * 7 + 3) * H, d, d); }
    (day ? ['rgba(28,26,24,0.34)', 'rgba(40,38,36,0.2)', 'rgba(200,194,184,0.18)', 'rgba(232,226,216,0.32)'] : ['rgba(0,0,0,0.6)', 'rgba(0,0,0,0.3)', 'rgba(130,118,128,0.16)', 'rgba(190,170,170,0.24)'])
      .forEach((col, i) => { g.fillStyle = col; g.fill(grains[i]); });
    // fallen leaves stuck to the wet road around the puddle
    const [LP, LV] = leafPath();
    for (let i = 0; i < 30; i++) {
      const a = hash(i * 9 + 1) * TAU, r = 1.02 + 0.3 * hash(i * 9 + 2) ** 2, x = b.cx + Math.cos(a) * b.rx * r * b.rT[Math.floor(a / TAU * 256) % 256], y = b.cy + Math.sin(a) * b.ry * r * b.rT[Math.floor(a / TAU * 256) % 256];
      const z = (15 + 16 * hash(i * 9 + 3)) * sk * 1.6;
      g.save(); g.translate(x, y); g.rotate(hash(i * 9 + 4) * TAU); g.scale(z, z);
      const col = LEAF_COL[i % LEAF_COL.length].split(',').map(v => Math.round(v * (day ? 0.82 : 0.36)));
      g.fillStyle = `rgb(${col})`; g.fill(LP); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 0.03; g.stroke(LV);
      g.restore();
    }
    // the shore: a dark wet band, then the water cut out with a soft edge and a faint bright meniscus
    const blur = 'filter' in g;
    if (blur) g.filter = `blur(${12 * sk}px)`;
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill(b.path(1.07));
    if (blur) g.filter = `blur(${2.4 * sk}px)`;
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.fill(b.path(0.995));
    g.globalCompositeOperation = 'source-over';
    if (blur) g.filter = `blur(${1 * sk}px)`;
    g.strokeStyle = day ? 'rgba(255,255,255,0.25)' : 'rgba(255,210,170,0.16)'; g.lineWidth = 1.4; g.stroke(b.path(1.0));
    g.filter = 'none';
    return cv;
  }
  function puddleSetup(st, W, H, E) {
    st.W = W; st.H = H;
    const gw = st.gw = 384, gh = st.gh = Math.round(gw * H / W), n = gw * gh, q = Math.min(E.dpr, 1.5);
    st.cw = W / gw; st.ch = H / gh;
    st.h0 = new Float32Array(n); st.h1 = new Float32Array(n);
    st.cv = canvas(gw, gh); st.cx = st.cv.getContext('2d'); st.img = st.cx.createImageData(gw, gh);
    puddleBlob(st, W, H);
    const M = st.M = new Float32Array(n);                       // waves die away at the shore
    for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) M[y * gw + x] = 1 - smoothstep(0.92, 1.04, st.blob.rho((x + 0.5) * st.cw, (y + 0.5) * st.ch));
    st.skyD = puddleSky(st, E, true, W * q, H * q); st.envD = envOf(st.skyD, gw, gh);
    st.skyN = puddleSky(st, E, false, W * q, H * q); st.envN = envOf(st.skyN, gw, gh); st.ptsRef = E.pts;
    st.env = new Uint8ClampedArray(n * 3); st.envAt = -1;
    st.gN = puddleGround(st, W, H, E.dpr, false); st.gD = puddleGround(st, W, H, E.dpr, true);
    st.rings = []; st.spl = []; st.pend = [];
    st.drips = st.tips.map(([x, y], i) => ({ x: x * W, y: y * H, next: hash(i * 3 + 1) * 4 })).filter(d => st.blob.rho(d.x, d.y) < 0.9 && d.x > 0 && d.y > 0 && d.x < W && d.y < H).filter((d, i) => i % 4 === 0).slice(0, 10);
    st.leaves = Array.from({ length: 10 }, (_, i) => { const a = hash(i * 7 + 1) * TAU, r = 0.2 + 0.55 * Math.sqrt(hash(i * 7 + 2));
      return { x: st.blob.cx + Math.cos(a) * st.blob.rx * r, y: st.blob.cy + Math.sin(a) * st.blob.ry * r, vx: 0, vy: 0, a: hash(i * 7 + 3) * TAU, va: 0,
               z: (17 + 14 * hash(i * 7 + 4)) * W / 1600 * 1.7, col: LEAF_COL[i % LEAF_COL.length], sd: i }; });
  }
  const puddle = {
    name: 'puddle', title: 'Puddle', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), dpr = E.dpr;
      if (st.W !== W || st.H !== H || !st.h0) puddleSetup(st, W, H, E);
      if (st.ptsRef !== E.pts) { st.ptsRef = E.pts; const q = Math.min(dpr, 1.5); st.skyN = puddleSky(st, E, false, W * q, H * q); st.envN = envOf(st.skyN, st.gw, st.gh); st.envAt = -1; }
      const day = dayOf(st, E), { gw, gh, cw, ch, M, blob } = st;
      let a = st.h0, b = st.h1;
      // ---- drops: each lands as a dip in the water (the simulation spreads it as rings)
      const drop = (x, y, A, rr) => {
        const gx = x / cw, gy = y / ch, r = Math.max(1, rr), r2 = r * r; A = Math.max(-2.6, A);
        const x0 = Math.max(1, Math.floor(gx - r)), x1 = Math.min(gw - 2, Math.ceil(gx + r)), y0 = Math.max(1, Math.floor(gy - r)), y1 = Math.min(gh - 2, Math.ceil(gy + r));
        for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) { const d2 = (i - gx) ** 2 + (j - gy) ** 2; if (d2 < r2) a[j * gw + i] += A * (1 - d2 / r2); }
        if (st.rings.length < 260) st.rings.push({ x, y, t: T, A: Math.min(1.3, -A * 0.45) });
        if (A < -1.4 && st.spl.length < 60) st.spl.push({ x, y, t: T, n: 5 + Math.floor(-A * 2), sd: rnd() * 1e4 | 0, v: (34 + 24 * -A) * s });
      };
      const amt = (0.06 + 0.94 * (1 - calm)) * (1 + 3 * storm) * (1 + 0.25 * e);
      for (const z of E.sites) {
        const kind = kindOf(E, z), k = z.k, x0 = W * (0.08 + 0.84 * z.u), y0 = H * (0.08 + 0.84 * southOf(z));
        let rate = (0.3 + 2.6 * Math.pow(k, 1.5)) * amt;
        if (kind === 0) rate *= 2.8; else if (kind === 2) rate *= 0.2 + 3.2 * smoothstep(0.05, 0.55, vnoise(T * 0.3 + z.id * 0.1, z.id * 0.37));
        const big = kind === 3 ? 1.8 : kind === 0 ? 0.32 : kind === 2 ? 1.15 : 1;
        let m = rate * dt;
        while (m > 0) {
          if (m < 1 && rnd() > m) break; m -= 1;
          const an = rnd() * TAU, rr = Math.sqrt(rnd()) * (8 + 30 * k) * s, x = x0 + Math.cos(an) * rr, y = y0 + Math.sin(an) * rr * 0.9;
          drop(x, y, -(0.6 + 1.5 * k) * big * (1 + 0.5 * storm), kind === 0 ? 0.8 : 1.2 + 0.9 * k * big);
          if (kind === 3 && rnd() < 0.6) st.pend.push([T + 0.16 + 0.12 * rnd(), x + (rnd() - 0.5) * 10 * s, y + (rnd() - 0.5) * 10 * s, -0.7 * (0.4 + k)]);   // it bounces
        }
      }
      // a storm throws big drops all over the puddle
      let ms = storm * 120 * dt;
      while (ms > 0) { if (ms < 1 && rnd() > ms) break; ms -= 1; drop(W * (0.05 + 0.9 * rnd()), H * (0.05 + 0.9 * rnd()), -(0.8 + 1.2 * rnd()) * (0.6 + storm), 1.4); }
      // drips from the branches overhead: the puddle is never quite still
      for (const d of st.drips) if (T > d.next) { d.next = T + 1.6 + 3.5 * rnd() * (0.5 + calm); drop(d.x, d.y, -1.5, 1.3); }
      // taps: a big drop where it lands; on a raining place a burst of drops there (the wall's own soft notes: one drop)
      for (const q of tapsOf(R, E).fresh) {
        const z = q.site != null ? E.sites.find(o => o.id === q.site) : null;
        if (z) { const x0 = W * (0.08 + 0.84 * z.u), y0 = H * (0.08 + 0.84 * southOf(z)), n = q.echo ? 1 : 6;
          for (let i = 0; i < n; i++) st.pend.push([T + i * 0.11, x0 + (rnd() - 0.5) * 40 * s, y0 + (rnd() - 0.5) * 30 * s, q.echo ? -1.4 : -2.6]); }
        else if (!q.echo) drop(q.x, q.y, -3.2, 2.2);
      }
      st.pend = st.pend.filter(p => { if (T < p[0]) return true; drop(p[1], p[2], p[3], 1.5); return false; });
      // ---- the breath: gusts race across the water away from where it blows; a storm ruffles all of it
      const gust = e * (0.8 + 0.2 * Math.sin(T * 5.3)), dir = Math.abs(wx) > 0.1 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const nk = Math.round((gust * 560 + storm * 140) * Math.min(2, dt * 60));
      if (nk > 0) {
        const bx = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * gw, by = (0.5 + 0.4 * clamp(E.my, -1, 1)) * gh, pb = gust / (gust + storm + 1e-6);
        for (let i = 0; i < nk; i++) {
          let x, y, A;
          if (rnd() < pb) {
            const p = rnd() < 0.5 ? (T * 1.3) % 1 : (T * 1.3 + 0.5) % 1, f = rnd() < 0.6 ? p : p * rnd();     // the gust fronts, and the chop they leave behind
            x = bx + dir * (f * gw * 0.95 + (rnd() - 0.5) * gw * 0.08); y = by + (rnd() - 0.5) * gh * (0.3 + 0.5 * f);
            A = (0.3 + 0.5 * gust) * (rnd() - 0.5) * 2;
          } else { x = rnd() * gw; y = rnd() * gh; A = 0.35 * storm * (rnd() - 0.5) * 2; }
          if (x > 2 && x < gw - 3 && y > 2 && y < gh - 3) { const i0 = Math.floor(y) * gw + Math.floor(x), h = A * 0.5; a[i0] += A; a[i0 - 1] += h; a[i0 + 1] += h; a[i0 - gw] += h; a[i0 + gw] += h; }
        }
      }
      // ---- the waves (a fixed 60 steps a second)
      const damp = 0.983 + 0.009 * calm - 0.006 * storm;
      st.acc = Math.min(4, (st.acc || 0) + dt * 60);
      while (st.acc >= 1) {
        st.acc -= 1;
        for (let y = 1; y < gh - 1; y++) {
          let i = y * gw + 1;
          for (let x = 1; x < gw - 1; x++, i++) b[i] = ((a[i - 1] + a[i + 1] + a[i - gw] + a[i + gw]) * 0.5 - b[i]) * damp * M[i];
        }
        const t = a; a = b; b = t;
      }
      st.h0 = a; st.h1 = b;
      // ---- the mirror: the sky, still and sharp
      c.globalCompositeOperation = 'source-over'; c.imageSmoothingEnabled = true;
      if (day < 0.996) c.drawImage(st.skyN, 0, 0, W, H);
      if (day > 0.004) { c.globalAlpha = day; c.drawImage(st.skyD, 0, 0, W, H); c.globalAlpha = 1; }
      // ---- ... and broken where the water moves: the same sky seen through the slopes of the waves, laid on top
      if (Math.abs(day - st.envAt) > 0.012 || (day !== st.envAt && (day < 0.002 || day > 0.998))) {
        st.envAt = day; const N = st.envN, D = st.envD, o = st.env, q = day < 0.002 ? 0 : day > 0.998 ? 1 : day;
        for (let i = 0; i < o.length; i++) o[i] = N[i] + (D[i] - N[i]) * q;
      }
      const [fl] = flicker(R, T);
      for (const bo of newBolts(R, st, T)) {                       // the lightning, mirrored in the puddle
        const bc = st.bc || (st.bc = canvas(gw, gh)), bx = bc.getContext('2d');
        bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalCompositeOperation = 'source-over'; bx.fillStyle = '#000'; bx.fillRect(0, 0, gw, gh);
        bx.setTransform(gw / W, 0, 0, gh / H, 0, 0); if ('filter' in bx) bx.filter = 'blur(1.2px)'; R._bolt(bx, bo, 0.001, lw * 7); bx.filter = 'none';
        const d = bx.getImageData(0, 0, gw, gh).data, m = st.bm || (st.bm = new Uint8Array(gw * gh));
        for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 1];
      }
      const env = st.env, img = st.img.data, bm = fl > 0.02 && st.bm ? st.bm : null, fb2 = fl * 0.9;
      const Kd = 9, Sp = 26 * (1 - 0.3 * day), tr = 1, tg = 0.84 + 0.16 * day, tb = 0.66 + 0.34 * day, Lx = 0.55, Ly = -0.6, Ka = 1400;
      for (let y = 1; y < gh - 1; y++) {
        let i = y * gw + 1, o = i * 4;
        for (let x = 1; x < gw - 1; x++, i++, o += 4) {
          if (M[i] === 0) { img[o + 3] = 0; continue; }
          const gx = a[i + 1] - a[i - 1], gy = a[i + gw] - a[i - gw];
          let fx = x + gx * Kd, fy = y + gy * Kd;
          if (fx < 0) fx = 0; else if (fx > gw - 1.001) fx = gw - 1.001;
          if (fy < 0) fy = 0; else if (fy > gh - 1.001) fy = gh - 1.001;
          const ix = fx | 0, iy = fy | 0, ux = fx - ix, uy = fy - iy, j = iy * gw + ix, j3 = j * 3, k3 = j3 + gw * 3;   // bilinear, so the broken sky stays smooth
          const w00 = (1 - ux) * (1 - uy), w10 = ux * (1 - uy), w01 = (1 - ux) * uy, w11 = ux * uy;
          const sp = (gx * Lx + gy * Ly) * Sp;
          let r = env[j3] * w00 + env[j3 + 3] * w10 + env[k3] * w01 + env[k3 + 3] * w11 + sp * tr;
          let g2 = env[j3 + 1] * w00 + env[j3 + 4] * w10 + env[k3 + 1] * w01 + env[k3 + 4] * w11 + sp * tg;
          let b2 = env[j3 + 2] * w00 + env[j3 + 5] * w10 + env[k3 + 2] * w01 + env[k3 + 5] * w11 + sp * tb;
          let al = ((gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy)) * Ka - 25;
          if (bm) { const v = bm[j] * fb2; r += v; g2 += v; b2 += v * 1.1; if (v > al) al = v; }
          img[o] = r; img[o + 1] = g2; img[o + 2] = b2; img[o + 3] = al;
        }
      }
      st.cx.putImageData(st.img, 0, 0);
      c.drawImage(st.cv, 1, 1, gw - 2, gh - 2, 0, 0, W, H);
      for (const bo of R.bolts) { const age = T - bo.t; if (age >= 0 && age < 1.2) { c.globalAlpha = 0.5; R._bolt(c, bo, age, lw * 0.9); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; } }
      // ---- faint crisp crests on the newest rings, and the droplets thrown up by the big drops
      const v = 0.7 * 60 * cw, RB = [new Path2D(), new Path2D(), new Path2D()];
      st.rings = st.rings.filter(q => T - q.t < 1);
      for (const q of st.rings) {
        const age = T - q.t, al = q.A * Math.exp(-age * 3.5), r = 1.5 + v * age;
        if (al < 0.06) continue;
        const p = RB[al > 0.5 ? 2 : al > 0.22 ? 1 : 0];
        p.moveTo(q.x + r, q.y); p.arc(q.x, q.y, r, 0, TAU);
      }
      const rc = day > 0.5 ? '255,255,255' : '255,222,190';
      c.lineWidth = lw * 0.5;
      RB.forEach((p, i) => { c.strokeStyle = `rgba(${rc},${[0.04, 0.08, 0.13][i] * (1 - 0.3 * day)})`; c.stroke(p); });
      const sp = new Path2D();
      st.spl = st.spl.filter(q => T - q.t < 0.3);
      for (const q of st.spl) {
        const age = T - q.t, r = q.v * age, d = lw * (1.1 - 2.6 * age);
        for (let k = 0; k < q.n; k++) { const an = hash(q.sd + k) * TAU, rr = r * (0.6 + 0.5 * hash(q.sd + k + 50)); sp.rect(q.x + Math.cos(an) * rr - d / 2, q.y + Math.sin(an) * rr - d / 2, d, d); }
      }
      c.fillStyle = `rgba(${rc},0.6)`; c.fill(sp);
      // ---- the shore and the road around it
      if (day < 0.996) c.drawImage(st.gN, 0, 0, W, H);
      if (day > 0.004) { c.globalAlpha = day; c.drawImage(st.gD, 0, 0, W, H); c.globalAlpha = 1; }
      // ---- leaves afloat: the slope of the water nudges them, the breath sails them across, a storm spins them
      const [LP, LV] = leafPath(), wy = windY(E), bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W;
      for (const L of st.leaves) {
        const gi = clamp(Math.floor(L.y / ch), 1, gh - 2) * gw + clamp(Math.floor(L.x / cw), 1, gw - 2);
        const sx = a[gi + 1] - a[gi - 1], sy = a[gi + gw] - a[gi - gw];
        const air = 0.35 + 0.65 * Math.exp(-((L.x - bxs) ** 2) / (0.5 * W * W));
        L.vx += (-sx * 900 * s + dir * gust * air * 440 * s + storm * 260 * s * vnoise(T * 0.5, L.sd * 3.1)) * dt;
        L.vy += (-sy * 900 * s + wy * gust * air * 280 * s + storm * 200 * s * vnoise(T * 0.5 + 9, L.sd * 2.3)) * dt;
        const rho = blob.rho(L.x, L.y);
        if (rho > 0.8) { L.vx -= (L.x - blob.cx) / blob.rx * (rho - 0.8) * 2400 * s * dt; L.vy -= (L.y - blob.cy) / blob.ry * (rho - 0.8) * 2400 * s * dt; }
        if (L.x < 0.03 * W) L.vx += 300 * s * dt; if (L.x > 0.97 * W) L.vx -= 300 * s * dt; if (L.y < 0.04 * H) L.vy += 300 * s * dt; if (L.y > 0.96 * H) L.vy -= 300 * s * dt;
        const dr = Math.exp(-dt * 1.1); L.vx *= dr; L.vy *= dr;
        L.x += L.vx * dt; L.y += L.vy * dt;
        L.va += ((L.vx * 0.004 - L.vy * 0.002) / s * (0.5 + gust + storm) - L.va * 0.8) * dt * 2; L.a += (L.va + 0.03 * Math.sin(T * 0.3 + L.sd)) * dt;
        const z = L.z * (1 + 0.6 * clamp(a[gi], -0.2, 0.2)), ca = Math.cos(L.a) * z, sa = Math.sin(L.a) * z;
        c.setTransform(ca * dpr, sa * dpr, -sa * dpr, ca * dpr, (L.x + 2.5 * s) * dpr, (L.y + 3 * s) * dpr);
        c.fillStyle = 'rgba(0,0,0,0.32)'; c.fill(LP);
        c.setTransform(ca * dpr, sa * dpr, -sa * dpr, ca * dpr, L.x * dpr, L.y * dpr);
        const col = L.col.split(',').map(q => Math.round(Math.min(255, q * (0.5 + 0.5 * day + 0.4 * fl))));
        c.fillStyle = `rgb(${col})`; c.fill(LP);
        c.strokeStyle = 'rgba(40,10,0,0.35)'; c.lineWidth = 0.035; c.stroke(LV);
      }
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (fl > 0.02) { c.fillStyle = `rgba(214,222,255,${0.18 * fl})`; c.fillRect(0, 0, W, H); }
    },
  };

  return [currents, planet, garden, radar, glass, mobile, op, strings, maze, murm, puddle];
})();
