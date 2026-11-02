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
 * Each "drop" is a bundle of fine strands that sways as it falls and fans out
 * behind its head like ink threads in water. Everything is a deterministic
 * function of world position + shared time, so strands continue across phones.
 * Default: white light on black.  ?ink : black ink on white paper. */
const INK = new URLSearchParams(location.search).has('ink');
const PAL = INK
  ? { bg: '244,243,240', ink: '12,12,14', comp: 'source-over', fade: 0.24 }
  : { bg: '4,4,5', ink: '236,237,240', comp: 'lighter', fade: 0.26 };
if (INK) document.documentElement.classList.add('ink');
const RAIN_TOP = -600;     // world y where drops start
const LANE = 16;           // world px between strand lanes
const TAIL = 18;           // samples per strand
const TAIL_DT = 0.05;      // seconds between tail samples

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
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = `rgba(${PAL.bg},${this.fresh ? 1 : PAL.fade})`;      // soft persistence = smoky trails
    c.fillRect(0, 0, this.w, this.h);
    this.fresh = false;
    this.impulses = this.impulses.filter(m => T - m.t < 3);
    this.bright = Math.max(0, this.bright - 0.01);
    const boost = 1 + this.bright * 0.6;

    c.globalCompositeOperation = PAL.comp;
    c.lineCap = 'round'; c.lineJoin = 'round';
    const floor = this.floor;
    const yMax = floor != null ? Math.min(vy + H, floor) : vy + H;
    const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const nodes = [], floorHits = [];

    // ---- strands: noise-driven ink threads; when phones are joined they converge into a river
    const river = this.river;                                       // {cy, since, speed} or null
    const rho = river ? clamp((T - river.since) / 2.5, 0, 1) : 0;    // river fades in after a join
    const grain = new Path2D();
    const smooth = (path, pts) => {                                  // curve through midpoints
      if (pts.length < 2) return;
      path.moveTo(pts[0][0], pts[0][1]);
      for (let q = 1; q < pts.length - 1; q++) {
        const mx = (pts[q][0] + pts[q + 1][0]) / 2, my = (pts[q][1] + pts[q + 1][1]) / 2;
        path.quadraticCurveTo(pts[q][0], pts[q][1], mx, my);
      }
      const e = pts[pts.length - 1]; path.lineTo(e[0], e[1]);
    };

    const i0 = Math.floor((vx - 160) / LANE), i1 = Math.ceil((vx + W + 160) / LANE);
    const reach = river ? river.speed * 3.4 * rho : 0;               // river carries strands sideways
    for (let i = i0 - Math.ceil(reach / LANE); i <= i1; i++) {
      const x0 = i * LANE + hash(i + 5) * LANE;
      const v = lerp(200, 430, hash(i + 11));
      const P = (1.3 + 2.4 * hash(i + 23)) / this.density;
      const ph = hash(i + 31) * P;
      const A = lerp(30, 110, hash(i + 41)), f1 = lerp(0.25, 0.7, hash(i + 43));
      const nb = 3 + Math.floor(hash(i + 61) * 4);
      const lum = 0.25 + 0.75 * hash(i + 67) * hash(i + 67);
      const lo = vy - 80, hi = (river ? Math.max(yMax, river.cy + v * 3.6) : yMax) + v * TAIL * TAIL_DT + 80;
      const k1 = Math.floor((T - ph - (lo - RAIN_TOP) / v) / P);
      let k0 = Math.ceil((T - ph - (hi - RAIN_TOP) / v) / P);
      if (k1 - k0 > 18) k0 = k1 - 18;
      for (let k = k0; k <= k1; k++) {
        const age = T - (k * P + ph);
        if (age < 0) continue;
        const ks = i * 977 + k * 131;
        const sx0 = hash(ks + 17) * 50;
        // where this drop is at time aa (strand b, tail fraction fan)
        const rainX = (aa, y, fan, b, ob, pb) =>
          x0 + A * fbm(aa * f1 + sx0, i * 0.37) * Math.min(1, aa * 0.7)
             + ob * (0.18 + 0.82 * Math.pow(fan, 1.5))
             + (0.35 + fan) * 20 * vnoise(aa * 1.6 + pb, b * 3.1 + ks * 0.01)
             + 12 * vnoise(y * 0.011 + b * 0.7 + pb, i * 0.29)
             + 30 * vnoise(y * 0.0035 + i * 0.13, T * 0.12);
        const joins = rho > 0 && hash(ks + 200) < 0.72;
        const entryY = river ? river.cy - 60 + (hash(ks + 201) - 0.5) * 50 : 0;
        const tEntry = (entryY - RAIN_TOP) / v;
        const yh = RAIN_TOP + v * age;
        let fadeOut = 0;
        if (joins) { fadeOut = Math.max(0, (age - tEntry) - 2.6); if (fadeOut > 0.9) continue; }
        if (floor != null && yh > floor && !(joins && rho > 0.5)) {
          const hit = (yh - floor) / v;
          if (hit < 1.6) floorHits.push([rainX((floor - RAIN_TOP) / v, floor, 0, 0, 0, 0), floor, hit, ks, lum]);
          if (yh - v * TAIL * TAIL_DT > floor) continue;
        }
        let head = null;
        for (let b = 0; b < nb; b++) {
          const ob = (hash(ks + b) - 0.5) * 70, pb = hash(ks + b + 7) * 9;
          let bucket = Math.min(3, Math.floor(lum * 4 * (0.6 + 0.4 * hash(ks + b + 3))));
          if (fadeOut > 0) bucket = Math.max(0, bucket - 1 - Math.floor(fadeOut * 3));
          const pts = [];
          for (let n = 0; n < TAIL; n++) {
            const aa = age - n * TAIL_DT;
            if (aa < 0) break;
            const fan = n / TAIL;
            let y = RAIN_TOP + v * aa;
            let x = rainX(aa, y, fan, b, ob, pb);
            if (joins && aa > tEntry) {
              // converge into the horizontal current and flow sideways across the screens
              const tin = aa - tEntry, ramp = 1 - Math.exp(-tin * 2.2);
              const xe = rainX(tEntry, entryY, fan, b, ob, pb);
              const D = 80;                                       // turn radius-ish: keeps the curve soft
              const rx = xe + river.speed * (tin - (1 - Math.exp(-tin / 0.55)) * 0.55)
                       + 34 * vnoise(tin * 0.7 + pb, ks * 0.01) * ramp;
              const spread = (hash(ks + b + 13) - 0.5) * 70 * ramp;
              const ry = entryY + D * (1 - Math.exp(-tin * v / D)) + spread * 0.5
                       + 22 * vnoise(rx * 0.006 + b * 1.7, T * 0.35 + ks * 0.003) * ramp;
              x = lerp(x, rx, rho); y = lerp(y, ry, rho);
            }
            if (floor != null) y = Math.min(y, floor);
            const [dx, dy] = this.disp(x, y, T);
            pts.push([(x + dx - vx) * s, (y + dy - vy) * s]);
            if (n === 0 && b === 0) head = [x + dx, y + dy];
            if (n % 3 === 1 && hash(ks + b * 5 + n) < 0.5) {         // ink grain
              const gx = pts[pts.length - 1][0] + (hash(ks + n * 7 + b) - 0.5) * 8 * s;
              const gy = pts[pts.length - 1][1] + (hash(ks + n * 11 + b) - 0.5) * 8 * s;
              grain.rect(gx, gy, lw * 0.8, lw * 0.8);
            }
          }
          smooth(buckets[bucket], pts);
        }
        if (head && hash(ks + 99) < 0.28 && fadeOut === 0 && head[1] > vy - 20 && head[1] < vy + H + 20 && head[1] < (floor ?? 1e9)) {
          nodes.push([head[0], head[1], lum, hash(ks + 101) < 0.16]);
        }
      }
    }
    for (let b = 0; b < 4; b++) {
      c.strokeStyle = `rgba(${PAL.ink},${Math.min(1, (0.045 + b * 0.055) * boost)})`;
      c.lineWidth = lw * (0.55 + b * 0.18);
      c.stroke(buckets[b]);
    }
    c.fillStyle = `rgba(${PAL.ink},0.18)`;
    c.fill(grain);

    // glowing heads; a few become stippled "orbit" spheres with a faint plumb line
    for (const [x, y, lum, sphere] of nodes) {
      const [sx, sy] = this._toScreen(x, y);
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, 9 * s);
      g.addColorStop(0, `rgba(${PAL.ink},${0.35 * lum * boost})`); g.addColorStop(1, `rgba(${PAL.ink},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(sx, sy, 9 * s, 0, 6.283); c.fill();
      c.fillStyle = `rgba(${PAL.ink},${0.9 * lum})`;
      c.beginPath(); c.arc(sx, sy, 1.3 * lw, 0, 6.283); c.fill();
      if (sphere) {
        for (let q = 0; q < 26; q++) {
          const th = hash(q * 7 + Math.floor(x)) * 6.283, ph2 = Math.acos(2 * hash(q * 11 + Math.floor(y)) - 1);
          c.fillRect(sx + Math.cos(th) * Math.sin(ph2) * 6 * s, sy + Math.cos(ph2) * 6 * s, lw * 0.9, lw * 0.9);
        }
        if (floor != null) {
          c.strokeStyle = `rgba(${PAL.ink},0.06)`; c.lineWidth = lw * 0.6;
          c.beginPath(); c.moveTo(sx, sy + 7 * s); c.lineTo(sx, (floor - vy) * s); c.stroke();
        }
      }
    }

    // where strands reach the floor they spread out like ink touching water
    for (const [x, fy, age, seed, lum] of floorHits) {
      this._bloom(c, x, fy, age, seed, { n: 9, life: 1.6, speed: [30, 110], flat: 0.22, sink: 0, alpha: 0.22 * lum, lw });
    }
    if (floor != null && floor < vy + H + 40) {
      const fy = (floor - vy) * s;
      const g = c.createLinearGradient(0, fy - 50, 0, fy);
      g.addColorStop(0, `rgba(${PAL.ink},0)`); g.addColorStop(1, `rgba(${PAL.ink},0.05)`);
      c.fillStyle = g; c.fillRect(0, fy - 50, this.w, 50);
    }

    // taps: ink blooms
    this.ripples = this.ripples.filter(r => T - r.t < 3.2);
    for (const r of this.ripples) {
      const age = T - r.t; if (age < 0) continue;
      const k = r.k || 1;
      this._bloom(c, r.x, r.y, age, r.seed || 1, { n: 40, life: 3.2, speed: [60 * k, 260 * k], flat: 1, sink: 26, alpha: 0.42, lw, core: true });
    }

    // joins: a luminous orbit thread drawn across the connected screens
    this.flashes = this.flashes.filter(f => T - f.t < 5);
    for (const f of this.flashes) {
      const age = T - f.t; if (age < 0) continue;
      this._orbit(c, f, age, lw);
    }
    c.globalCompositeOperation = 'source-over';
  }

  _bloom(c, x, y, age, seed, o) {
    const fade = Math.pow(Math.max(0, 1 - age / o.life), 1.4);
    if (fade <= 0) return;
    const s = this.scale;
    const path = new Path2D();
    for (let j = 0; j < o.n; j++) {
      const th = hash(seed + j * 5) * 6.283;
      const sp = lerp(o.speed[0], o.speed[1], hash(seed + j * 5 + 1));
      const curl = (hash(seed + j * 5 + 2) - 0.5) * 3.4;
      const wob = hash(seed + j * 5 + 3) * 6.283;
      for (let n = 0; n <= 10; n++) {
        const u = age * n / 10;
        const rad = sp * (1 - Math.exp(-2.4 * u)) / 2.4;
        const ang = th + curl * u;
        const w = Math.sin(u * 7 + wob) * 5 * u;
        const px = x + Math.cos(ang) * rad - Math.sin(ang) * w;
        const py = y + (Math.sin(ang) * rad + Math.cos(ang) * w) * o.flat + o.sink * u * u;
        const sx = (px - this.view.x) * s, sy = (py - this.view.y) * s;
        if (n === 0) path.moveTo(sx, sy); else path.lineTo(sx, sy);
      }
    }
    c.strokeStyle = `rgba(${PAL.ink},${o.alpha * fade})`;
    c.lineWidth = o.lw * 0.7;
    c.stroke(path);
    if (o.core) {
      const [sx, sy] = this._toScreen(x, y);
      const R = (24 + 40 * age) * s;
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, R);
      g.addColorStop(0, `rgba(${PAL.ink},${0.5 * fade})`); g.addColorStop(0.35, `rgba(${PAL.ink},${0.16 * fade})`); g.addColorStop(1, `rgba(${PAL.ink},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(sx, sy, R, 0, 6.283); c.fill();
    }
  }

  _orbit(c, f, age, lw) {
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
      c.strokeStyle = `rgba(${PAL.ink},${a * fade})`; c.lineWidth = w * lw; c.stroke(path);
    });
    for (const u of [0.18, 0.5, 0.82]) {
      if (u > reveal) continue;
      const [x, y] = this._toScreen(...pt(u));
      c.fillStyle = `rgba(${PAL.ink},${0.85 * fade})`;
      for (let q = 0; q < 40; q++) {
        const th = hash(q * 13 + sd) * 6.283, ph = Math.acos(2 * hash(q * 17 + sd) - 1), r = 9 * this.scale;
        c.fillRect(x + Math.cos(th) * Math.sin(ph) * r, y + Math.cos(ph) * r, lw, lw);
      }
    }
    const [hx, hy] = this._toScreen(...pt(reveal));
    const g = c.createRadialGradient(hx, hy, 0, hx, hy, 18 * lw);
    g.addColorStop(0, `rgba(${PAL.ink},${0.9 * fade})`); g.addColorStop(1, `rgba(${PAL.ink},0)`);
    c.fillStyle = g; c.beginPath(); c.arc(hx, hy, 18 * lw, 0, 6.283); c.fill();
  }
}

/* ------------------------------------------------------------------ sound (Web Audio, no files) */
class RainSound {
  constructor() { this.ctx = null; this.amb = null; }
  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const a = this.ctx = new AC();
    this.master = a.createGain(); this.master.gain.value = 0.9; this.master.connect(a.destination);
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
    const lp2 = a.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 6500;
    this.amb = a.createGain(); this.amb.gain.value = 0;
    src.connect(hp); hp.connect(lp2); lp2.connect(this.amb); this.amb.connect(this.master);
    src.start();
    this.setRain(0.25);
    this._ticks();
  }
  /* overall rain loudness 0..1 (tied to how much of Earth is raining) */
  setRain(v) {
    this.level = v;
    if (this.amb) this.amb.gain.setTargetAtTime(0.18 + v * 0.6, this.ctx.currentTime, 1.5);
  }
  _ticks() {           // sparse droplet ticks on top of the hiss
    const a = this.ctx;
    const go = () => {
      if (a.state === 'running') {
        const n = 1 + Math.floor(Math.random() * 3 * (0.4 + (this.level || 0.2)));
        for (let k = 0; k < n; k++) this.plip(Math.random(), 0.04 + Math.random() * 0.05, a.currentTime + Math.random() * 0.25, 1800 + Math.random() * 2500);
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
