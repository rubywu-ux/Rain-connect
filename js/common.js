/* Rain Connect — shared code for the phone page and the wall (hub) page.
 * Networking: MQTT over secure WebSocket to a public broker (no server of our own).
 * Rain: a deterministic "world" of falling drops, so every phone in a group draws
 * its own slice of the same rain and the streaks line up across screens. */

/* ------------------------------------------------------------------ config */
const RC = (() => {
  const q = new URLSearchParams(location.search);
  return {
    broker: q.get('broker') || 'wss://broker.emqx.io:8084/mqtt',
    base: 'rainconnect/rubywu-ux-k7q2/' + (q.get('room') || 'gallery'),
    debug: q.has('debug'),
    samplePoints: 320,               // points on Earth checked for rain
    refreshMin: 30,                  // how often the wall refreshes live rain data
  };
})();
const EPOCH = Date.UTC(2026, 10, 1);   // keeps float times small

function uid() { return Math.random().toString(36).slice(2, 10); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

/* integer hash -> [0,1): identical on every device / JS engine */
function hash(i) {
  i = (i | 0) >>> 0;
  i = Math.imul(i ^ (i >>> 16), 0x45d9f3b) >>> 0;
  i = Math.imul(i ^ (i >>> 16), 0x45d9f3b) >>> 0;
  i = (i ^ (i >>> 16)) >>> 0;
  return i / 4294967296;
}

/* smooth value noise in [-1,1] built on the integer hash (deterministic everywhere) */
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
  const h = (a, b) => hash(Math.imul(a, 374761393) ^ Math.imul(b, 668265263));
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), w) * 2 - 1;
}
function fbm(x, y) { return vnoise(x, y) * 0.65 + vnoise(x * 2.03 + 5.2, y * 2.03 + 1.3) * 0.35; }

/* ------------------------------------------------------------------ network */
class Net {
  constructor(onMessage, onStatus) {
    this.onMessage = onMessage;
    this.onStatus = onStatus || (() => {});
    this.client = null;
    this.subs = new Set();
  }
  connect() {
    if (!window.mqtt) { this.onStatus('offline'); return; }
    const c = this.client = mqtt.connect(RC.broker, {
      clientId: 'rc_' + uid(), clean: true, keepalive: 30,
      reconnectPeriod: 2500, connectTimeout: 8000,
    });
    c.on('connect', () => {
      this.subs.forEach(t => c.subscribe(RC.base + '/' + t));
      this.onStatus('online');
    });
    c.on('close', () => this.onStatus('offline'));
    c.on('error', () => this.onStatus('offline'));
    c.on('message', (topic, buf) => {
      let m;
      try { m = JSON.parse(buf.toString()); } catch (e) { return; }
      this.onMessage(topic.slice(RC.base.length + 1), m);
    });
  }
  get online() { return !!(this.client && this.client.connected); }
  pub(topic, msg, retain) {
    if (this.online) this.client.publish(RC.base + '/' + topic, JSON.stringify(msg), { qos: 0, retain: !!retain });
  }
  sub(topic) {
    this.subs.add(topic);
    if (this.online) this.client.subscribe(RC.base + '/' + topic);
  }
  unsub(topic) {
    this.subs.delete(topic);
    if (this.online) this.client.unsubscribe(RC.base + '/' + topic);
  }
}

/* ------------------------------------------------------------------ rain renderer (organic, B/W)
 * Rain with simple physics: every drop falls from rest, accelerates to a terminal velocity,
 * streaks (as a fine line of dots) in proportion to its speed, slants with the wind, and
 * splashes where it lands: on the floor, or on a finger held on the glass (an umbrella).
 * Taps throw up fountains of threads that fall back as rain; flicks throw sprays of drops.
 * Everything is a deterministic function of world position + shared time (+ shared events),
 * so the rain continues across phones placed side by side.
 * Default: white light on black.  ?ink : black ink on white paper. */
const INK = new URLSearchParams(location.search).has('ink');
const PAL = INK
  ? { bg: '244,243,240', ink: '12,12,14', comp: 'source-over', fade: 0.24 }
  : { bg: '4,4,5', ink: '236,237,240', comp: 'lighter', fade: 0.42 };
if (INK) document.documentElement.classList.add('ink');
/* one colour per phone (strands stay black & white; a person's touches carry their colour) */
const COLORS = INK
  ? ['214,74,58', '196,132,20', '30,150,110', '40,110,200', '130,80,200', '200,70,140', '90,150,30', '20,140,160']
  : ['255,122,107', '255,198,96', '112,228,182', '110,182,255', '198,152,255', '255,140,200', '170,232,100', '96,222,232'];
function colorOf(i) { return i == null ? PAL.ink : COLORS[((i % COLORS.length) + COLORS.length) % COLORS.length]; }
const DROP_TOP = -240;      // world y where drops start falling (from rest)
const TAU = 0.2;           // seconds for a drop to reach its terminal velocity
const UMB_R = 58;          // umbrella radius (a finger held on the glass)
const DRIP_G = 1300, SPLASH_G = 1300, FLING_G = 1500;   // gravity, world px/s^2
const RIVER_LINES = 26;    // filaments in the river when phones are joined
/* three depths of rain: far drops are small, dim and slow; near drops are bigger, brighter, faster */
const RAIN_LAYERS = [
  { lane: 9,  vt: 560,  P: 1.25, len: 0.045, dot: 0.85, gap: 2.4, alpha: 0.32, lum: 0.35, splash: 0 },
  { lane: 15, vt: 860,  P: 1.6,  len: 0.05,  dot: 1.05, gap: 2.8, alpha: 0.55, lum: 0.6,  splash: 3 },
  { lane: 26, vt: 1200, P: 2.3,  len: 0.055, dot: 1.3,  gap: 3.2, alpha: 0.85, lum: 0.9,  splash: 6 },
];
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
class RainRenderer {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = opts.scale || 1;          // screen px per world px
    this.view = { x: 0, y: 0 };            // world coords of the screen's top-left
    this.floor = null;                     // world y where drops land (null = none)
    this.density = 1;
    this.impulses = [];                    // drag / push fields (shared events)
    this.ripples = [];                     // taps -> ink blooms
    this.flashes = [];                     // joins -> orbit threads
    this.river = null;                     // {cy, since, speed} while phones are joined
    this.trails = [];                      // coloured glints along drags
    this.bolts = [];                       // lightning strikes
    this.umbrellas = new Map();            // held fingers: id -> {x, y, t, since, c, seed}
    this.flings = [];                      // flicks: sprays of drops thrown with a finger
    this.hits = 0;                         // drops that landed on an umbrella (for the pitter-patter)
    this.storm = 0;                        // 0..1, shared: how many people are blowing
    this.bright = 0;
    this.fresh = true;
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * this.dpr);
    this.cv.height = Math.round(this.h * this.dpr);
    this.cv.style.width = this.w + 'px';
    this.cv.style.height = this.h + 'px';
    this.fresh = true;
  }
  get worldW() { return this.w / this.scale; }
  get worldH() { return this.h / this.scale; }

  addImpulse(e) { this.impulses.push(e); if (this.impulses.length > 60) this.impulses.shift(); }
  addRipple(e) { this.ripples.push(e); if (this.ripples.length > 30) this.ripples.shift(); }
  addFlash(e) { this.flashes.push(e); }
  addTrail(e) { this.trails.push(e); if (this.trails.length > 160) this.trails.shift(); }
  addBolt(e) { this.bolts.push(e); if (this.bolts.length > 12) this.bolts.shift(); }
  addHold(e) {
    const u = this.umbrellas.get(e.id);
    if (e.off) { if (u) u.off = true; return; }
    if (!u || u.off || u.since !== e.since) this.umbrellas.set(e.id, Object.assign({}, e));
    else { u.x = e.x; u.y = e.y; u.t = e.t; }
  }
  addFling(e) { this.flings.push(e); if (this.flings.length > 12) this.flings.shift(); }

  /* displacement at world (x,y): drags push AND swirl strands around the finger */
  disp(x, y, T) {
    let dx = 0, dy = 0;
    for (const m of this.impulses) {
      const age = T - m.t;
      if (age < 0 || age > 3) continue;
      const env = age < 0.1 ? age / 0.1 : Math.exp(-(age - 0.1) * 1.3);
      const ex = x - m.x, ey = y - m.y;
      const d2 = ex * ex + ey * ey, r2 = m.r * m.r;
      if (d2 > r2 * 6) continue;
      const f = Math.exp(-d2 / r2) * env;
      const d = Math.sqrt(d2) + 1;
      if (m.kind === 'radial') { dx += ex / d * m.s * f; dy += ey / d * m.s * f; }
      else {
        const mag = Math.hypot(m.dx, m.dy) || 1;
        const turn = Math.sign(m.dx * ey - m.dy * ex) || 1;          // curl around the drag line
        dx += (m.dx * 0.7 - ey / d * mag * 0.8 * turn) * f;
        dy += (m.dy * 0.7 + ex / d * mag * 0.8 * turn) * f;
      }
    }
    return [dx, dy];
  }

  _toScreen(x, y) { return [(x - this.view.x) * this.scale, (y - this.view.y) * this.scale]; }

  draw(T) {
    const c = this.ctx, s = this.scale, vx = this.view.x, vy = this.view.y;
    const W = this.worldW, H = this.worldH, lw = Math.max(1, s * 0.75);
    const dtF = this.lastT != null ? clamp(T - this.lastT, 0, 0.1) : 0.016;
    this.lastT = T;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = `rgba(${PAL.bg},${this.fresh ? 1 : PAL.fade})`;      // soft persistence = motion blur
    c.fillRect(0, 0, this.w, this.h);
    this.fresh = false;
    this.impulses = this.impulses.filter(m => T - m.t < 3);
    this.bright = Math.max(0, this.bright - 0.01);
    const boost = 1 + this.bright * 0.6;
    c.globalCompositeOperation = PAL.comp;
    c.lineCap = 'round'; c.lineJoin = 'round';

    const floor = this.floor, yLand = floor != null ? floor : 1e9, storm = this.storm, dens = this.density;
    const river = this.river, rho = river ? clamp((T - river.since) / 2.5, 0, 1) : 0;
    const yBot = vy + H + 30;
    const toS = (x, y) => [(x - vx) * s, (y - vy) * s];
    const onS = (sx, sy, m = 30) => sx > -m && sx < this.w + m && sy > -m && sy < this.h + m;

    // everything is batched: dotted streaks per depth layer, sparkles in a few brightness levels
    const lines = RAIN_LAYERS.map(() => new Path2D());
    const SL = 4, sp = []; for (let k = 0; k < SL; k++) sp.push(new Path2D());
    const tinted = [];                                               // [sx, sy, colour, alpha]
    const lvl = al => Math.min(SL - 1, Math.floor(clamp(al * boost, 0, 0.999) * SL));
    const spark = (sx, sy, al, r = 1) => {
      if (al > 0.03 && onS(sx, sy, 8)) { const d = r * lw * 1.3; sp[lvl(al)].rect(sx - d / 2, sy - d / 2, d, d); }
    };
    const streak = (b, x1, y1, x2, y2) => {                          // world coords; a finger's push bends it
      const [d1x, d1y] = this.disp(x1, y1, T), [d2x, d2y] = this.disp(x2, y2, T);
      const a = toS(x1 + d1x, y1 + d1y), e = toS(x2 + d2x, y2 + d2y);
      if (!onS(a[0], a[1]) && !onS(e[0], e[1])) return null;
      lines[b].moveTo(a[0], a[1]); lines[b].lineTo(e[0], e[1]);
      return e;
    };

    // fingers held on the glass are umbrellas (shared with the joined phones)
    const umbs = [];
    for (const [id, u] of this.umbrellas) {
      if (u.off || T - u.t > 0.5) { if (u.off || T - u.t > 2) this.umbrellas.delete(id); continue; }
      umbs.push(u);
    }

    // wind: a slow drift, gusty in a storm; it slants every drop the same way on every screen
    const wind = 34 * vnoise(T * 0.07, 3.3) + 18 * vnoise(T * 0.29, 7.1) + storm * (240 + 90 * vnoise(T * 0.5, 1.7));

    // ---- rain: three depths of drops. Each one falls from rest, speeds up to its terminal
    //      velocity, streaks in proportion to its speed and splashes where it lands.
    let hits = 0;
    for (let L = 0; L < RAIN_LAYERS.length; L++) {
      const ly = RAIN_LAYERS[L];
      const fall = aa => DROP_TOP + ly.vt * (aa - TAU * (1 - Math.exp(-aa / TAU)));
      const reachX = Math.abs(wind) * 2.2 + 60;
      const i0 = Math.floor((vx - reachX) / ly.lane), i1 = Math.ceil((vx + W + reachX) / ly.lane);
      const aMin = Math.max(0, (vy - 80 - DROP_TOP) / ly.vt), aMax = (Math.min(yBot, yLand) - DROP_TOP) / ly.vt + TAU + 0.8;
      const tl = ly.len * (1 + storm * 0.6);                         // streak = distance fallen in the last tl s
      for (let i = i0; i <= i1; i++) {
        const P = ly.P * (0.7 + 0.6 * hash(i * 7 + L)) / (dens * (1 + storm * 1.3)), ph = hash(i * 13 + L * 5) * P;
        const kHi = Math.floor((T - ph - aMin) / P), kLo = Math.ceil((T - ph - aMax) / P);
        for (let k = kLo; k <= kHi; k++) {
          const tb = k * P + ph, a = T - tb;
          if (a < 0) continue;
          const ks = (Math.imul(i, 977) + Math.imul(k, 131) + L * 7919) | 0;
          const x0 = i * ly.lane + hash(ks + 1) * ly.lane, wp = hash(ks + 4) * 9;
          const size = 0.75 + 0.5 * hash(ks + 2), lum = ly.lum * (0.6 + 0.4 * hash(ks + 3));
          const xAt = aa => x0 + wind * aa + 4 * vnoise(aa * 1.5 + wp, 0.5);
          const yh = fall(a), v = Math.max(1, ly.vt * (1 - Math.exp(-a / TAU)));
          const at = Math.max(0, a - tl), yt = fall(at);
          // joined phones: most drops are caught by the river and carried across the screens
          if (rho > 0 && hash(ks + 7) < 0.65 * rho) {
            const top = river.cy - 30;
            if (yh > top) {
              const f = (yh - top) / ly.vt;                            // seconds since it entered the current
              if (f > 2.8) continue;
              const xc = xAt(a - f), dir = Math.sign(river.speed) || 1, spd = Math.abs(river.speed) * (0.8 + 0.4 * hash(ks + 8));
              const depth = (hash(ks + 9) - 0.15) * 70;
              const fx = q => xc + dir * spd * (q - 0.3 * (1 - Math.exp(-q / 0.3)));
              const fy = q => top + depth * (1 - Math.exp(-q * 5)) + 7 * vnoise(q * 0.8 + wp, 3);
              const q0 = Math.max(0, f - 0.07);
              const e = streak(L, fx(q0), fy(q0), fx(f), fy(f));
              if (e) spark(e[0], e[1], lum * Math.min(1, (2.8 - f) / 0.8), ly.dot);
              continue;
            }
          }
          // umbrellas: drops that reach a canopy after it opened stop there and splash
          let stopY = yLand, onUmb = false;
          if (umbs.length) {
            const xh = xAt(a);
            for (const u of umbs) {
              const du = xh - u.x;
              if (Math.abs(du) >= UMB_R) continue;
              const rim = u.y - Math.sqrt(UMB_R * UMB_R - du * du) * 0.62;
              if (rim < stopY && yh > rim && tb + a - (yh - rim) / v >= u.since) { stopY = rim; onUmb = true; }
            }
          }
          if (yh > stopY) {
            const dtH = (yh - stopY) / ly.vt, hx = xAt(a - dtH);
            if (yt < stopY) streak(L, xAt(at), yt, hx, stopY);         // the bit still above the surface
            if (onUmb) { if (dtH < dtF) hits++; this._splash(spark, hx, stopY, dtH, ks, lum, L ? 2 : 0, 0.55, false); }
            else this._splash(spark, hx, stopY, dtH, ks, lum, ly.splash, size, L > 0);
            continue;
          }
          if (yh < vy - 60) continue;
          const e = streak(L, xAt(at), yt, xAt(a), yh);
          if (e && L > 0) spark(e[0], e[1], lum * (L === 1 ? 0.6 : 1), ly.dot);   // nearer drops glint
        }
      }
    }
    this.hits = (this.hits || 0) + hits;

    // umbrellas: a dotted canopy in the holder's colour; water runs off its edges and drips,
    // each drip starting from rest and visibly speeding up as it falls
    const canopies = [];
    for (const u of umbs) {
      const open = smoothstep(0, 0.22, T - u.since), sd = (u.seed | 0) || 1;
      const p = new Path2D();
      for (let n = 0; n <= 28; n++) {
        const th = Math.PI + n / 28 * Math.PI;
        const [sx, sy] = toS(u.x + Math.cos(th) * UMB_R * open, u.y + Math.sin(th) * UMB_R * 0.62 * open);
        n ? p.lineTo(sx, sy) : p.moveTo(sx, sy);
      }
      canopies.push([p, colorOf(u.c), open]);
      for (let j = 0; j < 60; j++) {
        const td = u.since + 0.3 + j * 0.19 + hash(sd + j * 7) * 0.12, dt = T - td;
        if (dt < 0) break;
        if (dt > 1.3) continue;
        const side = hash(sd + j * 3) < 0.5 ? -1 : 1;
        const ex = u.x + side * UMB_R * (0.86 + 0.12 * hash(sd + j + 11)) + side * 30 * dt, ey = u.y + 1;
        const y = ey + 0.5 * DRIP_G * dt * dt, yp = ey + 0.5 * DRIP_G * Math.max(0, dt - 0.03) ** 2;
        if (y > yLand) { this._splash(spark, ex, yLand, (y - yLand) / (DRIP_G * dt), sd + j, 0.7, 3, 0.7, true); continue; }
        const e = streak(1, ex - side * 30 * 0.03, yp - 1, ex, y);
        if (e) spark(e[0], e[1], 0.85, 1.2);
      }
    }

    // flings: a fast flick throws a spray of drops that arc under gravity and splash down
    this.flings = this.flings.filter(f => T - f.t < 3);
    for (const f of this.flings) {
      const age = T - f.t; if (age < 0) continue;
      const base = Math.atan2(f.dy, f.dx), col = colorOf(f.c), sd = f.seed | 0;
      for (let j = 0; j < 40; j++) {
        const hs = sd + j * 31;
        const ang = base + (hash(hs) - 0.5) * 0.6, spd = f.sp * (0.4 + 0.65 * hash(hs + 1));
        const ux = Math.cos(ang) * spd, uy = Math.sin(ang) * spd;
        const px = t => f.x + ux * (1 - Math.exp(-t * 1.4)) / 1.4, py = t => f.y + uy * t + 0.5 * FLING_G * t * t;
        const disc = uy * uy + 2 * FLING_G * (yLand - f.y);
        const tLand = disc > 0 ? (-uy + Math.sqrt(disc)) / FLING_G : 1e9;
        if (age > tLand) { this._splash(spark, px(tLand), yLand, age - tLand, hs, 0.8, 4, 0.8, true); continue; }
        const e = streak(2, px(Math.max(0, age - 0.03)), py(Math.max(0, age - 0.03)), px(age), py(age));
        if (e) { tinted.push([e[0], e[1], col, 0.95]); spark(e[0], e[1], 0.5, 1.4); }
      }
    }

    // draw the rain: each streak is a short line of fine dots
    for (let L = 0; L < RAIN_LAYERS.length; L++) {
      const ly = RAIN_LAYERS[L];
      c.setLineDash([0.01, ly.gap * s]);
      c.lineDashOffset = 0;
      c.strokeStyle = `rgba(${PAL.ink},${Math.min(1, ly.alpha * boost)})`;
      c.lineWidth = lw * ly.dot; c.stroke(lines[L]);
    }
    c.setLineDash([]);
    for (const [p, col, open] of canopies) {
      c.strokeStyle = `rgba(${col},${0.12 * open})`; c.lineWidth = lw * 5; c.stroke(p);
      c.setLineDash([0.01, 3 * s]);
      c.strokeStyle = `rgba(${col},${0.8 * open})`; c.lineWidth = lw * 1.4; c.stroke(p);
      c.setLineDash([]);
    }

    // the river itself: long dotted currents that run across every joined screen
    if (river && rho > 0) {
      const G = 240, xs = Math.floor((vx - 260) / G) * G, xe = vx + W + 260;
      const paths = [new Path2D(), new Path2D()];
      for (let j = 0; j < RIVER_LINES; j++) {
        const pts = [];
        const off = (j / (RIVER_LINES - 1) - 0.5) * 84;
        for (let x = xs; x <= xe; x += 24) {
          const y = river.cy + off * (0.62 + 0.38 * vnoise(x * 0.0021, T * 0.08 + 3)) * (0.85 + 0.15 * vnoise(x * 0.004, j * 0.4))
                  + 26 * vnoise(x * 0.0028 + j * 0.06, T * 0.12) + 7 * vnoise(x * 0.011 + j * 0.9, T * 0.3 + j);
          const [dx, dy] = this.disp(x, y, T);
          pts.push(toS(x + dx, y + dy));
        }
        const path = paths[hash(j + 900) < 0.35 ? 1 : 0];
        path.moveTo(pts[0][0], pts[0][1]);
        for (let q = 1; q < pts.length - 1; q++)
          path.quadraticCurveTo(pts[q][0], pts[q][1], (pts[q][0] + pts[q + 1][0]) / 2, (pts[q][1] + pts[q + 1][1]) / 2);
      }
      const ro = (xs - T * river.speed) * s;                          // same dot phase on every phone
      [[0, 0.14, 3.2], [1, 0.32, 2.6]].forEach(([b, al, gap]) => {
        c.setLineDash([0.01, gap * s]); c.lineDashOffset = ro;
        c.strokeStyle = `rgba(${PAL.ink},${al * rho * boost})`; c.lineWidth = lw * 1.15; c.stroke(paths[b]);
      });
      c.setLineDash([]); c.lineDashOffset = 0;
    }

    // taps: a fountain of fine threads leaps up, opens like a flower and rains back down
    this.ripples = this.ripples.filter(r => T - r.t < 3.4);
    for (const r of this.ripples) {
      const age = T - r.t; if (age < 0) continue;
      this._fountain(c, r, age, lw, yLand, spark);
    }

    // sparkles
    for (let k = 0; k < SL; k++) { c.fillStyle = `rgba(${PAL.ink},${(k + 0.5) / SL})`; c.fill(sp[k]); }
    for (const [sx, sy, col, al] of tinted) {
      c.fillStyle = `rgba(${col},${al})`; c.fillRect(sx - 1.2 * lw, sy - 1.2 * lw, 2.4 * lw, 2.4 * lw);
    }
    if (floor != null && floor < vy + H + 40) {
      const fy = (floor - vy) * s;
      const g = c.createLinearGradient(0, fy - 50, 0, fy);
      g.addColorStop(0, `rgba(${PAL.ink},0)`); g.addColorStop(1, `rgba(${PAL.ink},0.05)`);
      c.fillStyle = g; c.fillRect(0, fy - 50, this.w, 50);
    }

    // drags leave a fading trail of glints in the dragger's colour
    this.trails = this.trails.filter(d => T - d.t < 1.6);
    for (const d of this.trails) {
      const age = T - d.t; if (age < 0) continue;
      const [sx, sy] = this._toScreen(d.x, d.y);
      if (sx < -40 || sy < -40 || sx > this.w + 40 || sy > this.h + 40) continue;
      const a = Math.pow(1 - age / 1.6, 1.5), rr = (5 + age * 10) * s;
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, rr);
      g.addColorStop(0, `rgba(${colorOf(d.c)},${0.55 * a})`); g.addColorStop(1, `rgba(${colorOf(d.c)},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(sx, sy, rr, 0, 6.283); c.fill();
    }

    // lightning: white bolts (same seed -> same bolt on every screen), with a brief sky flash
    this.bolts = this.bolts.filter(b => T - b.t < 1.2);
    for (const b of this.bolts) {
      const age = T - b.t; if (age < 0) continue;
      this._bolt(c, b, age, lw);
    }

    // joins: a luminous orbit thread drawn across the connected screens
    this.flashes = this.flashes.filter(f => T - f.t < 5);
    for (const f of this.flashes) {
      const age = T - f.t; if (age < 0) continue;
      this._orbit(c, f, age, lw);
    }
    c.globalCompositeOperation = 'source-over';
  }

  /* a drop meeting a surface: a few droplets bounce up and fall back (gravity), plus a flat ring */
  _splash(spark, hx, hy, dt, ks, lum, n, size, ring) {
    if (dt > 0.75) return;
    for (let m = 0; m < n; m++) {
      const hs = ks * 3 + m * 37;
      const ux = (hash(hs) - 0.5) * 230 * size, uy = (90 + 170 * hash(hs + 1)) * size;
      const y = hy - uy * dt + 0.5 * SPLASH_G * dt * dt;
      if (y > hy + 1) continue;
      const [sx, sy] = this._toScreen(hx + ux * dt, y);
      spark(sx, sy, lum * (1 - dt / 0.75), 0.9);
    }
    if (ring && dt < 0.45) {
      const r = (3 + 55 * dt) * size, al = lum * 0.45 * (1 - dt / 0.45);
      for (let q = 0; q < 8; q++) {
        const th = q / 8 * 6.283 + hash(ks + q);
        const [sx, sy] = this._toScreen(hx + Math.cos(th) * r, hy + Math.sin(th) * r * 0.22);
        spark(sx, sy, al, 0.8);
      }
    }
    if (dt < 0.05) { const [sx, sy] = this._toScreen(hx, hy); spark(sx, sy, lum * 1.3, 1.7); }
  }

  /* a tap: threads leap up from the finger, open like a flower and fall back as rain */
  _fountain(c, r, age, lw, yLand, spark) {
    const k = r.k || 1, n = r.echo ? 26 : 44, col = colorOf(r.c), sd = r.seed | 0;
    const fade = age < 2.2 ? 1 : Math.max(0, 1 - (age - 2.2) / 1.2);
    if (fade <= 0) return;
    const g = 640 * k, path = new Path2D();
    const tHead = age * 1.1, tTail = Math.max(0, (age - 0.5) * 1.3);    // the jet rises, then lets go
    for (let j = 0; j < n; j++) {
      const q = j / (n - 1) * 2 - 1;
      const ang = q * 1.05 + (hash(sd + j * 3) - 0.5) * 0.2;            // 0 = straight up
      const v = (250 + 140 * hash(sd + j * 3 + 1)) * k * (1 - 0.3 * q * q);
      const ux = Math.sin(ang) * v, uy = Math.cos(ang) * v, wob = hash(sd + j * 3 + 2) * 6.283;
      const P = tt => this._toScreen(r.x + ux * tt + 4 * Math.sin(tt * 5 + wob) * tt * k,
                                     Math.min(yLand, r.y - uy * tt + 0.5 * g * tt * tt));
      for (let m = 0; m <= 12; m++) {
        const [sx, sy] = P(tTail + (tHead - tTail) * m / 12);
        m ? path.lineTo(sx, sy) : path.moveTo(sx, sy);
      }
      const [hx, hy] = P(tHead);
      spark(hx, hy, 0.9 * fade, hash(sd + j * 3 + 4) < 0.3 ? 1.7 : 1.1);
    }
    c.setLineDash([]);
    c.strokeStyle = `rgba(${col},${0.1 * fade})`; c.lineWidth = lw * 0.6; c.stroke(path);
    c.setLineDash([0.01, 2.8 * this.scale]); c.lineDashOffset = -age * 40 * this.scale;
    c.strokeStyle = `rgba(${col},${(r.echo ? 0.45 : 0.75) * fade})`; c.lineWidth = lw * 1.1; c.stroke(path);
    c.setLineDash([]); c.lineDashOffset = 0;
    if (age < 0.35) {
      const [sx, sy] = this._toScreen(r.x, r.y), R = (10 + 60 * age) * this.scale * k, f = 1 - age / 0.35;
      const gr = c.createRadialGradient(sx, sy, 0, sx, sy, R);
      gr.addColorStop(0, `rgba(${col},${0.45 * f})`); gr.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = gr; c.beginPath(); c.arc(sx, sy, R, 0, 6.283); c.fill();
    }
  }

  _bolt(c, b, age, lw) {
    // flicker: bright, dip, bright again, then fade
    const fl = age < 0.07 ? 1 : age < 0.12 ? 0.25 : age < 0.2 ? 0.9 : Math.max(0, 1 - (age - 0.2) / 0.9);
    if (fl <= 0) return;
    const W = this.w, H = this.h, sd = b.seed | 0;
    // sky flash over the whole screen
    if (age < 0.35) {
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = INK ? `rgba(20,20,24,${0.18 * b.power * fl})` : `rgba(235,240,255,${0.22 * b.power * fl})`;
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = PAL.comp;
    }
    const col = INK ? '20,20,24' : '255,255,255';
    const main = new Path2D(), branches = new Path2D();
    let x = b.u * W, y = -10;
    const endY = H * (0.55 + 0.45 * hash(sd + 1));
    const step = 16 + 10 * hash(sd + 2);
    main.moveTo(x, y);
    let n = 0;
    while (y < endY) {
      x += (hash(sd + 10 + n) - 0.5) * 34;
      y += step * (0.6 + 0.8 * hash(sd + 200 + n));
      main.lineTo(x, y);
      if (hash(sd + 400 + n) < 0.12) {                // a branch forks off
        let bx = x, by = y;
        const dir = hash(sd + 500 + n) < 0.5 ? -1 : 1;
        branches.moveTo(bx, by);
        const len = 3 + Math.floor(hash(sd + 600 + n) * 6);
        for (let k = 0; k < len; k++) {
          bx += dir * (6 + 14 * hash(sd + 700 + n * 13 + k)); by += 10 + 12 * hash(sd + 800 + n * 13 + k);
          branches.lineTo(bx, by);
        }
      }
      n++;
    }
    [[9, 0.08], [4, 0.25], [1.6, 1]].forEach(([w, a]) => {
      c.strokeStyle = `rgba(${col},${a * fl})`;
      c.lineWidth = w * lw; c.stroke(main);
      c.lineWidth = w * lw * 0.5; c.stroke(branches);
    });
  }

  _orbit(c, f, age, lw) {
    const col = colorOf(f.c);
    const reveal = Math.min(1, age / 1.4);
    const fade = age < 1.4 ? 1 : Math.max(0, 1 - (age - 1.4) / 3.6);
    const sd = Math.floor(f.x * 3 + f.y * 7);
    const P = [
      [f.x - 520, f.y + 240 + hash(sd) * 120], [f.x - 180, f.y - 340 - hash(sd + 1) * 100],
      [f.x + 160, f.y + 320 + hash(sd + 2) * 100], [f.x + 540, f.y - 200 - hash(sd + 3) * 120],
    ];
    const pt = u => {
      const a = 1 - u;
      return [a * a * a * P[0][0] + 3 * a * a * u * P[1][0] + 3 * a * u * u * P[2][0] + u * u * u * P[3][0],
              a * a * a * P[0][1] + 3 * a * a * u * P[1][1] + 3 * a * u * u * P[2][1] + u * u * u * P[3][1]];
    };
    const path = new Path2D();
    const N = 80;
    for (let n = 0; n <= N * reveal; n++) {
      const [x, y] = this._toScreen(...pt(n / N));
      if (n === 0) path.moveTo(x, y); else path.lineTo(x, y);
    }
    [[7, 0.06], [3, 0.18], [1.1, 0.95]].forEach(([w, a]) => {
      c.strokeStyle = `rgba(${col},${a * fade})`; c.lineWidth = w * lw; c.stroke(path);
    });
    for (const u of [0.18, 0.5, 0.82]) {
      if (u > reveal) continue;
      const [x, y] = this._toScreen(...pt(u));
      c.fillStyle = `rgba(${col},${0.85 * fade})`;
      for (let q = 0; q < 40; q++) {
        const th = hash(q * 13 + sd) * 6.283, ph = Math.acos(2 * hash(q * 17 + sd) - 1), r = 9 * this.scale;
        c.fillRect(x + Math.cos(th) * Math.sin(ph) * r, y + Math.cos(ph) * r, lw, lw);
      }
    }
    const [hx, hy] = this._toScreen(...pt(reveal));
    const g = c.createRadialGradient(hx, hy, 0, hx, hy, 18 * lw);
    g.addColorStop(0, `rgba(${col},${0.9 * fade})`); g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g; c.beginPath(); c.arc(hx, hy, 18 * lw, 0, 6.283); c.fill();
  }
}

/* ------------------------------------------------------------------ shared music */
const MUSIC = {
  chordSecs: 8,                    // chord changes every 8 s, the same on every phone
  pulse: 60 / 84 / 2,              // notes land on a soft 84 bpm eighth-note pulse
  // Dmaj9 -> Bm9 -> Gmaj9 -> A6sus: all within D major, so every voice blends
  chords: [[62, 66, 69, 73, 76], [59, 62, 66, 69, 73], [55, 59, 62, 66, 69], [57, 62, 64, 66, 69]],
  voices: [   // one per colour: coral, amber, mint, sky, lilac, pink, lime, cyan
    { name: 'bell',       reg: 12,  gain: 0.8, attack: 0.004, partials: [[1, 1, 2.6], [2.76, 0.25, 0.9], [5.4, 0.1, 0.3]] },
    { name: 'marimba',    reg: 0,   gain: 1.0, attack: 0.003, partials: [[1, 1, 1.0], [4, 0.3, 0.12], [10, 0.08, 0.04]] },
    { name: 'glass',      reg: 12,  gain: 0.7, attack: 0.09,  partials: [[1, 1, 2.8], [2, 0.18, 1.6]] },
    { name: 'kalimba',    reg: 0,   gain: 0.9, attack: 0.003, partials: [[1, 1, 1.5], [5.4, 0.22, 0.07], [2, 0.12, 0.5]] },
    { name: 'felt piano', reg: -12, gain: 1.1, attack: 0.012, partials: [[1, 1, 2.2], [2, 0.35, 1.2], [3, 0.12, 0.6]], wave: 'triangle', lp: 1100 },
    { name: 'music box',  reg: 24,  gain: 0.55, attack: 0.002, partials: [[1, 1, 1.3], [3, 0.2, 0.4], [6.2, 0.06, 0.12]] },
    { name: 'soft flute', reg: 12,  gain: 0.6, attack: 0.07,  partials: [[1, 1, 1.4], [2, 0.12, 0.9]], breath: 0.05 },
    { name: 'vibraphone', reg: 0,   gain: 0.8, attack: 0.004, partials: [[1, 1, 2.8], [4, 0.18, 0.5]], trem: 5.2 },
  ],
};

/* ------------------------------------------------------------------ sound (Web Audio, no files) */
class RainSound {
  constructor() { this.ctx = null; this.amb = null; }
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const a = this.ctx = new AC();
    this.master = a.createGain(); this.master.gain.value = 0.9;
    const comp = a.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.25;
    this.master.connect(comp); comp.connect(a.destination);
    // reverb-ish: feedback delay network kept simple
    this.wet = a.createGain(); this.wet.gain.value = 0.35;
    const d1 = a.createDelay(), d2 = a.createDelay(), fb = a.createGain(), lp = a.createBiquadFilter();
    d1.delayTime.value = 0.097; d2.delayTime.value = 0.143; fb.gain.value = 0.55; lp.frequency.value = 3200;
    this.wet.connect(d1); d1.connect(d2); d2.connect(lp); lp.connect(fb); fb.connect(d1); lp.connect(this.master);
    // ambient rain: looping noise through filters
    const len = a.sampleRate * 4, buf = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0527;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.11;
      }
      const f = 4000; for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[len - f + i] * (1 - t); }
    }
    const src = a.createBufferSource(); src.buffer = buf; src.loop = true;
    const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
    const lp2 = a.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 3200;
    this.amb = a.createGain(); this.amb.gain.value = 0;
    src.connect(hp); hp.connect(lp2); lp2.connect(this.amb); this.amb.connect(this.master);
    src.start();
    this.setRain(0.25);
    this._ticks();
  }
  /* overall rain loudness 0..1 (tied to how much of Earth is raining) */
  setRain(v) {
    this.level = v;
    if (this.amb) this.amb.gain.setTargetAtTime(0.025 + v * 0.05, this.ctx.currentTime, 1.5);   // rain stays in the background
  }
  _ticks() {           // sparse droplet ticks on top of the hiss
    const a = this.ctx;
    const go = () => {
      if (a.state === 'running') {
        const n = 1 + Math.floor(Math.random() * 3 * (0.4 + (this.level || 0.2)));
        for (let k = 0; k < n; k++) if (Math.random() < 0.45) this.plip(Math.random(), 0.008 + Math.random() * 0.012, a.currentTime + Math.random() * 0.25, 1800 + Math.random() * 2500);
      }
      setTimeout(go, 180 + Math.random() * 260);
    };
    go();
  }
  plip(pan = 0.5, vol = 0.25, when, top = 2600) {
    const a = this.ctx; if (!a) return;
    const t = when || a.currentTime;
    const o = a.createOscillator(), g = a.createGain(), p = a.createStereoPanner ? a.createStereoPanner() : null;
    o.type = 'sine';
    o.frequency.setValueAtTime(top * 0.35, t);
    o.frequency.exponentialRampToValueAtTime(top, t + 0.05);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g);
    if (p) { p.pan.value = pan * 2 - 1; g.connect(p); p.connect(this.master); p.connect(this.wet); }
    else { g.connect(this.master); }
    o.start(t); o.stop(t + 0.12);
  }

  /* ---------------- the shared music: one instrument per colour, one chord for everyone ----------------
     All phones share the same clock, so they agree on the current chord and on the beat.
     Every note anyone plays is a tone of the current chord, placed on the next soft pulse. */
  static chordAt(T) { return MUSIC.chords[Math.floor(T / MUSIC.chordSecs) % MUSIC.chords.length]; }
  static nextPulse(T) { const g = MUSIC.pulse; return Math.ceil(T / g + 0.001) * g; }

  /* note for voice ci at position u (0..1 left->right), at shared time T */
  static noteFor(ci, u, T) {
    const v = MUSIC.voices[((ci || 0) % MUSIC.voices.length + MUSIC.voices.length) % MUSIC.voices.length];
    const ch = RainSound.chordAt(T);
    const idx = clamp(Math.floor(u * (ch.length + 2)), 0, ch.length + 1);
    return ch[idx % ch.length] + 12 * Math.floor(idx / ch.length) + v.reg;
  }

  /* play voice ci (a colour) at shared time Tplay; nowT = shared time right now */
  voice(ci, midi, Tplay, nowT, vol = 0.2, pan = 0.5) {
    const a = this.ctx; if (!a || a.state === 'closed') return;
    const now = a.currentTime, t = now + Math.max(0, Tplay - nowT);
    this._recent = (this._recent || []).filter(x => Tplay - x < 1);
    if (this._recent.length > 8) return;                     // keep it gentle: at most ~8 notes a second
    this._recent.push(Tplay);
    const v = MUSIC.voices[((ci || 0) % MUSIC.voices.length + MUSIC.voices.length) % MUSIC.voices.length];
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const out = a.createGain(); out.gain.value = vol * v.gain;
    let dest = out;
    if (a.createStereoPanner) { const p = a.createStereoPanner(); p.pan.value = clamp(pan * 2 - 1, -1, 1) * 0.7; out.connect(p); dest = p; }
    dest.connect(this.master); dest.connect(this.wet);
    let pre = out;
    if (v.lp) { const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = v.lp; lp.connect(out); pre = lp; }
    let end = t;
    for (const [m, amp, dec] of v.partials) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = v.wave || 'sine';
      o.frequency.value = f * m;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + v.attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + v.attack + dec);
      if (v.trem) {                                             // vibraphone shimmer
        const l = a.createOscillator(), lg = a.createGain();
        l.frequency.value = v.trem; lg.gain.value = amp * 0.35; l.connect(lg); lg.connect(g.gain);
        l.start(t); l.stop(t + v.attack + dec + 0.1);
      }
      o.connect(g); g.connect(pre);
      o.start(t); o.stop(t + v.attack + dec + 0.1);
      end = Math.max(end, t + v.attack + dec);
    }
    if (v.breath) {                                             // flute breath
      const n = a.createBufferSource(), b = a.createBuffer(1, a.sampleRate * 0.4, a.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (a.sampleRate * 0.12));
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 2;
      const g = a.createGain(); g.gain.value = v.breath;
      n.buffer = b; n.connect(bp); bp.connect(g); g.connect(pre); n.start(t);
    }
  }

  /* a very quiet pad holding the current chord's root and fifth, so everything sits on one harmony */
  /* storm: dark gusting wind bed whose loudness follows how many people are blowing */
  _noiseBuffer(sec, brown) {
    const a = this.ctx, len = a.sampleRate * sec, buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    const f = Math.min(4000, len >> 2); for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[len - f + i] * (1 - t); }
    return buf;
  }
  setStorm(level) {
    const a = this.ctx; if (!a) return;
    if (!this.storm) {
      const src = a.createBufferSource(); src.buffer = this._noiseBuffer(6, true); src.loop = true;
      const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.7;
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.6;
      const gust = a.createOscillator(), gg = a.createGain(); gust.frequency.value = 0.13; gg.gain.value = 260;
      gust.connect(gg); gg.connect(lp.frequency); gust.start();
      const air = a.createGain(); air.gain.value = 0.25;
      const g = a.createGain(); g.gain.value = 0.0001;
      src.connect(lp); lp.connect(g); src.connect(bp); bp.connect(air); air.connect(g);
      g.connect(this.master); src.start();
      this.storm = { g, lp };
    }
    // 0 = calm; 2 people ~ quiet; more people = louder
    this.storm.g.gain.setTargetAtTime(level <= 0 ? 0.0001 : 0.06 + level * 0.42, a.currentTime, level > 0 ? 0.8 : 1.2);
    this.storm.lp.frequency.setTargetAtTime(380 + level * 700, a.currentTime, 1);
  }
  /* thunder after a strike: low rumble (+ a crack when it is close) */
  thunder(power = 0.6, delay = 0.6) {
    const a = this.ctx; if (!a) return;
    const t = a.currentTime + delay;
    const src = a.createBufferSource(); src.buffer = this._noiseBuffer(3, true);
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(260 + power * 300, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 2.4);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25 + 0.55 * power, t + 0.08 + (1 - power) * 0.25);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.8);
    src.connect(lp); lp.connect(g); g.connect(this.master); g.connect(this.wet);
    src.start(t); src.stop(t + 3);
    if (power > 0.6) {                                       // close strike: a short crack first
      const cs = a.createBufferSource(); cs.buffer = this._noiseBuffer(0.3, false);
      const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1500;
      const cg = a.createGain(); cg.gain.setValueAtTime(0.0001, t - 0.05);
      cg.gain.exponentialRampToValueAtTime(0.12 * power, t - 0.04); cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      cs.connect(hp); hp.connect(cg); cg.connect(this.master); cs.start(t - 0.05); cs.stop(t + 0.25);
    }
  }
  /* one person blowing: a soft whoosh */
  gust(strength = 0.5) {
    const a = this.ctx; if (!a) return;
    const t = a.currentTime;
    const src = a.createBufferSource(); src.buffer = this._noiseBuffer(1.2, false);
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8;
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(1400, t + 0.5); bp.frequency.exponentialRampToValueAtTime(600, t + 1.1);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.05 + 0.08 * strength, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    src.connect(bp); bp.connect(g); g.connect(this.master); src.start(t); src.stop(t + 1.2);
  }

  startPad(getT) {
    const a = this.ctx; if (!a || this.pad) return;
    const g = a.createGain(); g.gain.value = 0.0001;
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
    lp.connect(g); g.connect(this.master); g.connect(this.wet);
    const oscs = [0, 7, 12].map((iv, k) => {
      const o = a.createOscillator(); o.type = 'triangle'; o.detune.value = (k - 1) * 6;
      const og = a.createGain(); og.gain.value = k === 1 ? 0.5 : 0.7; o.connect(og); og.connect(lp); o.start();
      return [o, iv];
    });
    this.pad = { g, oscs, chord: -1 };
    g.gain.setTargetAtTime(0.05, a.currentTime, 3);
    const tick = () => {
      const T = getT(), ci = Math.floor(T / MUSIC.chordSecs);
      if (ci !== this.pad.chord) {
        this.pad.chord = ci;
        const root = RainSound.chordAt(T)[0] - 24;
        for (const [o, iv] of oscs) o.frequency.setTargetAtTime(440 * Math.pow(2, (root + iv - 69) / 12), a.currentTime, 0.8);
      }
      setTimeout(tick, 250);
    };
    tick();
  }

  /* glassy bell for a phone joining */
  chime(note = 0, when = 0, vol = 0.32) {
    const a = this.ctx; if (!a) return;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const f = 523.25 * Math.pow(2, scale[((note % scale.length) + scale.length) % scale.length] / 12);
    const t = a.currentTime + when;
    [[1, 1, 2.6], [2.76, 0.28, 0.9], [5.4, 0.12, 0.35], [8.9, 0.05, 0.15]].forEach(([m, v, dec]) => {
      const o = a.createOscillator(), g = a.createGain();
      o.frequency.value = f * m;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol * v, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(g); g.connect(this.master); g.connect(this.wet);
      o.start(t); o.stop(t + dec + 0.05);
    });
  }
}

/* ------------------------------------------------------------------ live world rain (Open-Meteo) */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);

/* evenly spread points over the whole sphere, so the share of raining points
   estimates the share of Earth's surface where it is raining */
function fibPoints(n) {
  const pts = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i + 0.5) / n * 2;
    const lat = Math.asin(y) * 180 / Math.PI;
    let lon = ((i * ga) * 180 / Math.PI) % 360; if (lon > 180) lon -= 360;
    pts.push([Math.round(lat * 100) / 100, Math.round(lon * 100) / 100]);
  }
  return pts;
}
function isRaining(mm, code) {
  if (code != null && RAIN_CODES.has(code)) return true;
  return mm != null && mm >= 0.1 && !(code != null && SNOW_CODES.has(code));
}
async function fetchRainNow(n = RC.samplePoints) {
  const pts = fibPoints(n), out = [];
  for (let i = 0; i < pts.length; i += 80) {
    const chunk = pts.slice(i, i + 80);
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + chunk.map(p => p[0]).join(',') +
      '&longitude=' + chunk.map(p => p[1]).join(',') + '&current=precipitation,weather_code';
    const r = await fetch(url);
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : [j];
    chunk.forEach((p, k) => {
      const cur = arr[k] && arr[k].current;
      const mm = cur ? cur.precipitation : null, code = cur ? cur.weather_code : null;
      out.push([p[0], p[1], mm == null ? null : Math.round(mm * 10) / 10, code == null ? null : code]);
    });
  }
  const valid = out.filter(p => p[2] != null || p[3] != null);
  const raining = valid.filter(p => isRaining(p[2], p[3]));
  if (!valid.length) throw new Error('no data');
  return { t: Date.now(), n: valid.length, raining: raining.length,
           pct: Math.round(raining.length / valid.length * 1000) / 10, pts: out };
}
function cacheGet() {
  try { const s = JSON.parse(localStorage.getItem('rc_rain') || 'null'); return s && Date.now() - s.t < 45 * 60e3 ? s : null; }
  catch (e) { return null; }
}
function cacheSet(s) { try { localStorage.setItem('rc_rain', JSON.stringify(s)); } catch (e) {} }

/* ------------------------------------------------------------------ world map */
class WorldMap {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.land = null; this.snap = null; this.key = '';
    this._loadLand();
  }
  async _loadLand() {
    try {
      const r = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json');
      const topo = await r.json();
      this.land = topojson.feature(topo, topo.objects.land);
    } catch (e) { this.land = null; }
  }
  setSnapshot(s) { this.snap = s; }
  _fit(w, h) {
    const key = w + 'x' + h + (this.land ? 'L' : '');
    if (key === this.key) return;
    this.key = key;
    this.proj = d3.geoNaturalEarth1().fitExtent([[w * 0.04, h * 0.08], [w * 0.96, h * 0.92]], { type: 'Sphere' });
    this.path = d3.geoPath(this.proj, this.ctx);
  }
  draw(T, w, h, dpr) {
    if (!window.d3) return;
    const c = this.ctx;
    if (this.cv.width !== Math.round(w * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    this._fit(w, h);
    c.beginPath(); this.path({ type: 'Sphere' });
    c.strokeStyle = `rgba(${PAL.ink},0.12)`; c.lineWidth = 1; c.stroke();
    if (this.land) {
      c.beginPath(); this.path(this.land);
      c.fillStyle = `rgba(${PAL.ink},0.035)`; c.fill();
      c.strokeStyle = `rgba(${PAL.ink},0.42)`; c.lineWidth = 0.7; c.stroke();
    }
    if (!this.snap) return;
    c.globalCompositeOperation = PAL.comp;
    const scl = Math.max(0.6, w / 700);
    for (const [lat, lon, mm, code] of this.snap.pts) {
      const p = this.proj([lon, lat]); if (!p) continue;
      if (mm == null && code == null) continue;
      if (!isRaining(mm, code)) {
        c.fillStyle = `rgba(${PAL.ink},0.22)`;
        c.fillRect(p[0] - 0.6, p[1] - 0.6, 1.2, 1.2);
        continue;
      }
      const inten = clamp(0.35 + Math.sqrt(mm || 0.2) / 2.2, 0.35, 1);
      const glow = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], 16 * scl * inten);
      glow.addColorStop(0, `rgba(${PAL.ink},${0.3 * inten})`); glow.addColorStop(1, `rgba(${PAL.ink},0)`);
      c.fillStyle = glow; c.beginPath(); c.arc(p[0], p[1], 16 * scl * inten, 0, Math.PI * 2); c.fill();
      c.strokeStyle = `rgba(${PAL.ink},${0.8 * inten})`; c.lineWidth = 0.9;
      const seed = Math.round((lat + 90) * 1000 + lon * 7);
      c.beginPath();
      for (let k = 0; k < 6; k++) {
        const sx = p[0] + (hash(seed + k) - 0.5) * 14 * scl;
        const per = 0.6 + hash(seed + k + 9) * 0.6;
        const ph = ((T + hash(seed + k + 5) * per) % per) / per;
        const sy = p[1] - 10 * scl + ph * 16 * scl;
        c.moveTo(sx, sy); c.lineTo(sx - 0.8, sy + 4.5 * scl);
      }
      c.stroke();
    }
    c.globalCompositeOperation = 'source-over';
  }
}

function fmtTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}
