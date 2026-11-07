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
 * Modes 11-15 also act on the taps themselves: tapsOf(R, E) turns R.ripples into screen points (and the
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

  /* ============================================================== 2  Marbling
     Ebru, Turkish paper marbling, seen from above: ink floats on a bath and every new drop pushes all the
     ink before it outward into rings and veins (the exact mathematics of marbling: the ink keeps its area
     and never blurs). Every raining place drops ink at its own spot again and again: heavier rain = bigger
     drops, more often; the colour comes from the kind of rain and the latitude (drizzle: aqua and celadon,
     a sprinkle of small drops; rain: teal and emerald in the tropics, cobalt in the middle latitudes,
     violet toward the poles; showers: saffron, coral and rose, in bursts of rings; thunderstorms: crimson
     and ink black with a white vein), and now and then clear size water rings a drop in ivory. A breath
     is the marbler's comb: tines drawn through the bath in the direction it blows, around where the mist
     moved, pulling the rings into feathers. A storm stirs the bath into whirlpools; lightning leaves a
     jagged chain of white drops. Calm, the drops come slowly and the bath rests like a finished print.
     A tap drops gold where it lands (on a raining place: a bull's-eye of rings). */
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
  function inPoly(p, x, y) {
    let c = false;
    for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
      const yi = p[i + 1], yj = p[j + 1];
      if ((yi > y) !== (yj > y) && x < (p[j] - p[i]) * (y - yi) / (yj - yi) + p[i]) c = !c;
    }
    return c;
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
      // ---- what goes: drops pushed off screen, rings too thin to see, and the oldest past the budget (the bath takes its colour)
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

  /* ============================================================== 3  Cymatics
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
  function cymSpec(z, kind) {                     // a place's note: which figure the plate rings in
    const h1 = hash(z.id * 3 + 11), h2 = hash(z.id * 3 + 12), h3 = hash(z.id * 3 + 13), lo = Math.round(2 * (1 - z.k));   // heavier rain: a lower note
    const M = (m, n, w, ph) => ({ m, n, w, ph });
    let modes;
    if (kind === 0) modes = [M(6 + Math.floor(h1 * 5), 2 + lo + Math.floor(h2 * 2), 1, 0), M(3 + Math.floor(h3 * 3), 4 + lo, 0.45, h2 * TAU)];             // drizzle: fine lace
    else if (kind === 2) { const m = 3 + Math.floor(h1 * 4); modes = [M(m, 1 + lo, 1, 0), M(m * 2, 1 + lo + Math.floor(h2 * 2), 0.7, h3 * TAU)]; }      // showers: a rosette
    else if (kind === 3) modes = [M(5 + Math.floor(h1 * 4), 3 + lo, 1, 0), M(2 + Math.floor(h2 * 3), 4 + lo, 0.8, h3 * 3), M(9 + Math.floor(h3 * 4), 2, 0.5, h1 * 5)];   // thunderstorms: a dense star
    else modes = [M(2 + Math.floor(h1 * 4), 1 + lo + Math.floor(h2 * 2), 1, 0), M(Math.floor(h3 * 3), 2 + lo, 0.35 * h2, 0)];                           // rain: rings and spokes
    return { modes, rot: h1 * TAU + z.u * TAU, kind };
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
      sp.modes.forEach((o, k) => { v += o.w * Math.cos(o.m * th + o.ph) * tabs[k][Math.round(r * 256)]; });
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
        const Rp = Math.min(W * 0.33, H * 0.7), cx = W / 2, cy = H * 0.56, tz = 0.5, q = 0.16;
        st.Rp = Rp; st.cx = cx; st.cy = cy; st.tz = tz; st.q = q;
        st.P = (X, Y, Z, out) => { const k = 1 / (1 - q * Z); out[0] = cx + Rp * X * k; out[1] = cy + Rp * (tz * Z - 0.9 * Y) * k; out[2] = k; return out; };
        st.inv = (sx, sy) => { const v = (sy - cy) / (Rp * tz), Z = v / (1 + q * v); return [(sx - cx) * (1 - q * Z) / Rp, Z]; };
        [st.bN, st.pN] = cymScene(st, W, H, E.dpr, false); [st.bD, st.pD] = cymScene(st, W, H, E.dpr, true);
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
      const dur = (z => (1.8 + 2.6 * z.k) * (1 + 3 * smoothstep(0.3, 0.9, calm)) / (1 + 5 * storm));
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
      const step = 0.16 * drive * Math.sqrt(dt), pull = 0.05 * (0.6 + drive) * dt;
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
          const s2 = step * av;
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
      const jit = (storm * 1.6 + boom * 3) * sk * 1.5, jx = (rnd() - 0.5) * jit, jy = (rnd() - 0.5) * jit;
      if (jit > 0.05) c.translate(jx, jy);
      c.drawImage(fade2(st, 'fb', st.bN, st.bD, day), 0, 0, W, H);
      // the note's light: from under the plate, round its rim, brightest as the drop strikes
      const nk = cur ? cur.kind : 1, col = CYM_COL[nk].join(','), lit = (0.4 + 0.6 * ring + 0.5 * storm + 0.6 * boom) * (1 - 0.5 * day);
      P(0, 0, 0, p);
      const ex = p[0], ey = p[1], rx = st.Rp;
      c.save(); c.translate(ex, ey + rx * 0.12); c.scale(1, 0.5);
      c.globalCompositeOperation = day > 0.5 ? 'source-over' : 'lighter'; c.globalAlpha = Math.min(1, lit * 0.7);
      c.drawImage(glow(col, 128, 0.35), -rx * 1.5, -rx * 1.5, rx * 3, rx * 3);
      c.restore(); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
      c.drawImage(fade2(st, 'fp', st.pN, st.pD, day), 0, 0, W, H);
      // the coloured light catching the front of the rim
      const rl = new Path2D(); for (let k = 0; k <= 48; k++) { const a = k / 48 * Math.PI; P(Math.cos(a), 0, Math.sin(a), p); k ? rl.lineTo(p[0], p[1] + rx * 0.011) : rl.moveTo(p[0], p[1] + rx * 0.011); }
      c.strokeStyle = `rgba(${col},${Math.min(1, 0.25 + 0.6 * lit) * (1 - 0.4 * day)})`; c.lineWidth = Math.max(1.5, rx * 0.012); c.stroke(rl);
      // the sand (grains in the air cast a small shadow)
      const shade = [new Path2D(), new Path2D(), new Path2D()], shad = new Path2D(), air = new Path2D(), gsz = Math.max(1, 1.5 * sk + 0.35);
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
      c.fillStyle = `rgba(${sand[2]},0.9)`; c.fill(air);
      // rings running out over the plate
      const rp = new Path2D();
      for (const w of st.waves) {
        const age = T - w.t, r = age * 0.9; if (r < 0.01) continue;
        let pen = false;
        for (let k = 0; k <= 40; k++) { const a = k / 40 * TAU, X = w.X + Math.cos(a) * r, Z = w.Z + Math.sin(a) * r; if (X * X + Z * Z > 1) { pen = false; continue; } P(X, 0, Z, p); if (pen) rp.lineTo(p[0], p[1]); else { rp.moveTo(p[0], p[1]); pen = true; } }
      }
      c.strokeStyle = day > 0.5 ? 'rgba(60,40,10,0.18)' : `rgba(${col},0.22)`; c.lineWidth = Math.max(1, 1.2 * sk); c.stroke(rp);
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
      // lightning: the bolt in the dark above, the flash
      for (const b of R.bolts) { const age = T - b.t; if (age >= 0 && age < 1.2) R._bolt(c, b, age, E.lw); }
      c.globalCompositeOperation = 'source-over';
      if (jit > 0.05) c.translate(-jx, -jy);
    },
  };

  const seaglow = { name: 'seaglow', title: 'Sea Glow', dark: true, draw(R, c, E) { c.fillStyle = '#000'; c.fillRect(0, 0, E.W, E.H); } };

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
  /* a cross-fade of two prerendered pictures of the same size, kept while it holds still (one blit a frame, not two) */
  function fade2(st, key, A, B, t) {
    if (t < 0.004) return A; if (t > 0.996) return B;
    let f = st[key];
    if (!f || f.cv.width !== A.width || f.cv.height !== A.height) f = st[key] = { cv: canvas(A.width, A.height), t: -1 };
    if (Math.abs(f.t - t) > 0.02) { const g = f.cv.getContext('2d'); g.clearRect(0, 0, A.width, A.height); g.globalAlpha = 1; g.drawImage(A, 0, 0); g.globalAlpha = t; g.drawImage(B, 0, 0); g.globalAlpha = 1; f.t = t; }
    return f.cv;
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
        if (!q.echo) { const z2 = z ? [W * (0.08 + 0.84 * z.u), H * (0.08 + 0.84 * southOf(z))] : [q.x, q.y]; (st.tapR || (st.tapR = [])).push({ x: z2[0], y: z2[1], t: T });
          st.spl.push({ x: z2[0], y: z2[1], t: T, n: 16, sd: rnd() * 1e4 | 0, v: 150 * s }); }
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
      c.drawImage(fade2(st, 'fs', st.skyN, st.skyD, day), 0, 0, W, H);
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
      // a tap: bright rings spreading from where it landed
      st.tapR = (st.tapR || []).filter(q => T - q.t < 2);
      for (const q of st.tapR) {
        const a2 = (T - q.t) / 2, r = 4 + v * 0.8 * (T - q.t);
        c.lineWidth = lw * 1.2; c.strokeStyle = `rgba(${rc},${0.42 * (1 - a2) * (1 - a2)})`; c.beginPath(); c.ellipse(q.x, q.y, r, r * 0.94, 0.3, 0, TAU); c.stroke();
        if (r > 30 * s) { c.lineWidth = lw * 0.6; c.strokeStyle = `rgba(${rc},${0.16 * (1 - a2)})`; c.beginPath(); c.ellipse(q.x, q.y, r * 0.58, r * 0.55, 0.3, 0, TAU); c.stroke(); }
      }
      // the breath on the water: glints on the cat's-paws racing downwind
      if (gust > 0.04 || storm > 0.1) {
        const bxs2 = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W, bys2 = (0.5 + 0.4 * clamp(E.my, -1, 1)) * H, gl = new Path2D(), n = Math.round((gust * 260 + storm * 120) * W / 1600), wy2 = windY(E);
        for (let i = 0; i < n; i++) {
          const h1 = hash(i * 5 + 1), ph2 = (T * (0.9 + 0.7 * h1) + hash(i * 5 + 2)) % 1, all = i < storm * 120 * W / 1600;
          const x = all ? hash(i * 5 + 3) * W + dir * ph2 * 160 * s : bxs2 + dir * (ph2 * W * 0.9 + (hash(i * 5 + 3) - 0.5) * 60 * s), y = all ? hash(i * 5 + 4) * H : bys2 + (hash(i * 5 + 4) - 0.5) * H * (0.25 + 0.45 * ph2);
          const l = (8 + 20 * hash(i * 5 + 5)) * s * (1 - 0.5 * ph2);
          gl.moveTo(x, y); gl.lineTo(x + dir * l, y + wy2 * l * 0.4);
        }
        c.strokeStyle = `rgba(${rc},${0.62 * Math.min(1, gust + storm * 0.6)})`; c.lineWidth = lw * 0.85; c.stroke(gl);
      }
      // ---- the shore and the road around it
      c.drawImage(fade2(st, 'fg', st.gN, st.gD, day), 0, 0, W, H);
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

  /* ============================================================== 12  Umbrellas
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

  /* ============================================================== 13  Sumi-e
     An ink-wash landscape, after the Song painters of misty rain (and Mi Fu's dotted mountains). Four rows of
     peaks, far to near, from north to south; every raining place raises a peak in its row (across by
     longitude, taller where it rains harder) with a wet cloud over it and its rain falling from it as
     dry-brush strokes: drizzle as a fine stipple, rain as long hairlines, showers as sheets that sweep,
     thunderstorms as heavy black strokes that spatter. Each of the 320 places checked is one of the Mi dots
     on the slopes (wet and dark where it rains, a dry fleck where it does not). Mist lies in the valleys.
     A breath drives the mist across the peaks away from the side it came from, slants the rain and sways the
     pine; a storm darkens the sky, the rain thrashes and ink spatters; lightning is a single dry-brush
     stroke and the paper flashes. Calm, the rain stops, the mist settles and the moon comes out in a pale
     wash. A tap drops ink on the paper (on a raining place, onto its peak, and its rain pours). */
  const SUMI_ROWS = [{ b: 0.5, a: 0.95, ink: [64, 72, 84], al: 0.42 }, { b: 0.61, a: 1, ink: [44, 48, 56], al: 0.6 }, { b: 0.72, a: 0.9, ink: [30, 30, 34], al: 0.78 }, { b: 0.84, a: 0.8, ink: [18, 16, 15], al: 0.95 }];
  const sumiRow = lat => lat > 32 ? 0 : lat > 6 ? 1 : lat > -20 ? 2 : 3;
  function sumiSprites(st, W, H, dpr) {
    const sk = Math.min(W / 1600, H / 900);
    // the paper: rice paper by day, dusky old silk in the rain
    const paper = day => {
      const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = day ? '#f1ebdd' : '#b3ab98'; g.fillRect(0, 0, W, H);
      let gr = g.createLinearGradient(0, 0, 0, H * 0.6);
      gr.addColorStop(0, day ? 'rgba(120,110,90,0.06)' : 'rgba(26,26,34,0.42)'); gr.addColorStop(1, 'rgba(26,26,34,0)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      for (let i = 0; i < 70; i++) { const x = hash(i * 5 + 1) * W, y = hash(i * 5 + 2) * H, r = (40 + 160 * hash(i * 5 + 3)) * sk, q = g.createRadialGradient(x, y, 0, x, y, r);
        q.addColorStop(0, `rgba(${hash(i) < 0.5 ? '255,250,236' : '120,104,80'},${0.04 + 0.04 * hash(i * 5 + 4)})`); q.addColorStop(1, 'rgba(120,104,80,0)'); g.fillStyle = q; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
      const fib = [new Path2D(), new Path2D()];                    // fibres in the paper
      for (let i = 0; i < 2600; i++) { const x = hash(i * 7 + 1) * W, y = hash(i * 7 + 2) * H, a = hash(i * 7 + 3) * TAU, l = (4 + 22 * hash(i * 7 + 4)) * sk, p = fib[i & 1];
        p.moveTo(x, y); p.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); }
      g.lineWidth = 0.6; g.strokeStyle = day ? 'rgba(150,130,100,0.12)' : 'rgba(70,60,46,0.14)'; g.stroke(fib[0]);
      g.strokeStyle = day ? 'rgba(255,255,250,0.5)' : 'rgba(220,212,196,0.18)'; g.stroke(fib[1]);
      gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
      gr.addColorStop(0, 'rgba(90,70,40,0)'); gr.addColorStop(1, day ? 'rgba(110,86,50,0.18)' : 'rgba(40,30,20,0.45)');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      return cv;
    };
    st.pN = paper(false); st.pD = paper(true);
    // a band of mist (white; tinted to the paper below)
    const mw = 640, mh = 150, m = canvas(mw, mh), mg = m.getContext('2d');
    for (let i = 0; i < 70; i++) { const x = (0.08 + 0.84 * hash(i * 3 + 1)) * mw, y = mh * (0.5 + 0.22 * (hash(i * 3 + 2) - 0.5)), r = mh * (0.18 + 0.3 * hash(i * 3 + 3)) * (1 - Math.abs(x / mw - 0.5));
      const q = mg.createRadialGradient(x, y, 0, x, y, r); q.addColorStop(0, 'rgba(255,255,255,0.5)'); q.addColorStop(1, 'rgba(255,255,255,0)'); mg.fillStyle = q; mg.fillRect(x - r, y - r, 2 * r, 2 * r); }
    st.mistMask = m; st.mistTint = {};
    // wet blots of ink: for clouds, and for drops of ink on the paper (with the darker rim of a drying drop)
    const blot = (rim, sd) => {
      const S = 160, cv = canvas(S, S), g = cv.getContext('2d'), c0 = S / 2;
      for (let i = 0; i < 26; i++) { const a = hash(sd + i * 3) * TAU, d = Math.sqrt(hash(sd + i * 3 + 1)) * S * 0.22, r = S * (0.12 + 0.16 * hash(sd + i * 3 + 2)), x = c0 + Math.cos(a) * d, y = c0 + Math.sin(a) * d * (rim ? 1 : 0.55);
        const q = g.createRadialGradient(x, y, 0, x, y, r); q.addColorStop(0, `rgba(0,0,0,${rim ? 0.3 : 0.22})`); q.addColorStop(rim ? 0.85 : 1, `rgba(0,0,0,${rim ? 0.36 : 0})`); q.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = q; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
      return cv;
    };
    st.cloud = [blot(false, 11), blot(false, 211), blot(false, 401)]; st.blot = [blot(true, 77), blot(true, 577)];
    // the seal: 雨 (rain), carved into red stone
    const ss = 96, seal = st.seal = canvas(ss, ss), g = seal.getContext('2d');
    g.fillStyle = '#b3261c'; g.beginPath(); g.moveTo(3, 5); g.lineTo(ss - 4, 3); g.lineTo(ss - 3, ss - 5); g.lineTo(5, ss - 3); g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out'; g.lineCap = 'square'; g.lineWidth = ss * 0.075; g.strokeStyle = '#000';
    const L = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x * ss, y * ss) : g.moveTo(x * ss, y * ss)); g.stroke(); };
    L([[0.14, 0.15], [0.86, 0.15]]); L([[0.5, 0.15], [0.5, 0.86]]); L([[0.18, 0.86], [0.18, 0.31], [0.82, 0.31], [0.82, 0.8], [0.74, 0.86]]);
    for (const [x, y] of [[0.31, 0.45], [0.31, 0.65], [0.65, 0.45], [0.65, 0.65]]) L([[x, y], [x + 0.06, y + 0.08]]);
    for (let i = 0; i < 220; i++) { const d = 0.6 + 2 * hash(i * 3 + 5); g.globalAlpha = 0.3 + 0.5 * hash(i * 3 + 6); g.fillRect(hash(i * 3 + 7) * ss, hash(i * 3 + 8) * ss, d, d); }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    // a pine reaching in from the cliff on the left (it sways in the wind)
    const pw = Math.round(W * 0.42), ph = Math.round(H * 0.4), pine = st.pine = canvas(pw * dpr, ph * dpr), pg = pine.getContext('2d');
    pg.setTransform(dpr, 0, 0, dpr, 0, 0); pg.lineCap = 'round'; pg.strokeStyle = 'rgba(18,16,14,0.92)';
    const limb = (x, y, a, len, w, d, sd) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      for (let k = 0; k < 3; k++) { pg.globalAlpha = k ? 0.35 : 0.9; pg.lineWidth = w * (k ? 0.35 : 1); pg.beginPath(); pg.moveTo(x + k * 1.5, y + k * 1.2); pg.quadraticCurveTo((x + x2) / 2 + (hash(sd + k) - 0.5) * len * 0.4, (y + y2) / 2 + len * 0.12, x2, y2); pg.stroke(); }
      if (d === 0) {                                     // a fan of needles
        pg.globalAlpha = 0.85; pg.lineWidth = 1.1 * sk + 0.4; pg.beginPath();
        for (let k = 0; k < 17; k++) { const b = -Math.PI * 0.95 + k / 16 * Math.PI * 0.9, l = len * (0.5 + 0.25 * hash(sd * 7 + k)); pg.moveTo(x2, y2); pg.lineTo(x2 + Math.cos(b) * l, y2 + Math.sin(b) * l * 0.75); }
        pg.stroke(); return;
      }
      const n = 2 + (hash(sd) < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) limb(x2, y2, a + (i - (n - 1) / 2) * 0.7 + (hash(sd * 3 + i) - 0.5) * 0.4, len * (0.62 + 0.15 * hash(sd * 5 + i)), w * 0.62, d - 1, sd * 7 + i + 1);
    };
    limb(-pw * 0.02, ph * 0.5, -0.16, pw * 0.34, 10 * sk + 2, 3, 5);
    pg.globalAlpha = 1;
    st.pineW = pw; st.pineH = ph;
  }
  function sumiRows(st, E, W, H, dpr) {
    st.ref = E.sites; st.ref2 = E.pts;
    const NX = 241, rows = [], sk = Math.min(W / 1600, H / 900), q = Math.min(dpr, 1.5);
    for (let L = 0; L < 4; L++) {
      const cfg = SUMI_ROWS[L], ridge = new Float32Array(NX), peaks = [];
      for (const z of E.sites) if (sumiRow(latOf(z)) === L) peaks.push({ x: 0.03 + 0.94 * z.u, h: (0.07 + 0.21 * z.k) * cfg.a, w: 0.02 + 0.035 * z.k, z });
      for (let i = 0; i < 3; i++) peaks.push({ x: hash(L * 31 + i * 7) , h: 0.035 + 0.04 * hash(L * 31 + i * 7 + 1), w: 0.05 + 0.05 * hash(L * 31 + i * 7 + 2), z: null });   // a few low hills anyway
      for (let i = 0; i < NX; i++) {
        const x = i / (NX - 1);
        let m = 0.012 + 0.05 * Math.pow(fbm(x * 4.1 + L * 7.1, L * 1.9) * 0.5 + 0.5, 1.6) + 0.025 * Math.max(0, fbm(x * 11 + L * 3, 2 + L)) + 0.006 * fbm(x * 31 + L, 5 + L);
        for (const p of peaks) { const d = Math.abs(x - p.x) / p.w; if (d < 1) m = Math.max(m, p.h * Math.pow(1 - Math.pow(d, 1.8), 1.35) + 0.012 * fbm(x * 40 + L, p.x * 9)); }
        ridge[i] = (cfg.b - m) * H;
      }
      let top = H; for (const v of ridge) top = Math.min(top, v);
      const y0 = Math.max(0, Math.floor(top - 12)), y1 = L === 3 ? H : Math.min(H, Math.ceil(cfg.b * H + H * 0.13)), hh = y1 - y0;
      const cv = canvas(W * q, hh * q), g = cv.getContext('2d'); g.setTransform(q, 0, 0, q, 0, -y0 * q);
      const rx = x => ridge[clamp(Math.round(x / W * (NX - 1)), 0, NX - 1)], ink = cfg.ink.join(',');
      // the body: ink at the tops, dissolving into mist below
      const body = new Path2D(); body.moveTo(-2, y1);
      for (let i = 0; i < NX; i++) body.lineTo(i / (NX - 1) * W, ridge[i]);
      body.lineTo(W + 2, y1); body.closePath();
      let gr = g.createLinearGradient(0, top, 0, cfg.b * H + H * 0.1);
      gr.addColorStop(0, `rgba(${ink},${cfg.al * 0.85})`); gr.addColorStop(0.45, `rgba(${ink},${cfg.al * 0.4})`); gr.addColorStop(1, `rgba(${ink},0)`);
      g.fillStyle = gr; g.fill(body);
      // wet dark tops, and the dry-brush outline of the ridge
      g.save(); g.clip(body);
      g.lineJoin = 'round'; g.strokeStyle = `rgba(${ink},${0.25 * cfg.al})`; g.lineWidth = (16 - L * 2) * sk + 4;
      const rp = new Path2D(); let pon = false; for (let i = 0; i < NX; i++) { if (cfg.b * H - ridge[i] < H * 0.05) { pon = false; continue; } pon ? rp.lineTo(i / (NX - 1) * W, ridge[i] + 3) : rp.moveTo(i / (NX - 1) * W, ridge[i] + 3); pon = true; }
      g.stroke(rp); g.restore();
      for (let k = 0; k < 3; k++) {
        const p = new Path2D(); let on = false;
        for (let i = 0; i < NX; i++) { const x = i / (NX - 1) * W, y = ridge[i] + k * 1.6 + (hash(L * 977 + i * 3 + k) - 0.5) * 1.2;
          if (hash(L * 131 + i * 7 + k * 3) < 0.12 || cfg.b * H - ridge[i] < H * 0.045) { on = false; continue; } on ? p.lineTo(x, y) : p.moveTo(x, y); on = true; }
        g.strokeStyle = `rgba(${ink},${(k ? 0.28 : 0.7) * cfg.al})`; g.lineWidth = (k ? 0.8 : 1.6 + 0.6 * L) * (0.6 + 0.4 * sk); g.stroke(p);
      }
      // hemp-fibre strokes down the slopes
      const cun = new Path2D();
      for (let i = 0; i < 70 + L * 20; i++) { const x = hash(L * 51 + i * 3) * W, y = rx(x) + 4, l = (cfg.b * H - y) * (0.3 + 0.5 * hash(L * 51 + i * 3 + 1)); if (l < 6) continue;
        cun.moveTo(x, y); cun.bezierCurveTo(x + (hash(i * 9 + L) - 0.5) * 14 * sk, y + l * 0.3, x + (hash(i * 9 + L + 1) - 0.5) * 18 * sk, y + l * 0.7, x + (hash(i * 9 + L + 2) - 0.5) * 10 * sk, y + l); }
      g.strokeStyle = `rgba(${ink},${0.16 * cfg.al})`; g.lineWidth = 1; g.stroke(cun);
      // Mi dots: soft horizontal dabs crowding the tops
      const dots = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < 1100 + L * 300; i++) {
        const x = hash(L * 7919 + i * 3) * W, top2 = rx(x), dep = Math.pow(hash(L * 7919 + i * 3 + 1), 2.2) * (cfg.b * H - top2 + 10), y = top2 + 3 + dep;
        if (cfg.b * H - top2 < H * 0.04 && hash(L * 7919 + i * 3 + 5) < 0.75) continue;
        const r = (2.2 + 3.8 * hash(L * 7919 + i * 3 + 2)) * (0.7 + 0.25 * L) * sk + 0.6, b = dep < 18 ? 2 : dep < 50 ? 1 : 0;
        dots[b].moveTo(x + r, y); dots[b].ellipse(x, y, r, r * 0.42, 0, 0, TAU);
      }
      dots.forEach((p, b) => { g.fillStyle = `rgba(${ink},${[0.08, 0.16, 0.28][b] * cfg.al})`; g.fill(p); });
      // the places checked: wet dark dabs where it rains, a dry fleck where it does not
      const wet = new Path2D(), dry = new Path2D();
      for (const pt of points(E)) {
        if (sumiRow(pt.lat) !== L) continue;
        const x = (0.03 + 0.94 * (pt.lon + 180) / 360) * W, t2 = rx(x), y = t2 + 6 + (0.08 + 0.55 * hash(pt.id * 5 + 1)) * (cfg.b * H - t2);
        if (pt.rain) { const r = (2.4 + 4 * pt.k) * sk + 1; for (let k = 0; k < 3; k++) { const ox = (hash(pt.id * 11 + k) - 0.5) * r * 1.6, oy = (hash(pt.id * 13 + k) - 0.5) * r * 0.5; wet.moveTo(x + ox + r, y + oy); wet.ellipse(x + ox, y + oy, r, r * 0.42, 0, 0, TAU); } }
        else { const r = 2 * sk + 0.8; dry.moveTo(x + r, y); dry.ellipse(x, y, r, r * 0.5, 0, 0, TAU); }
      }
      g.fillStyle = `rgba(${ink},${0.22 * cfg.al + 0.08})`; g.fill(wet);
      g.fillStyle = `rgba(${ink},${0.22 * cfg.al})`; g.fill(dry);
      // little trees along the near ridges
      if (L >= 2) {
        const tr = new Path2D();
        for (let i = 0; i < 160; i++) { const x = hash(L * 313 + i) * W, y = rx(x) + 1, h = (5 + 9 * hash(L * 313 + i + 1)) * sk * (L === 3 ? 1.5 : 1); if (cfg.b * H - y < H * 0.05) continue;
          for (let k = 0; k < 4; k++) { const yy = y - h * k / 4, w = h * 0.32 * (1 - k / 5); tr.moveTo(x + w, yy); tr.ellipse(x, yy, w, w * 0.45, 0, 0, TAU); } }
        g.fillStyle = `rgba(${ink},${0.55 * cfg.al})`; g.fill(tr);
      }
      rows.push({ cv, y0, h: hh, ridge, peaks: peaks.filter(p => p.z), cfg });
    }
    st.rows = rows;
    st.ridgeAt = (L, x) => rows[L].ridge[clamp(Math.round(x / W * (NX - 1)), 0, NX - 1)];
    if (!st.mist) {                                       // mist in the valleys: two bands in front of each row
      st.mist = [];
      for (let L = 0; L < 4; L++) for (let k = 0; k < 2; k++) st.mist.push({ L, x: hash(L * 17 + k * 5) * W * 1.4 - W * 0.2, y: (SUMI_ROWS[L].b + 0.01 + 0.04 * hash(L * 17 + k * 5 + 1)) * H, w: W * (0.7 + 0.4 * hash(L * 17 + k * 5 + 2)), h: H * (0.1 + 0.06 * hash(L * 17 + k * 5 + 3)), vx: 0, sd: L * 3 + k });
    }
  }
  const sumie = {
    name: 'sumie', title: 'Sumi-e', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), dpr = E.dpr, sk = Math.min(W / 1600, H / 900);
      if (st.W !== W || st.H !== H || !st.pN) { st.W = W; st.H = H; sumiSprites(st, W, H, dpr); st.ref = null; st.mist = null; st.blooms = []; st.spat = []; st.puffs = []; st.burst = new Map(); }
      if (st.ref !== E.sites || st.ref2 !== E.pts) sumiRows(st, E, W, H, dpr);
      const day = dayOf(st, E), rows = st.rows;
      const [fl, fb] = flicker(R, T);
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const gust = e * (0.85 + 0.15 * Math.sin(T * 6.1)), wind = wx * gust * 1.1 + dir * storm * (0.5 + 0.35 * vnoise(T * 0.7, 3.3));
      st.slant = (st.slant || 0) + (clamp(wind * 0.9, -1.2, 1.2) - (st.slant || 0)) * (1 - Math.exp(-dt * 7));
      const slant = st.slant + 0.2, amt = (0.03 + 0.97 * (1 - calm)) * (1 + 1.4 * storm);
      const ink = `${Math.round(lerp(14, 22, day))},${Math.round(lerp(13, 19, day))},${Math.round(lerp(14, 18, day))}`;
      // ---- the paper; a storm darkens the sky with a wash
      c.globalCompositeOperation = 'source-over';
      const paper = fade2(st, 'fp', st.pN, st.pD, day);
      if (storm > 0.02) {                                  // the storm's dark sky, kept with the paper while it holds still
        let pw = st.pw; if (!pw || pw.cv.width !== paper.width || pw.cv.height !== paper.height) pw = st.pw = { cv: canvas(paper.width, paper.height), src: null, storm: -1, day: -1 };
        if (pw.src !== paper || Math.abs(pw.storm - storm) > 0.03 || Math.abs(pw.day - day) > 0.02) {
          const g = pw.cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(paper, 0, 0); g.setTransform(paper.width / W, 0, 0, paper.height / H, 0, 0);
          const gr = g.createLinearGradient(0, 0, 0, H * 0.5); gr.addColorStop(0, `rgba(20,20,26,${0.32 * storm})`); gr.addColorStop(1, 'rgba(20,20,26,0)'); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.5);
          pw.src = paper; pw.storm = storm; pw.day = day;
        }
        c.drawImage(pw.cv, 0, 0, W, H);
      } else c.drawImage(paper, 0, 0, W, H);
      // ---- the moon, when it clears (a disc left as paper inside a pale wash)
      const moon = smoothstep(0.35, 0.95, calm) * (1 - storm);
      if (moon > 0.01) {
        const mx = W * 0.8, my = H * 0.17, mr = H * 0.055, gr = c.createRadialGradient(mx, my, mr * 0.98, mx, my, mr * 3.2);
        gr.addColorStop(0, `rgba(60,64,80,${0.2 * moon})`); gr.addColorStop(0.35, `rgba(60,64,80,${0.08 * moon})`); gr.addColorStop(1, 'rgba(60,64,80,0)');
        c.fillStyle = gr; c.beginPath(); c.arc(mx, my, mr * 3.2, 0, TAU); c.fill();
        c.fillStyle = `rgba(255,253,244,${0.85 * moon})`; c.beginPath(); c.arc(mx, my, mr, 0, TAU); c.fill();
      }
      // ---- taps: ink dropped on the paper; on a raining place onto its peak, and its rain pours
      for (const t of tapsOf(R, E).fresh) {
        let x = t.x, y = t.y, big = !t.echo;
        if (t.site != null) { const z = E.sites.find(o => o.id === t.site); if (z) { const L = sumiRow(latOf(z)); x = (0.03 + 0.94 * z.u) * W; y = st.ridgeAt(L, x) + 8 * sk; if (!t.echo) st.burst.set(z.id, T + 3.5); } }
        else if (t.echo) continue;
        if (st.blooms.length < 24) st.blooms.push({ x, y, t: T, r: (big ? 70 : 26) * sk * (0.8 + 0.4 * rnd()), v: Math.floor(rnd() * 2), a: rnd() * TAU, al: big ? 0.6 : 0.3 });
      }
      // ---- the mist moves: a slow drift, the breath drives it across, a storm churns it
      const drift = 6 * sk * (1 + storm * 2);
      for (const m of st.mist) {
        const tv = (drift * (m.sd % 2 ? 1 : -0.6) + wind * 520 * sk * (0.6 + 0.4 * (m.L + 1) / 4)) * (1 - 0.6 * calm);
        m.vx += (tv - m.vx) * (1 - Math.exp(-dt * (Math.abs(tv) > Math.abs(m.vx) ? 4 : 0.8)));
        m.x += m.vx * dt; if (m.x > W + 40) m.x -= W + m.w + 80; if (m.x + m.w < -40) m.x += W + m.w + 80;
      }
      if (gust > 0.25 && T - (st.puffT || 0) > 0.32 && st.puffs.length < 6) {        // the breath blows fresh mist in from its side
        st.puffT = T; const by = (0.45 + 0.35 * clamp(E.my, -1, 1)) * H + (rnd() - 0.5) * H * 0.3;
        st.puffs.push({ x: (0.5 + 0.48 * clamp(E.mx, -1, 1)) * W - W * 0.3, y: by, w: W * (0.5 + 0.3 * rnd()), h: H * (0.12 + 0.1 * rnd()), vx: (Math.abs(wx) > 0.1 ? wx : dir) * (700 + 500 * gust) * sk, t: T });
      }
      const mistTint = () => {
        const key = Math.round(day * 20), c0 = st.mistTint[key];
        if (c0) return c0;
        const cv = canvas(st.mistMask.width, st.mistMask.height), g = cv.getContext('2d');
        g.drawImage(st.mistMask, 0, 0); g.globalCompositeOperation = 'source-in';
        g.fillStyle = `rgb(${mix([196, 189, 172], [246, 241, 230], key / 20)})`; g.fillRect(0, 0, cv.width, cv.height);
        return (st.mistTint[key] = cv);
      };
      const mt = mistTint();
      // ---- each row, far to near: the hills, its clouds and rain, then the mist in front of it
      const rainOf = (pk, L, RP) => {
        const z = pk.z, k = z.k, kind = kindOf(E, z), xs = pk.x * W, top = st.ridgeAt(L, xs);
        const pour = (st.burst.get(z.id) || 0) > T ? 3 : 1;
        const cx = xs + wind * 40 * sk + Math.sin(T * 0.1 + z.id) * 8 * sk, cy = Math.max(H * 0.05, top - (0.07 + 0.09 * k) * H * (L ? 1 : 0.8));
        // the cloud: a wet blot, darker for heavier rain and thunder
        const cs = (70 + 150 * k) * sk * (1 + 0.15 * storm), ca = Math.min(0.75, (0.18 + 0.36 * k + (kind === 3 ? 0.2 : 0)) * (0.2 + 0.8 * amt)) * (1 - 0.85 * calm);
        if (ca > 0.03) { c.globalAlpha = ca; c.drawImage(st.cloud[z.id % 3], cx - cs / 2, cy - cs * 0.3, cs, cs * 0.6); c.globalAlpha = 1; }
        const n = Math.round((4 + 30 * Math.pow(k, 1.2)) * Math.min(1.2, amt) * pour * (kind === 0 ? 2 : 1)), wc = (0.045 + 0.07 * k) * W, fallH = top - cy + 6;
        if (n <= 0 || fallH < 10) return;
        const sweep = kind === 2 ? Math.sin(T * 0.7 + z.id) * wc * 0.7 : 0;
        for (let i = 0; i < n; i++) {
          const h1 = hash(z.id * 97 + i * 3), h2 = hash(z.id * 97 + i * 3 + 1), dur = 0.55 + 0.4 * h2;
          const f = ((T / dur + h1) % 1), len = kind === 0 ? 3 : (0.12 + 0.4 * h2 * h2) * fallH;
          const y0 = cy + (hash(z.id * 97 + i * 3 + 5) - 0.3) * 30 * sk, y = y0 + f * (top - y0 + len) - len, x0 = cx + sweep + (hash(z.id * 97 + i * 3 + 2) - 0.5) * wc;
          const ya = Math.max(y0, y), yb = Math.min(top, y + len); if (yb <= ya) continue;
          const xa = x0 + slant * (ya - cy) * 0.6, xb = x0 + slant * (yb - cy) * 0.6;
          if (kind === 0) { const u = hash(z.id * 97 + i * 3 + 7); RP.stip.rect(lerp(xa, xb, u), lerp(ya, yb, u), 1.6 * sk + 0.6, 1.6 * sk + 0.6); continue; }
          const p = kind === 3 ? RP.heavy : RP.s[Math.floor(h2 * 3)];
          if (h1 < 0.35 && yb - ya > 20) { const ym = (ya + yb) / 2; p.moveTo(xa, ya); p.lineTo(lerp(xa, xb, 0.42), lerp(ya, yb, 0.42)); p.moveTo(lerp(xa, xb, 0.55), lerp(ya, yb, 0.55)); p.lineTo(xb, yb); }   // the dry brush skips
          else { p.moveTo(xa, ya); p.lineTo(xb, yb); }
          if (kind === 3 && f > 0.9 && rnd() < 0.08 && st.spat.length < 140) st.spat.push({ x: xb + (rnd() - 0.5) * 30 * sk, y: yb + (rnd() - 0.3) * 12 * sk, r: (1 + 2.5 * rnd()) * sk + 0.5, t: T });
        }
      };
      const flushRain = RP => {
        c.lineCap = 'butt';
        RP.s.forEach((p, i) => { c.strokeStyle = `rgba(${ink},${[0.18, 0.28, 0.4][i]})`; c.lineWidth = (0.55 + 0.3 * i) * (0.7 + 0.4 * sk); c.stroke(p); });
        c.strokeStyle = `rgba(${ink},0.55)`; c.lineWidth = 1.3 * sk + 0.5; c.stroke(RP.heavy);
        c.fillStyle = `rgba(${ink},0.45)`; c.fill(RP.stip);
      };
      for (let L = 0; L < 4; L++) {
        const r = rows[L];
        c.drawImage(r.cv, 0, r.y0, W, r.h);
        const RP = { s: [new Path2D(), new Path2D(), new Path2D()], heavy: new Path2D(), stip: new Path2D() };
        for (const pk of r.peaks) rainOf(pk, L, RP);
        flushRain(RP);
        for (const m of st.mist) if (m.L === L) { c.globalAlpha = 0.75 + 0.2 * calm; c.drawImage(mt, m.x, m.y - m.h / 2, m.w, m.h); }
        c.globalAlpha = 1;
      }
      // ---- fine rain over everything, slanting with the wind
      const fine = new Path2D(), nf = Math.round((10 + 140 * (1 - calm) + 420 * storm) * W / 1600);
      for (let i = 0; i < nf; i++) {
        const dur = 0.7 + 0.5 * hash(i * 3 + 2), f = (T / dur + hash(i * 3 + 1)) % 1, len = (30 + 60 * hash(i * 3 + 4)) * sk * (1 + storm);
        const y = f * (H + len) - len, x = hash(i * 3 + 3) * (W + 400) - 200 + slant * y * 0.6;
        fine.moveTo(x, y); fine.lineTo(x + slant * len * 0.6, y + len);
      }
      c.strokeStyle = `rgba(${ink},${0.14 + 0.1 * storm})`; c.lineWidth = 0.8 * (0.7 + 0.4 * sk); c.stroke(fine);
      // ---- the river below, its ripples, and a fisherman's boat
      const wv = new Path2D();
      for (let i = 0; i < 26; i++) { const y = H * (0.9 + 0.09 * hash(i * 3 + 1)), x = (hash(i * 3 + 2) * 1.2 - 0.1) * W + Math.sin(T * 0.4 + i) * 6 * sk + wind * 30 * sk, l = (30 + 90 * hash(i * 3 + 3)) * sk;
        wv.moveTo(x, y); wv.quadraticCurveTo(x + l / 2, y - 2 - 3 * gust, x + l, y); }
      c.strokeStyle = `rgba(${ink},0.22)`; c.lineWidth = 1; c.stroke(wv);
      st.bx = (st.bx == null ? 0 : st.bx) + ((wind * 60 * sk) - (st.bx || 0)) * (1 - Math.exp(-dt * 0.8));
      const bx = W * 0.2 + st.bx, by = H * 0.935 + Math.sin(T * 1.1) * 1.5 * sk, bs = 38 * sk + 8;
      c.fillStyle = `rgba(${ink},0.85)`; c.beginPath(); c.moveTo(bx - bs, by - bs * 0.12); c.quadraticCurveTo(bx, by + bs * 0.22, bx + bs * 1.05, by - bs * 0.2); c.quadraticCurveTo(bx, by + bs * 0.05, bx - bs, by - bs * 0.12); c.fill();
      c.beginPath(); c.moveTo(bx + bs * 0.05, by - bs * 0.62); c.lineTo(bx - bs * 0.22, by - bs * 0.42); c.lineTo(bx + bs * 0.32, by - bs * 0.42); c.closePath(); c.fill();     // his hat
      c.fillRect(bx - bs * 0.03, by - bs * 0.42, bs * 0.12, bs * 0.32);
      c.strokeStyle = `rgba(${ink},0.6)`; c.lineWidth = 1; c.beginPath(); c.moveTo(bx + bs * 0.1, by - bs * 0.3); c.lineTo(bx + bs * 1.6, by - bs * 1.1); c.lineTo(bx + bs * 1.62, by + bs * 0.1); c.stroke();
      // ---- ink spattered by the storm and by lightning, drying away
      for (const b of newBolts(R, st, T)) for (let i = 0; i < 18; i++) st.spat.push({ x: (b.u == null ? 0.5 : b.u) * W + (rnd() - 0.5) * 160 * sk, y: H * (0.45 + 0.3 * rnd()), r: (1 + 3.5 * rnd()) * sk + 0.5, t: T });
      let ns = storm * 20 * dt; while (ns > 0) { if (ns < 1 && rnd() > ns) break; ns -= 1; if (st.spat.length < 160) st.spat.push({ x: rnd() * W, y: H * (0.35 + 0.6 * rnd()), r: (0.8 + 2.5 * rnd()) * sk + 0.5, t: T }); }
      st.spat = st.spat.filter(p => T - p.t < 4);
      const sp = new Path2D(); for (const p of st.spat) { const r = p.r * (1 + 0.15 * Math.min(1, (T - p.t) * 4)); sp.moveTo(p.x + r, p.y); sp.arc(p.x, p.y, r, 0, TAU); }
      c.fillStyle = `rgba(${ink},0.55)`; c.fill(sp);
      // ---- drops of ink from taps, spreading into the paper
      st.blooms = st.blooms.filter(b => T - b.t < 9);
      for (const b of st.blooms) {
        const a = T - b.t, r = b.r * (1 - Math.exp(-a * 2.2)) + 2, al = b.al * (1 - smoothstep(3, 9, a));
        c.globalAlpha = al; c.save(); c.translate(b.x, b.y); c.rotate(b.a); c.drawImage(st.blot[b.v], -r, -r, r * 2, r * 2); c.restore();
      }
      c.globalAlpha = 1;
      // ---- the pine in front, swaying; mist blown in by the breath drifting across everything
      const sw = (wind * 0.06 + 0.008 * Math.sin(T * 0.8)) * (1 + storm);
      c.save(); c.translate(0, H * 0.06 + st.pineH * 0.5); c.rotate(sw); c.drawImage(st.pine, 0, -st.pineH * 0.5, st.pineW, st.pineH); c.restore();
      st.puffs = st.puffs.filter(m => T - m.t < 3.2 && m.x < W + 60 && m.x + m.w > -60);
      for (const m of st.puffs) { m.x += m.vx * dt; m.vx *= Math.exp(-dt * 0.5); c.globalAlpha = 0.85 * Math.min(1, (T - m.t) * 5) * (1 - smoothstep(1.8, 3.2, T - m.t)); c.drawImage(mt, m.x, m.y - m.h / 2, m.w, m.h); }
      c.globalAlpha = 1;
      // ---- lightning: one quick dry-brush stroke, and the paper flashes
      if (fl > 0.02 && fb) {
        c.fillStyle = `rgba(255,252,240,${0.4 * fl})`; c.fillRect(0, 0, W, H);
        const sd = fb.seed | 0, p = [new Path2D(), new Path2D()]; let x = (fb.u == null ? 0.5 : fb.u) * W, y = -10; const end = st.ridgeAt(2, x) || H * 0.6;
        const pts = [[x, y]]; let n = 0;
        while (y < end && n < 40) { x += (hash(sd + n * 3) - 0.5) * 60 * sk; y += (24 + 30 * hash(sd + n * 3 + 1)) * sk; pts.push([x, y]); n++; }
        for (let k = 0; k < 2; k++) pts.forEach(([px, py], i) => { if (i && hash(sd + i * 7 + k) < 0.18) return; i ? p[k].lineTo(px + k * 2.5, py + k * 1.5) : p[k].moveTo(px + k * 2.5, py); });
        c.lineCap = 'round'; c.lineJoin = 'round';
        c.strokeStyle = `rgba(${ink},${0.9 * Math.min(1, fl * 1.4)})`; c.lineWidth = 4.5 * sk + 1.5; c.stroke(p[0]);
        c.strokeStyle = `rgba(${ink},${0.5 * Math.min(1, fl * 1.4)})`; c.lineWidth = 1.5 * sk + 0.6; c.stroke(p[1]);
      }
      // ---- the seal
      const ss = Math.round(H * 0.06); c.globalAlpha = 0.92; c.drawImage(st.seal, W * 0.92 - ss, H * 0.07, ss, ss); c.globalAlpha = 1;
    },
  };

  /* ============================================================== 14  Rain Score
     The world's rain written as music on a grand staff. Every raining place is a note that falls onto the
     staff like a raindrop: its pitch is its latitude (the equator is middle C, the north high on the treble
     staff, the south low on the bass), its place in the bar its longitude, its note value how hard it rains
     (light rain a half note, then quarters, eighths and beamed sixteenths for the heaviest), with a brushed
     tail as long as it rings; drizzle is played staccato, showers tremolo, thunderstorms accented. Each of
     the 320 places checked is a faint dot, a silent note. A golden playhead sweeps the bars; each note it
     passes rings out in rings of colour, then evaporates behind it and falls again as a drop before the next
     pass, so the rain keeps rewriting the score. A breath bends the staff and the notes slide and gliss away
     from the side it came from; a storm is fortissimo: tone clusters, scribbles, accents and a racing
     playhead; lightning is a sforzando slash that sets every note ringing. Calm, the notes open into long
     held whole notes under slurs and fermatas. A tap rings the note of the place tapped (or drops a grace
     note where it lands); the wall's own soft notes ring theirs, in time with what it plays. */
  const SCORE_COL = [[110, 214, 236], [128, 162, 255], [196, 140, 255], [255, 190, 80]];
  function scorePaper(W, H, dpr, day) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), sk = Math.min(W / 1600, H / 900);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, W * 0.3, H);
    if (day) { gr.addColorStop(0, '#f6f0e2'); gr.addColorStop(1, '#ebe2cf'); } else { gr.addColorStop(0, '#111a30'); gr.addColorStop(1, '#0a0f20'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    const sp = [new Path2D(), new Path2D()];
    for (let i = 0; i < 14000; i++) sp[i & 1].rect(hash(i * 3 + 1) * W, hash(i * 3 + 2) * H, 1, 1);
    g.fillStyle = day ? 'rgba(120,100,70,0.08)' : 'rgba(150,170,220,0.05)'; g.fill(sp[0]); g.fillStyle = day ? 'rgba(255,255,250,0.4)' : 'rgba(0,0,0,0.25)'; g.fill(sp[1]);
    for (let i = 0; i < 40; i++) { const x = hash(i * 5 + 1) * W, y = hash(i * 5 + 2) * H, r = (60 + 200 * hash(i * 5 + 3)) * sk, q = g.createRadialGradient(x, y, 0, x, y, r);
      q.addColorStop(0, day ? `rgba(150,120,80,${0.03 * hash(i)})` : `rgba(60,80,140,${0.05 * hash(i)})`); q.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = q; g.fillRect(x - r, y - r, 2 * r, 2 * r); }
    gr = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.6);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, day ? 'rgba(100,76,40,0.16)' : 'rgba(0,0,0,0.5)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    return cv;
  }
  function scoreNotes(st, E, L) {
    st.ref = E.sites; st.ref2 = E.pts;
    const notes = E.sites.map(z => {
      const lat = latOf(z), kind = kindOf(E, z), k = z.k;
      return { id: z.id, z, k, kind, p: clamp(Math.round(lat / 5), -13, 15), f: 0.015 + 0.97 * z.u, val: k < 0.3 ? 2 : k < 0.55 ? 4 : k < 0.8 ? 8 : 16, h: hash(z.id * 7 + 3), ring: -9, dx: 0, vx: 0 };
    }).sort((a, b) => a.f - b.f);
    // chords: notes in the same staff that nearly coincide share a stem position; a second step apart sits beside
    for (let i = 1; i < notes.length; i++) { const a = notes[i - 1], b = notes[i]; if ((a.p >= 0) === (b.p >= 0) && (b.f - a.f) * L.w < L.sp * 0.9) { b.f = a.f; if (Math.abs(a.p - b.p) === 1) b.side = 1; } }
    // beams: runs of eighths and sixteenths close together in one bar of one staff
    st.beams = [];
    for (const tr of [true, false]) {
      const ns = notes.filter(n => (n.p >= 0) === tr && n.val >= 8);
      let run = [];
      const flush = () => { if (run.length > 1) st.beams.push(run); else if (run.length) run[0].beam = null; run = []; };
      for (const n of ns) {
        const last = run[run.length - 1];
        if (last && ((n.f - last.f) * L.w > 2.8 * L.sp || Math.abs(n.p - last.p) > 4 || Math.floor(n.f * 4) !== Math.floor(last.f * 4) || run.length >= 3 || n.f === last.f)) flush();
        n.beam = run; run.push(n);
      }
      flush();
    }
    st.notes = notes;
  }
  /* a treble and a bass clef, drawn as strokes (in staff spaces, y down; G line / F line at 0) */
  function clefPaths() {
    const G = new Path2D();
    G.moveTo(0.25, -0.3); G.bezierCurveTo(0.25, -0.8, -0.5, -0.8, -0.5, -0.05); G.bezierCurveTo(-0.55, 0.7, 0.4, 0.95, 0.78, 0.35);
    G.bezierCurveTo(1.08, -0.2, 0.75, -0.95, 0.12, -1.1); G.bezierCurveTo(-0.8, -1.35, -0.85, -2.35, -0.1, -3.0);
    G.bezierCurveTo(0.4, -3.45, 0.6, -4.2, 0.28, -4.45); G.bezierCurveTo(-0.05, -4.6, -0.32, -4.05, -0.26, -3.45); G.lineTo(0.22, 1.7);
    G.bezierCurveTo(0.3, 2.25, 0.0, 2.55, -0.38, 2.32);
    const F = new Path2D();
    F.moveTo(-0.1, 0); F.bezierCurveTo(-0.1, -1.1, 1.45, -1.15, 1.4, 0.15); F.bezierCurveTo(1.35, 1.35, 0.45, 2.3, -0.45, 2.75);
    return { G, F };
  }
  const score = {
    name: 'score', title: 'Rain Score', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), dpr = E.dpr, sk = Math.min(W / 1600, H / 900);
      const sp = H * 0.044, yC = H * 0.5, xs = W * 0.045, x0 = W * 0.14, x1 = W * 0.965, L = { sp, w: x1 - x0 - W * 0.012 };
      if (st.W !== W || st.H !== H || !st.pN) { st.W = W; st.H = H; st.pN = scorePaper(W, H, dpr, false); st.pD = scorePaper(W, H, dpr, true); st.clef = clefPaths(); st.ref = null; st.extra = []; st.spl = []; }
      if (st.ref !== E.sites || st.ref2 !== E.pts) scoreNotes(st, E, L);
      const day = dayOf(st, E), notes = st.notes;
      const INKc = mix([233, 225, 207], [29, 27, 34], day), ink = INKc.join(','), [fl, fb] = flicker(R, T);
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const gust = e * (0.85 + 0.15 * Math.sin(T * 5.7)), bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W;
      // ---- the playhead: slow in the calm, faster in rain, racing in a storm; a breath pushes it on
      const cyc = 1 / (1 / 22 + (1 - calm) * (1 / 14 - 1 / 22) + storm * 0.11 + gust * 0.05);
      st.P = (st.P == null ? (T / 14) % 1 : st.P) + dt / cyc;
      const P = st.P, ph = P % 1, phx = x0 + ph * (x1 - x0);
      // ---- the breath bends the staff: a wave running downwind from where it blows; a storm makes it tremble
      const bend = (x, T2) => {
        const env = Math.exp(-((x - bxs - dir * W * 0.12) ** 2) / (0.09 * W * W));
        return sp * (gust * 0.9 * env * Math.sin((x - bxs) * dir * 0.012 / sk - T2 * 9) + storm * 0.22 * Math.sin(x * 0.05 / sk + T2 * 23) + 0.05 * Math.sin(x * 0.004 + T2 * 0.6));
      };
      const yOf = p => yC - p * sp / 2;
      // ---- paper, and the rain falling across it
      c.globalCompositeOperation = 'source-over';
      c.drawImage(fade2(st, 'fp', st.pN, st.pD, day), 0, 0, W, H);
      const slant = wx * gust * 0.9 + dir * storm * 0.5 + 0.15;
      const rain = new Path2D(), nr = Math.round((14 + 120 * (1 - calm) + 360 * storm) * W / 1600);
      for (let i = 0; i < nr; i++) { const dur = 0.8 + 0.6 * hash(i * 3 + 2), f = (T / dur + hash(i * 3 + 1)) % 1, len = (24 + 50 * hash(i * 3 + 4)) * sk * (1 + storm), y = f * (H + len) - len, x = hash(i * 3 + 3) * (W + 300) - 150 + slant * y * 0.5;
        rain.moveTo(x, y); rain.lineTo(x + slant * len * 0.5, y + len); }
      c.strokeStyle = `rgba(${ink},${0.07 + 0.06 * storm})`; c.lineWidth = 0.8; c.stroke(rain);
      // ---- the playhead's glow
      const pg = c.createLinearGradient(phx - 90 * sk, 0, phx + 14 * sk, 0);
      pg.addColorStop(0, 'rgba(255,196,96,0)'); pg.addColorStop(0.85, `rgba(255,196,96,${0.1 + 0.05 * storm})`); pg.addColorStop(1, 'rgba(255,196,96,0)');
      c.fillStyle = pg; c.fillRect(phx - 90 * sk, yOf(16), 104 * sk, yOf(-14) - yOf(16));
      // ---- the staff: ten lines (they bend), bar lines, the brace, clefs and common time
      const lines = new Path2D(), N = 90;
      for (const p of [2, 4, 6, 8, 10, -2, -4, -6, -8, -10]) for (let i = 0; i <= N; i++) { const x = xs + (x1 - xs) * i / N, y = yOf(p) + bend(x, T); i ? lines.lineTo(x, y) : lines.moveTo(x, y); }
      c.lineCap = 'butt'; c.strokeStyle = `rgba(${ink},${0.42 + 0.1 * day})`; c.lineWidth = Math.max(1, 1.1 * sk); c.stroke(lines);
      const bars = new Path2D();
      for (let b = 1; b <= 4; b++) { const x = b < 4 ? x0 + (x1 - x0) * b / 4 : x1; for (const [pa, pb] of [[10, 2], [-2, -10]]) { bars.moveTo(x, yOf(pa) + bend(x, T)); bars.lineTo(x, yOf(pb) + bend(x, T)); } }
      bars.moveTo(xs, yOf(10) + bend(xs, T)); bars.lineTo(xs, yOf(-10) + bend(xs, T));
      c.lineWidth = Math.max(1, 1.3 * sk); c.stroke(bars);
      c.fillStyle = `rgba(${ink},0.85)`; c.fillRect(x1 + 2.5 * sk, yOf(10) + bend(x1, T), 4 * sk, yOf(-10) - yOf(10));        // the final double bar
      // the brace
      const by0 = yOf(10), by1 = yOf(-10), bm = (by0 + by1) / 2, bxx = xs - 10 * sk;
      c.beginPath(); c.moveTo(bxx, by0); c.bezierCurveTo(bxx - 16 * sk, by0 + 20 * sk, bxx + 6 * sk, bm - 30 * sk, bxx - 12 * sk, bm); c.bezierCurveTo(bxx + 6 * sk, bm + 30 * sk, bxx - 16 * sk, by1 - 20 * sk, bxx, by1);
      c.bezierCurveTo(bxx - 10 * sk, by1 - 24 * sk, bxx + 12 * sk, bm + 26 * sk, bxx - 9 * sk, bm); c.bezierCurveTo(bxx + 12 * sk, bm - 26 * sk, bxx - 10 * sk, by0 + 24 * sk, bxx, by0); c.fill();
      const clefAt = (path, x, y, w) => { c.save(); c.translate(x, y); c.scale(sp, sp); c.lineWidth = w; c.lineCap = 'round'; c.strokeStyle = `rgba(${ink},0.9)`; c.stroke(path); c.restore(); };
      clefAt(st.clef.G, xs + 2.3 * sp, yOf(4) + bend(xs + 2.3 * sp, T), 0.17);
      c.beginPath(); c.arc(xs + 2.3 * sp - 0.38 * sp, yOf(4) + 2.3 * sp, 0.22 * sp, 0, TAU); c.fill();
      clefAt(st.clef.F, xs + 1.8 * sp, yOf(-4) + bend(xs + 1.8 * sp, T), 0.22);
      c.beginPath(); c.arc(xs + 1.7 * sp, yOf(-4) + bend(xs, T), 0.3 * sp, 0, TAU); c.arc(xs + 3.4 * sp, yOf(-3), 0.15 * sp, 0, TAU); c.moveTo(xs + 3.4 * sp + 0.15 * sp, yOf(-5)); c.arc(xs + 3.4 * sp, yOf(-5), 0.15 * sp, 0, TAU); c.fill();
      for (const p of [6, -6]) { const x = xs + 4.6 * sp, y = yOf(p) + bend(x, T); c.strokeStyle = `rgba(${ink},0.9)`; c.lineWidth = 0.28 * sp; c.beginPath(); c.arc(x, y, 0.85 * sp, 0.85, TAU - 0.85); c.stroke(); }   // common time
      // ---- the silent notes: every place checked where it is dry, a faint dot
      const ghost = new Path2D();
      for (const q of points(E)) { if (q.rain) continue; const x = x0 + (0.015 + 0.97 * (q.lon + 180) / 360) * L.w, y = yOf(clamp(Math.round(q.lat / 5), -13, 15)) + bend(x, T), r = sp * 0.12; ghost.moveTo(x + r, y); ghost.arc(x, y, r, 0, TAU); }
      c.fillStyle = `rgba(${ink},0.16)`; c.fill(ghost);
      // ---- taps ring their note; a tap elsewhere drops a grace note where it lands
      for (const t of tapsOf(R, E).fresh) {
        const n = t.site != null ? notes.find(o => o.id === t.site) : null;
        if (n) { n.ring = T; n.big = t.echo ? 0.5 : 1.6; }
        else if (!t.echo && st.extra.length < 12) st.extra.push({ x: clamp(t.x, x0, x1), p: clamp(Math.round((yC - t.y) / (sp / 2)), -13, 15), t: T });
      }
      for (const b of newBolts(R, st, T)) { for (const n of notes) { n.ring = T + Math.abs(n.f - (b.u == null ? 0.5 : b.u)) * 0.6; n.big = 1.2; } st.sfz = { x: x0 + (b.u == null ? 0.5 : b.u) * L.w, t: T, sd: b.seed | 0 }; }
      // ---- the notes
      const heads = new Path2D(), hollow = new Path2D(), stems = new Path2D(), flags = new Path2D(), beamP = new Path2D(), ledg = new Path2D(), arts = new Path2D(), dots = new Path2D(), slurs = new Path2D();
      const tails = [new Path2D(), new Path2D(), new Path2D(), new Path2D()], lit = [new Path2D(), new Path2D(), new Path2D(), new Path2D()], rings = [[], [], [], []];
      const drops = new Path2D(), hr = sp * 0.6, hv = sp * 0.43, rot = -0.35, whole = smoothstep(0.45, 0.9, calm);
      const pos = [];
      for (const n of notes) {
        // played when the playhead passes; it evaporates some way behind it and falls again as a drop
        const local = (((P - n.f) % 1) + 1) % 1, g0 = 0.42 + 0.22 * n.h, gone = local > g0 && local < g0 + 0.16;
        if (local < (st.lastLocal && st.lastLocal.get(n.id)) && T - n.ring > 0.3) { n.ring = T; n.big = 1; }
        (st.lastLocal || (st.lastLocal = new Map())).set(n.id, local);
        let x = x0 + n.f * L.w, y = yOf(n.p);
        // the breath pushes the notes downwind (they spring back); the staff carries them up and down
        const env = Math.exp(-((x - bxs) ** 2) / (0.12 * W * W));
        n.vx += ((dir * gust * env * 0.05 * W + storm * 6 * sk * Math.sin(T * 13 + n.h * 40)) - n.dx) * 30 * dt - n.vx * 7 * dt; n.dx += n.vx * dt;
        const x2 = x + n.dx + (n.side ? hr * 2.05 : 0), y2 = y + bend(x2, T);
        if (Math.abs(n.dx) > sp * 0.6) { const yy = y + bend(x, T); slurs.moveTo(x, yy); for (let k = 1; k <= 8; k++) { const t = k / 8; slurs.lineTo(lerp(x, x2, t), lerp(yy, y2, t) + Math.sin(t * Math.PI * 4) * sp * 0.25 * (1 - t)); } }   // a glissando where it was pushed from
        let a = 1, fall = -1;
        if (gone) { const u = (local - g0) / 0.16; if (u < 0.35) a = 1 - u / 0.35; else { a = 0; fall = (u - 0.35) / 0.65; } }
        if (fall >= 0) { const yy = lerp(-30, y2, fall * fall); drops.moveTo(x2 + sp * 0.18, yy); drops.arc(x2, yy, sp * 0.18, 0, Math.PI); drops.lineTo(x2, yy - sp * 0.55); drops.closePath(); pos.push(null); continue; }
        if (!gone && local < g0 + 0.2 && local > g0 + 0.16 - 0.001 && !n.landed) { n.landed = true; st.spl.push({ x: x2, y: y2, t: T }); } if (local < g0) n.landed = false;
        pos.push([x2, y2]);
        // ledger lines above and below the staves (and middle C)
        const lp = []; if (n.p === 0 || n.p === 1 || n.p === -1) lp.push(0); for (let q = 12; q <= n.p; q += 2) lp.push(q); for (let q = -12; q >= n.p; q -= 2) lp.push(q);
        for (const q of lp) if (n.p !== 1 && n.p !== -1 || q === 0 && Math.abs(n.p) === 0) { const yy = yOf(q) + bend(x2, T); ledg.moveTo(x2 - hr * 1.6, yy); ledg.lineTo(x2 + hr * 1.6, yy); }
        // the tail: as long as the note rings, as thick as it is loud; it lights up while it sounds
        const ra = T - n.ring, ringing = ra >= 0 && ra < 2.6, tl = (1.2 + 6 * n.k) * sp * (1 + 0.6 * whole), tw = (0.12 + 0.35 * n.k) * sp;
        const tp = ringing ? lit[n.kind] : tails[n.kind], bendT = dir * gust * env * sp * 1.5;
        if (a > 0.3) { tp.moveTo(x2 + hr * 0.7, y2 - tw * 0.5); tp.quadraticCurveTo(x2 + tl * 0.5, y2 - tw * 0.4 + bendT, x2 + tl, y2 + bendT * 1.5); tp.quadraticCurveTo(x2 + tl * 0.5, y2 + tw * 0.4 + bendT, x2 + hr * 0.7, y2 + tw * 0.5); }
        if (ringing) rings[n.kind].push([x2, y2, ra, n.big || 1]);
        // head, stem, flags, articulation
        const open = n.val === 2 || whole > 0.5, up = n.p >= 0 ? n.p < 6 : n.p < -6;
        const hp = open ? hollow : heads;
        if (a > 0.05) { hp.moveTo(x2 + hr, y2); hp.ellipse(x2, y2, hr, hv, rot, 0, TAU); }
        const sa = a * (1 - whole);
        n.sx = up ? x2 + hr * 0.92 : x2 - hr * 0.92; n.sy = y2 + (up ? -0.15 : 0.15) * sp; n.up = up; n.a = sa;
        if (sa > 0.05 && !(n.beam && n.beam.length > 1)) {
          stems.moveTo(n.sx, n.sy); stems.lineTo(n.sx, y2 + (up ? -3.4 : 3.4) * sp);
          for (let k = 0; k < (n.val === 16 ? 2 : n.val === 8 ? 1 : 0); k++) { const fy = y2 + (up ? -3.4 + k * 0.8 : 3.4 - k * 0.8) * sp, d = up ? 1 : -1;
            flags.moveTo(n.sx, fy); flags.bezierCurveTo(n.sx + sp * 0.15, fy + d * sp * 0.7, n.sx + sp * 1.1, fy + d * sp * 0.9, n.sx + sp * 0.8, fy + d * sp * 1.9); }
        }
        if (a > 0.3) {
          const ay = y2 + (up ? 1 : -1) * sp * 1.1;
          if (n.kind === 0) { dots.moveTo(x2 + sp * 0.16, ay); dots.arc(x2, ay, sp * 0.16, 0, TAU); }                    // drizzle: staccato
          if (n.kind === 3 || storm > 0.5) { const ay2 = y2 + (up ? 1.3 : -1.3) * sp; arts.moveTo(x2 - sp * 0.6, ay2 - sp * 0.3); arts.lineTo(x2 + sp * 0.6, ay2); arts.lineTo(x2 - sp * 0.6, ay2 + sp * 0.3); }   // accents
          if (n.kind === 2 && sa > 0.05) for (let k = 0; k < 3; k++) { const ty = y2 + (up ? -1.6 - k * 0.5 : 1.6 + k * 0.5) * sp; arts.moveTo(n.sx - sp * 0.5, ty + sp * 0.25); arts.lineTo(n.sx + sp * 0.5, ty - sp * 0.25); }   // showers: tremolo
          if (whole > 0.3 && n.h < 0.28) { const fy = y2 - 2.2 * sp; arts.moveTo(x2 - sp * 0.8, fy); arts.quadraticCurveTo(x2, fy - sp * 1.2, x2 + sp * 0.8, fy); dots.moveTo(x2 + sp * 0.13, fy - sp * 0.2); dots.arc(x2, fy - sp * 0.2, sp * 0.13, 0, TAU); }   // fermata
        }
      }
      // beams join the short notes close together (their stems meet the beam)
      for (const g of st.beams) {
        if (g.some(n => !(n.a > 0.05))) continue;
        const up = g.filter(n => n.up).length * 2 >= g.length, f0 = g[0], f1 = g[g.length - 1];
        let ya = Math.min(...g.map(n => n.sy)), yb = ya;
        if (up) { ya = f0.sy - 3.3 * sp; yb = f1.sy - 3.3 * sp; const top = Math.min(...g.map(n => n.sy)) - 2.6 * sp; const m = Math.min(ya, yb, top); ya = Math.min(ya, m + sp * 0.6); yb = Math.min(yb, m + sp * 0.6); }
        else { ya = f0.sy + 3.3 * sp; yb = f1.sy + 3.3 * sp; const bot = Math.max(...g.map(n => n.sy)) + 2.6 * sp; const m = Math.max(ya, yb, bot); ya = Math.max(ya, m - sp * 0.6); yb = Math.max(yb, m - sp * 0.6); }
        const xa = f0.sx, xb = f1.sx, mid = (ya + yb) / 2, sl = clamp(yb - ya, -0.25 * (xb - xa), 0.25 * (xb - xa)); ya = mid - sl / 2; yb = mid + sl / 2;
        const by = x => lerp(ya, yb, (x - xa) / ((xb - xa) || 1));
        for (const n of g) { stems.moveTo(n.sx, n.sy); stems.lineTo(n.sx, by(n.sx)); }
        for (let k = 0; k < (g.some(n => n.val === 16) ? 2 : 1); k++) { const o = (up ? 1 : -1) * k * sp * 0.75, t = sp * 0.24;
          beamP.moveTo(xa, ya + o - t); beamP.lineTo(xb, yb + o - t); beamP.lineTo(xb, yb + o + t); beamP.lineTo(xa, ya + o + t); beamP.lineTo(xa, ya + o - t); }
      }
      // calm: long slurs over the held notes, staff by staff
      if (whole > 0.05) for (const tr of [true, false]) {
        let prev = null;
        notes.forEach((n, i) => { if ((n.p >= 0) !== tr || !pos[i]) return; const [x, y] = pos[i];
          if (prev && x - prev[0] > sp * 2 && x - prev[0] < W * 0.2) { const yy = Math.min(prev[1], y) - sp * (1.4 + 0.02 * (x - prev[0]) / sk); slurs.moveTo(prev[0], prev[1] - sp * 0.8); slurs.quadraticCurveTo((prev[0] + x) / 2, yy, x, y - sp * 0.8); }
          prev = [x, y]; });
      }
      // grace notes dropped by taps
      st.extra = st.extra.filter(g => T - g.t < 7);
      for (const g of st.extra) { const a = T - g.t, y = yOf(g.p) + bend(g.x, T), yy = a < 0.4 ? lerp(-20, y, (a / 0.4) ** 2) : y; if (a < 0.4) continue; heads.moveTo(g.x + hr * 0.7, yy); heads.ellipse(g.x, yy, hr * 0.7, hv * 0.7, rot, 0, TAU);
        stems.moveTo(g.x + hr * 0.62, yy); stems.lineTo(g.x + hr * 0.62, yy - 2.6 * sp); arts.moveTo(g.x - sp * 0.2, yy - sp * 1.2); arts.lineTo(g.x + sp * 1.3, yy - sp * 2.2);
        if (!g.rang) { g.rang = true; st.spl.push({ x: g.x, y, t: T, big: 1 }); } }
      // ---- paint: tails (lit ones in colour), rings, then the ink
      c.globalCompositeOperation = 'source-over';
      for (let k = 0; k < 4; k++) {
        c.fillStyle = `rgba(${ink},${0.1 + 0.06 * day})`; c.fill(tails[k]);
        c.fillStyle = `rgba(${SCORE_COL[k]},${0.65 - 0.15 * day})`; c.fill(lit[k]);
      }
      for (let k = 0; k < 4; k++) {
        const P1 = new Path2D(), P2 = new Path2D();
        for (const [x, y, ra, big] of rings[k]) { if (ra > 1.8) continue; for (let j = 0; j < 2; j++) { const r = sp * (0.9 + (ra - j * 0.25) * 2.4 * big); if (r < sp * 0.9) continue; const p = ra < 0.8 ? P1 : P2; p.moveTo(x + r, y); p.ellipse(x, y, r, r * 0.42, 0, 0, TAU); } }
        const al = 0.55 - 0.2 * day;
        c.lineWidth = Math.max(1, 1.4 * sk); c.strokeStyle = `rgba(${SCORE_COL[k]},${al})`; c.stroke(P1);
        c.lineWidth = Math.max(0.8, 0.9 * sk); c.strokeStyle = `rgba(${SCORE_COL[k]},${al * 0.5})`; c.stroke(P2);
      }
      // ringing heads glow in their colour
      notes.forEach((n, i) => { const ra = T - n.ring; if (ra < 0 || ra > 1.2 || !pos[i]) return; const z = sp * (3 + 3 * (n.big || 1)) * (1 - ra / 1.4); c.globalAlpha = (1 - ra / 1.2) * (0.7 - 0.3 * day); c.drawImage(glow(SCORE_COL[n.kind].join(','), 64, 0.3), pos[i][0] - z / 2, pos[i][1] - z / 2, z, z); });
      c.globalAlpha = 1;
      // splashes where the drops land
      st.spl = st.spl.filter(q => T - q.t < 0.6);
      const sp2 = new Path2D();
      for (const q of st.spl) { const a = T - q.t; for (let k = 0; k < 7; k++) { const an = -Math.PI * (0.1 + 0.8 * k / 6), r = sp * (0.4 + a * 4); sp2.rect(q.x + Math.cos(an) * r, q.y + Math.sin(an) * r * 0.8 + a * a * sp * 6, 1.6 * sk + 0.6, 1.6 * sk + 0.6); } }
      c.fillStyle = `rgba(${ink},0.7)`; c.fill(sp2);
      c.lineCap = 'butt';
      c.strokeStyle = `rgba(${ink},0.55)`; c.lineWidth = Math.max(1, 1.2 * sk); c.stroke(ledg);
      c.strokeStyle = `rgba(${ink},0.85)`; c.lineWidth = Math.max(1, 1.3 * sk); c.stroke(stems);
      c.fillStyle = `rgba(${ink},0.92)`; c.fill(heads); c.fill(beamP); c.fill(dots); c.fill(drops);
      c.lineCap = 'round'; c.lineWidth = sp * 0.2; c.stroke(flags); c.lineCap = 'butt';
      c.lineWidth = sp * 0.17; c.stroke(hollow);
      c.lineWidth = Math.max(1.2, 1.6 * sk); c.lineJoin = 'round'; c.stroke(arts);
      c.strokeStyle = `rgba(${ink},0.6)`; c.lineWidth = Math.max(1, 1.3 * sk); c.stroke(slurs);
      // ---- dynamics: hairpins under the bass from bar to bar, louder where it rains harder
      const loud = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
      for (const n of notes) { const b = clamp(Math.floor(n.f * 4), 0, 3); loud[b] += n.k; cnt[b]++; }
      const hy = yOf(-13.5), hp2 = new Path2D();
      for (let b = 0; b < 3; b++) {
        const la = cnt[b] ? loud[b] / cnt[b] + cnt[b] * 0.02 : 0, lb = cnt[b + 1] ? loud[b + 1] / cnt[b + 1] + cnt[b + 1] * 0.02 : 0, xa = x0 + L.w * (b + 0.32) / 4, xb = x0 + L.w * (b + 0.95) / 4, o = sp * 0.5;
        if (Math.abs(la - lb) < 0.03) continue;
        if (lb > la) { hp2.moveTo(xb, hy - o); hp2.lineTo(xa, hy); hp2.lineTo(xb, hy + o); } else { hp2.moveTo(xa, hy - o); hp2.lineTo(xb, hy); hp2.lineTo(xa, hy + o); }
      }
      c.strokeStyle = `rgba(${ink},0.55)`; c.lineWidth = Math.max(1, 1.2 * sk); c.stroke(hp2);
      c.font = `italic 600 ${Math.round(sp * 1.25)}px "Cormorant Garamond", Georgia, serif`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = `rgba(${ink},0.75)`;
      for (let b = 0; b < 4; b++) { const la = cnt[b] ? loud[b] / cnt[b] : 0, m = cnt[b] ? (la + cnt[b] * 0.015 + storm * 0.6 - calm * 0.3) : -1; c.fillText(m < 0 ? '' : m < 0.35 ? 'pp' : m < 0.5 ? 'p' : m < 0.65 ? 'mp' : m < 0.8 ? 'mf' : m < 1 ? 'f' : 'ff', x0 + L.w * (b + 0.12) / 4, hy); }
      // ---- the storm: fortissimo scribbles and tone clusters by the heavy notes
      if (storm > 0.08) {
        if (!st.scrT || T - st.scrT > 0.09) {
          st.scrT = T; const scr = st.scr = new Path2D(), cl = st.cl = new Path2D();
          notes.forEach((n, i) => { if (!pos[i] || n.k < 0.55 - 0.3 * storm || rnd() > storm) return; const [x, y] = pos[i];
            if (rnd() < 0.5) { const hh = sp * (1 + 2.5 * n.k); cl.rect(x - hr * 0.5, y - hh, hr, hh * 2); }
            else { scr.moveTo(x, y); for (let k = 0; k < 7; k++) scr.lineTo(x + (rnd() - 0.3) * sp * 4 * storm, y + (rnd() - 0.5) * sp * 5 * storm); } });
        }
        c.globalAlpha = Math.min(1, storm * 1.3); c.fillStyle = `rgba(${ink},0.85)`; c.fill(st.cl); c.strokeStyle = `rgba(${ink},0.5)`; c.lineWidth = Math.max(1, 1.1 * sk); c.stroke(st.scr); c.globalAlpha = 1;
      }
      // ---- the playhead itself, and lightning as a sforzando slash
      c.strokeStyle = `rgba(255,206,120,${0.75 + 0.2 * storm})`; c.lineWidth = Math.max(1.2, 1.8 * sk);
      c.beginPath(); c.moveTo(phx, yOf(15)); c.lineTo(phx, yOf(-14)); c.stroke();
      if (st.sfz && T - st.sfz.t < 1.2) {
        const a = 1 - (T - st.sfz.t) / 1.2, p = new Path2D(); let x = st.sfz.x, y = yOf(17);
        p.moveTo(x, y); for (let k = 0; y < yOf(-15); k++) { x += (hash(st.sfz.sd + k) - 0.5) * sp * 2.4; y += sp * (0.9 + 0.8 * hash(st.sfz.sd + k + 50)); p.lineTo(x, y); }
        c.lineJoin = 'miter'; c.strokeStyle = `rgba(255,214,120,${a})`; c.lineWidth = sp * 0.3 * a + 1; c.stroke(p);
        c.fillStyle = `rgba(255,224,150,${0.18 * fl})`; c.fillRect(0, 0, W, H);
      }
    },
  };

  /* ============================================================== 15  Splash
     Rain in high-speed macro photography: drops falling onto a dark glossy pool in slow motion, each one a
     crown splash. Every raining place is a spot on the pool, in perspective (east-west across, north far
     away and south close by), dropping again and again: heavier rain = more often, a bigger crown and a
     taller jet; drizzle only dimples the surface, showers fall in pairs, thunderstorms throw huge crowns
     and spray. The liquid takes the colour of the latitude (coral and amber in the tropics, green and
     teal in the middle latitudes, violet toward the poles). The places checked where it is dry are small
     beads resting on the surface. A breath is a gust of air across the set: the crowns lean away from the
     side it came from, their droplets are torn off downwind as spray and cat's-paws race over the pool; a
     storm speeds the film up and fills it with splashes; lightning is the photographer's flash: the picture
     freezes for an instant in hard white light. Calm, the studio turns high-key white and the film runs
     slower still, a few perfect crowns at a time. A tap drops a drop where it lands (on a raining place,
     a big one there). */
  const SPL_N = 14;
  function splashBg(st, W, H, dpr, day, E) {
    const cv = canvas(W * dpr, H * dpr), g = cv.getContext('2d'), hy = st.hy;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let gr = g.createLinearGradient(0, 0, 0, H);
    if (day) { gr.addColorStop(0, '#f4f4f6'); gr.addColorStop(0.32, '#e8e9ee'); gr.addColorStop(0.36, '#d4d6de'); gr.addColorStop(1, '#bcbfca'); }
    else { gr.addColorStop(0, '#050509'); gr.addColorStop(0.3, '#0b0b14'); gr.addColorStop(0.34, '#06060b'); gr.addColorStop(1, '#020204'); }
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    // the lights behind the set, and their long reflection in the pool
    for (const [x, col, a] of day ? [[0.3, '255,255,255', 0.7], [0.75, '255,250,240', 0.5]] : [[0.22, '220,60,170', 0.42], [0.78, '40,170,240', 0.42], [0.5, '255,210,160', 0.18]]) {
      let q = g.createRadialGradient(x * W, hy, 0, x * W, hy, W * 0.38); q.addColorStop(0, `rgba(${col},${a})`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.fillRect(0, 0, W, H);
      g.save(); g.translate(x * W, hy); g.scale(1, 0.18);
      q = g.createRadialGradient(0, 0, 0, 0, 0, W * 0.32); q.addColorStop(0, `rgba(${col},${a * 0.9})`); q.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = q; g.fillRect(-W, 0, 2 * W, H * 5); g.restore();
    }
    g.fillStyle = day ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.1)'; g.fillRect(0, hy - 0.5, W, 1);
    // the places checked where it is dry: small beads resting on the surface
    const P = st.P, p = [0, 0, 0], beads = [];
    for (const q of points(E)) if (!q.rain) {
      const Z = 1 / lerp(1 / 4.8, 1 / 1.15, clamp((80 - q.lat) / 140, 0, 1)), X = ((q.lon + 180) / 360 - 0.5) * 0.98 * W * Z / st.f;
      P(X, 0, Z, p); beads.push([p[0], p[1], p[2]]);
    }
    for (const [x, y, k] of beads) {
      const r = Math.max(0.7, 0.004 * k);
      g.fillStyle = day ? 'rgba(90,96,120,0.16)' : 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(x, y + r * 0.3, r * 1.4, r * 0.45, 0, 0, TAU); g.fill();
      g.fillStyle = day ? 'rgba(255,255,255,0.75)' : 'rgba(210,220,250,0.32)'; g.beginPath(); g.ellipse(x - r * 0.2, y - r * 0.2, r * 0.6, r * 0.35, 0, 0, TAU); g.fill();
    }
    gr = g.createRadialGradient(W / 2, H * 0.6, Math.min(W, H) * 0.4, W / 2, H * 0.6, Math.hypot(W, H) * 0.65);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, day ? 'rgba(60,64,80,0.25)' : 'rgba(0,0,0,0.6)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    return cv;
  }
  const _spheres = new Map();
  function sphere(rgb) {                            // a lit drop of liquid, one per colour
    const key = rgb.join(','); let s = _spheres.get(key); if (s) return s;
    s = canvas(64, 64); const g = s.getContext('2d');
    let q = g.createRadialGradient(26, 24, 2, 32, 32, 31);
    q.addColorStop(0, `rgba(${mix(rgb, [255, 255, 255], 0.55)},1)`); q.addColorStop(0.45, `rgba(${rgb},0.95)`); q.addColorStop(0.85, `rgba(${mix(rgb, [0, 0, 0], 0.45)},0.95)`); q.addColorStop(1, `rgba(${mix(rgb, [0, 0, 0], 0.6)},0)`);
    g.fillStyle = q; g.beginPath(); g.arc(32, 32, 31, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.ellipse(23, 20, 7, 4.5, -0.6, 0, TAU); g.fill();
    g.fillStyle = `rgba(${mix(rgb, [255, 255, 255], 0.7)},0.6)`; g.beginPath(); g.ellipse(38, 46, 9, 3, 0.3, 0, TAU); g.fill();
    _spheres.set(key, s); return s;
  }
  const splash = {
    name: 'splash', title: 'Splash', dark: true, bolts: false,
    draw(R, c, E) {
      const { T, dt, W, H, s, lw, st, storm, e } = E, calm = calmOf(E), wx = windX(E), wy = windY(E), dpr = E.dpr;
      if (st.W !== W || st.H !== H || !st.P) {
        st.W = W; st.H = H; st.hy = H * 0.3; st.f = W * 0.9; const f = st.f, hc = (H * 1.03 - st.hy) / f, hy = st.hy;
        st.hc = hc;
        st.P = (X, Y, Z, out) => { const k = f / Z; out[0] = W / 2 + X * k; out[1] = hy + (hc - Y) * k; out[2] = k; return out; };
        st.ev = []; st.clk = 0; st.bgN = null; st.ref2 = null;
      }
      if (st.ref2 !== E.pts || !st.bgN) { st.ref2 = E.pts; st.bgN = splashBg(st, W, H, dpr, false, E); st.bgD = splashBg(st, W, H, dpr, true, E); }
      const day = dayOf(st, E), P = st.P, hc = st.hc, p = [0, 0, 0], p2 = [0, 0, 0];
      const [fl] = flicker(R, T);
      // ---- the film runs slow; faster in a storm; a lightning flash freezes it for an instant
      for (const b of newBolts(R, st, T)) st.freeze = T + 0.28;
      const frozen = st.freeze > T;
      const rho = frozen ? 0 : (0.3 + 0.32 * (1 - calm) + 0.75 * storm + 0.2 * e);
      st.clk += dt * rho; const clk = st.clk;
      const dir = Math.abs(wx) > 0.12 ? Math.sign(wx) : (st.dir || 1); st.dir = dir;
      const gust = e * (0.85 + 0.15 * Math.sin(T * 6.3)), bxs = (0.5 + 0.45 * clamp(E.mx, -1, 1)) * W;
      const windAt = x => (wx * gust * (0.35 + 0.65 * Math.exp(-((x - bxs) ** 2) / (0.15 * W * W))) + dir * storm * (0.45 + 0.4 * vnoise(T * 0.9, x * 0.003)));
      // ---- drops: every raining place drops again and again (on the film's clock)
      const placeOf = z => { const Z = 1 / lerp(1 / 4.8, 1 / 1.55, southOf(z)); return [(z.u - 0.5) * 0.92 * W * Z / st.f, Z]; };
      const spawn = (X, Z, k, kind, col, big, lead) => {
        if (st.ev.length > 70) return;
        st.ev.push({ X, Z, k: Math.min(1.4, k * big), kind, col, t0: clk + (lead == null ? 0.5 : lead), sd: rnd() * 1e5 | 0, n: SPL_N + Math.round(8 * k) });
      };
      const amt = (0.08 + 0.92 * (1 - calm)) * (1 + 2.2 * storm);
      const cols = st.cols || (st.cols = new Map());
      for (const z of E.sites) {
        let col = cols.get(z.id); if (!col) { const [h] = latColor(latOf(z)); col = hsl2rgb(h, 88, 56).split(',').map(Number); cols.set(z.id, col); }
        const kind = kindOf(E, z);
        let m = (0.07 + 0.3 * z.k) * amt * dt * rho;
        while (m > 0) { if (m < 1 && rnd() > m) break; m -= 1; const [X, Z] = placeOf(z);
          spawn(X + (rnd() - 0.5) * 0.04, Z + (rnd() - 0.5) * 0.08, z.k, kind, col, 1);
          if (kind === 2) spawn(X + (rnd() - 0.5) * 0.12, Z + (rnd() - 0.5) * 0.15, z.k * 0.7, kind, col, 1, 0.75 + 0.3 * rnd()); }
      }
      if (!E.sites.length && st.ev.filter(v => clk - v.t0 < 2.4).length < 2) spawn((rnd() - 0.5) * 0.8 * 2.5 * W / st.f, 2.5 + rnd(), 0.5, 1, [214, 220, 236], 1);   // no data yet: a few plain drops
      if (E.sites.length && st.ev.filter(v => clk - v.t0 < 2.4).length < 3) { const z = E.sites[Math.floor(rnd() * E.sites.length)], [X, Z] = placeOf(z); spawn(X, Z, Math.max(0.5, z.k), kindOf(E, z), cols.get(z.id) || [200, 210, 240], 1); }
      for (const t of tapsOf(R, E).fresh) {
        const z = t.site != null ? E.sites.find(o => o.id === t.site) : null;
        if (z) { const [X, Z] = placeOf(z); spawn(X, Z, Math.max(0.7, z.k), Math.max(1, kindOf(E, z)), cols.get(z.id) || [220, 225, 240], t.echo ? 1 : 1.5, 0.3); }
        else if (!t.echo && t.y > st.hy + 10) { const Z = Math.min(5, st.f * hc / (t.y - st.hy)), X = (t.x - W / 2) * Z / st.f; spawn(X, Z, 1, 1, [236, 240, 250], 1.4, 0.3); }
      }
      st.ev = st.ev.filter(v => clk - v.t0 < 3.6);
      // ---- draw: the studio and the pool
      c.globalCompositeOperation = 'source-over';
      c.drawImage(fade2(st, 'fb', st.bgN, st.bgD, day), 0, 0, W, H);
      const ev = st.ev.slice().sort((a, b) => b.Z - a.Z);
      // ripples on the surface, from every impact
      const rip = [new Path2D(), new Path2D()];
      for (const v of ev) {
        const a = clk - v.t0; if (a < 0) continue;
        P(v.X, 0, v.Z, p); const k = p[2], q = hc / v.Z;
        for (let j = 0; j < 2; j++) { const r = (0.03 + 0.12 * (a - j * 0.35)) * (0.6 + 0.6 * v.k) * k; if (r < 2) continue; const al = 1 - a / 3.6;
          rip[al > 0.5 ? 1 : 0].moveTo(p[0] + r, p[1]); rip[al > 0.5 ? 1 : 0].ellipse(p[0], p[1], r, r * q, 0, 0, TAU); }
      }
      const rc = day > 0.5 ? '60,64,84' : '200,214,255';
      c.lineWidth = lw * 0.6; c.strokeStyle = `rgba(${rc},0.1)`; c.stroke(rip[0]); c.strokeStyle = `rgba(${rc},0.22)`; c.stroke(rip[1]);
      // cat's-paws: the breath ruffling the pool, racing downwind
      if (gust > 0.05 || storm > 0.1) {
        const cp = new Path2D(), n = Math.round((gust * 160 + storm * 90) * W / 1600);
        for (let i = 0; i < n; i++) {
          const ph = (T * (0.9 + 0.5 * hash(i * 3 + 1)) + hash(i * 3 + 2)) % 1, Z = 1.1 + 3.5 * hash(i * 3 + 3) ** 1.4;
          const X0 = ((bxs - W / 2) / st.f) * Z, X = X0 + dir * ph * 1.6 * Z * 0.5 + (hash(i * 3 + 4) - 0.5) * 0.4 * Z;
          P(X, 0, Z, p); const l = (0.05 + 0.08 * hash(i * 3 + 5)) * p[2];
          cp.moveTo(p[0] - l, p[1]); cp.lineTo(p[0] + l, p[1]);
        }
        c.strokeStyle = `rgba(${day > 0.5 ? '255,255,255' : '190,210,255'},${0.18 * Math.min(1, gust + storm)})`; c.lineWidth = lw * 0.7; c.stroke(cp);
      }
      // ---- each splash, far ones first: the falling drop, the crown, the jet and the droplets
      for (const v of ev) {
        const a = clk - v.t0, k = v.k, col = v.col, sph = sphere(col);
        P(v.X, 0, v.Z, p); const bx = p[0], by = p[1], K = p[2], q = hc / v.Z;
        if (bx < -200 || bx > W + 200) continue;
        const lean = windAt(bx) * 0.9, rd = (0.006 + 0.006 * k) * K;
        if (a < 0) {                                         // falling: a stretched drop with its reflection below
          const yw = 1.4 * (a / 0.5) ** 2, x = bx - lean * yw * K * 0.25, y = by - yw * K, st2 = 1.12 + 0.25 * Math.min(1, -a * 3);
          if (a > -0.5) { c.globalAlpha = 0.95; c.drawImage(sph, x - rd, y - rd * st2, rd * 2, rd * 2 * st2); c.globalAlpha = 0.18; c.drawImage(sph, x - rd, by + (by - y) * 0.6 - rd, rd * 2, rd * 2); c.globalAlpha = 1; }
          continue;
        }
        const big = v.kind === 3 ? 1.5 : v.kind === 0 ? 0.35 : 1;
        // the crown: a thin wall rising round the impact and falling back, its rim breaking into spikes
        if (v.kind !== 0 && a < 1.5) {
          const grow = 1 - Math.exp(-a * 5), r = (0.035 + 0.05 * k) * big * (0.4 + 0.6 * grow), h = r * (0.75 + 0.35 * hash(v.sd)) * Math.pow(Math.sin(Math.PI * Math.min(1, a / 1.5)), 0.6);
          const rx = r * K * 0.85, ry = rx * q, top = h * K, tr = r * K * 1.4, tx = bx + lean * top * 0.7, ty = by - top, mr = r * K * 0.95, my = by - top * 0.55, mx = bx + lean * top * 0.3;
          const wall = (from, to) => {                     // a band from the base ellipse up to the flared rim, its sides curving out
            const pp = new Path2D(), N = 14;
            for (let i = 0; i <= N; i++) { const t = from + (to - from) * i / N; i ? pp.lineTo(bx + Math.cos(t) * rx, by + Math.sin(t) * ry) : pp.moveTo(bx + Math.cos(t) * rx, by + Math.sin(t) * ry); }
            pp.quadraticCurveTo(mx + Math.cos(to) * mr * 1.02, my + Math.sin(to) * mr * q, tx + Math.cos(to) * tr, ty + Math.sin(to) * tr * q);
            for (let i = N; i >= 0; i--) { const t = from + (to - from) * i / N; pp.lineTo(tx + Math.cos(t) * tr, ty + Math.sin(t) * tr * q); }
            pp.quadraticCurveTo(mx + Math.cos(from) * mr * 1.02, my + Math.sin(from) * mr * q, bx + Math.cos(from) * rx, by + Math.sin(from) * ry); return pp; };
          c.fillStyle = `rgba(${mix(col, [0, 0, 0], 0.3)},0.32)`; c.fill(wall(Math.PI, TAU));          // the far side, seen through the near one
          const gr = c.createLinearGradient(bx - tr, 0, bx + tr, 0);                                    // glassy: bright and dense at the edges, thin in the middle
          gr.addColorStop(0, `rgba(${mix(col, [255, 255, 255], 0.35)},0.92)`); gr.addColorStop(0.16, `rgba(${col},0.55)`); gr.addColorStop(0.3, `rgba(${mix(col, [255, 255, 255], 0.55)},0.6)`);
          gr.addColorStop(0.42, `rgba(${col},0.25)`); gr.addColorStop(0.75, `rgba(${col},0.32)`); gr.addColorStop(1, `rgba(${mix(col, [0, 0, 0], 0.25)},0.9)`);
          c.fillStyle = gr; c.fill(wall(0, Math.PI));
          c.lineWidth = Math.max(1.2, tr * 0.07); c.strokeStyle = `rgba(${mix(col, [255, 255, 255], 0.3)},0.95)`; c.beginPath(); c.ellipse(tx, ty, tr, tr * q, 0, 0, TAU); c.stroke();   // the rolled rim
          c.lineWidth = Math.max(0.8, tr * 0.025); c.strokeStyle = 'rgba(255,255,255,0.85)'; c.beginPath(); c.ellipse(tx, ty - tr * 0.01, tr, tr * q, 0, 0.35, Math.PI - 0.35); c.stroke();
          // spikes on the rim, each with a droplet; they break away and fly
          const spk = new Path2D();
          for (let i = 0; i < v.n; i++) {
            const t = (i + hash(v.sd + i) * 0.5) / v.n * TAU, ca = Math.cos(t), sa = Math.sin(t), hs = hash(v.sd + i * 7 + 1);
            const ex = tx + ca * tr, ey = ty + sa * tr * q, sl = top * (0.3 + 0.45 * hs) * Math.min(1, a * 3), wd = Math.max(0.8, tr * 0.05);
            if (a < 0.65) {
              const sx = ex + ca * sl * 0.5 + lean * sl * 0.6, sy = ey - sl * (0.8 + 0.2 * sa);
              spk.moveTo(ex - wd, ey); spk.quadraticCurveTo(ex + ca * sl * 0.1, ey - sl * 0.5, sx, sy); spk.quadraticCurveTo(ex + ca * sl * 0.1 + wd * 0.5, ey - sl * 0.5, ex + wd, ey);
              const d = rd * (0.5 + 0.45 * hs); c.drawImage(sph, sx - d, sy - d, d * 2, d * 2);
            } else {
              const tt = a - 0.65, vx = ca * (0.08 + 0.08 * hs) + lean * 0.5, vy = (0.25 + 0.2 * hs) * r * 6, yw = h * 1.15 + vy * tt - 0.9 * tt * tt;
              if (yw < 0) continue;
              const X2 = v.X + ca * r * 1.4 + vx * tt, Z2 = v.Z + sa * r * 1.4 * 0.8; P(X2, yw, Z2, p2);
              const d = rd * (0.3 + 0.3 * hs); c.drawImage(sph, p2[0] - d, p2[1] - d, d * 2, d * 2);
            }
          }
          c.fillStyle = `rgba(${mix(col, [255, 255, 255], 0.35)},0.9)`; c.fill(spk);
        }
        // the jet: a column rising from the middle, a drop pinching off its top and falling back
        const ja = a - 0.8, J = (0.04 + 0.12 * k) * (v.kind === 0 ? 0.6 : big * 0.9);
        if (ja > 0 && ja < 1.6) {
          const jh = J * Math.sin(Math.PI * Math.min(1, ja / 1.3)), w = (0.006 + 0.008 * k) * K * (1 - 0.5 * ja / 1.6), top = jh * K, jl = windAt(bx) * top * 0.5;
          if (top > 1) {
            const gr = c.createLinearGradient(bx - w, 0, bx + w, 0);
            gr.addColorStop(0, `rgba(${mix(col, [0, 0, 0], 0.35)},0.9)`); gr.addColorStop(0.35, `rgba(${mix(col, [255, 255, 255], 0.45)},0.95)`); gr.addColorStop(1, `rgba(${col},0.85)`);
            c.fillStyle = gr; c.beginPath(); c.moveTo(bx - w * 1.6, by); c.quadraticCurveTo(bx - w * 0.5, by - top * 0.5, bx - w * 0.45 + jl, by - top); c.lineTo(bx + w * 0.45 + jl, by - top); c.quadraticCurveTo(bx + w * 0.5, by - top * 0.5, bx + w * 1.6, by); c.closePath(); c.fill();
            c.globalAlpha = 0.2; c.beginPath(); c.moveTo(bx - w * 1.2, by); c.lineTo(bx - w * 0.4 + jl * 0.6, by + top * 0.55); c.lineTo(bx + w * 0.4 + jl * 0.6, by + top * 0.55); c.lineTo(bx + w * 1.2, by); c.fill(); c.globalAlpha = 1;   // its reflection
            const d = w * 1.25; c.drawImage(sph, bx + jl - d, by - top - d * 1.4, d * 2, d * 2);
          }
          if (ja > 0.55) {                                    // the pinched-off drop
            const tt = ja - 0.55, yw = J * 1.05 + 0.5 * J * tt * 2.2 - 2.4 * J * tt * tt * 2.2;
            if (yw > 0) { P(v.X + windAt(bx) * tt * 0.25, yw, v.Z, p2); const d = (0.006 + 0.005 * k) * K; c.drawImage(sph, p2[0] - d, p2[1] - d * 1.2, d * 2, d * 2.4); c.globalAlpha = 0.18; c.drawImage(sph, p2[0] - d, by + (by - p2[1]) * 0.6 - d, d * 2, d * 2); c.globalAlpha = 1; }
          }
        }
        if (v.kind === 0 && a < 0.4) { c.strokeStyle = `rgba(${mix(col, [255, 255, 255], 0.5)},${0.8 * (1 - a / 0.4)})`; c.lineWidth = Math.max(0.8, rd * 0.4); c.beginPath(); c.ellipse(bx, by, rd * 2.5, rd * 2.5 * q, 0, 0, TAU); c.stroke(); }
      }
      // ---- the flash: hard white light, everything frozen
      if (fl > 0.02) { c.fillStyle = `rgba(255,255,255,${0.42 * fl})`; c.fillRect(0, 0, W, H); }
      if (frozen) { c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 2; c.strokeRect(W * 0.02, H * 0.03, W * 0.96, H * 0.94); }
    },
  };

  return [currents, marbling, cymatics, seaglow, glass, mobile, op, strings, maze, murm, puddle, umbrellas, sumie, score, splash];
})();
