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

/* ------------------------------------------------------------------ rain renderer */
const LAYERS = [
  // far, fine rain
  { sp: 4.5, off: 0, speed: [520, 820], len: [8, 22], alpha: [0.07, 0.26], width: 0.8 },
  // near, bright streaks
  { sp: 9, off: 77777, speed: [900, 1350], len: [26, 70], alpha: [0.25, 0.8], width: 1.3 },
];
const RAIN_TOP = -600;    // world y where drops start

class RainRenderer {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = opts.scale || 1;          // screen px per world px
    this.view = { x: 0, y: 0 };            // world coords of the screen's top-left
    this.floor = null;                     // world y where drops land (null = none)
    this.density = 1;
    this.impulses = [];                    // wind / push fields (shared events)
    this.ripples = [];                     // taps
    this.flashes = [];                     // join flashes
    this.bright = 0;                       // extra glow after a join
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
  }
  get worldW() { return this.w / this.scale; }
  get worldH() { return this.h / this.scale; }

  addImpulse(e) { this.impulses.push(e); if (this.impulses.length > 60) this.impulses.shift(); }
  addRipple(e) { this.ripples.push(e); if (this.ripples.length > 40) this.ripples.shift(); }
  addFlash(e) { this.flashes.push(e); }

  /* displacement of a drop at world (x,y) from all live impulses */
  disp(x, y, T) {
    let dx = 0, dy = 0;
    for (const m of this.impulses) {
      const age = T - m.t;
      if (age < 0 || age > 2.6) continue;
      const env = age < 0.08 ? age / 0.08 : Math.exp(-(age - 0.08) * 1.7);
      const ex = x - m.x, ey = y - m.y;
      const d2 = ex * ex + ey * ey;
      const r2 = m.r * m.r;
      if (d2 > r2 * 6) continue;
      const f = Math.exp(-d2 / r2) * env;
      if (m.kind === 'radial') {
        const d = Math.sqrt(d2) + 1;
        dx += ex / d * m.s * f; dy += ey / d * m.s * f;
      } else {
        dx += m.dx * f; dy += m.dy * f;
      }
    }
    return [dx, dy];
  }

  draw(T) {
    const c = this.ctx, s = this.scale, vx = this.view.x, vy = this.view.y;
    const W = this.worldW, H = this.worldH;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    const g = c.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#02040a'); g.addColorStop(1, '#06101c');
    c.fillStyle = g; c.fillRect(0, 0, this.w, this.h);

    this.impulses = this.impulses.filter(m => T - m.t < 2.6);
    this.bright = Math.max(0, this.bright - 0.012);

    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    const floor = this.floor;
    const yMax = floor != null ? Math.min(vy + H, floor) : vy + H;
    const splashes = [];

    for (const L of LAYERS) {
      const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const i0 = Math.floor(vx / L.sp) - 3, i1 = Math.ceil((vx + W) / L.sp) + 3;
      for (let i = i0; i <= i1; i++) {
        const h0 = hash(i + L.off + 1000003);
        const x = i * L.sp + hash(i + L.off + 7) * L.sp * 0.8;
        const speed = lerp(L.speed[0], L.speed[1], hash(i + L.off + 11));
        const period = (0.45 + 1.7 * hash(i + L.off + 23)) / this.density;
        const phase = hash(i + L.off + 31) * period;
        const len = lerp(L.len[0], L.len[1], hash(i + L.off + 41));
        const alpha = lerp(L.alpha[0], L.alpha[1], h0);
        const b = Math.min(3, Math.floor(alpha / (L.alpha[1] + 0.001) * 4));
        const lo = vy - 20, hi = yMax + len + 40;
        let k1 = Math.floor((T - phase - (lo - RAIN_TOP) / speed) / period);
        let k0 = Math.ceil((T - phase - (hi - RAIN_TOP) / speed) / period);
        if (k1 - k0 > 24) k0 = k1 - 24;
        for (let k = k0; k <= k1; k++) {
          const yh = (T - (k * period + phase)) * speed + RAIN_TOP;
          if (floor != null && yh > floor) {
            const dt = (yh - floor) / speed;
            if (dt < 0.4 && L.off) splashes.push([x, floor, dt, alpha, i * 31 + k]);
            continue;
          }
          const yt = yh - len;
          const [hx, hy] = this.disp(x, yh, T);
          const [tx, ty] = this.disp(x, yt, T);
          buckets[b].moveTo((x + tx - vx) * s, (Math.min(yt + ty, floor ?? 1e9) - vy) * s);
          buckets[b].lineTo((x + hx - vx) * s, (Math.min(yh + hy, floor ?? 1e9) - vy) * s);
        }
      }
      c.lineWidth = L.width * Math.max(1, s * 0.8);
      for (let b = 0; b < 4; b++) {
        const a = Math.min(1, ((b + 1) / 4) * L.alpha[1] * (1 + this.bright));
        c.strokeStyle = `rgba(170,215,255,${a})`;
        c.stroke(buckets[b]);
      }
    }

    // splashes where drops hit the floor
    if (floor != null && floor < vy + H + 40) {
      c.strokeStyle = 'rgba(180,220,255,0.35)';
      c.lineWidth = 1;
      for (const [x, fy, dt, a] of splashes) {
        const r = 4 + dt * 40;
        c.globalAlpha = (1 - dt / 0.4) * a;
        c.beginPath();
        c.ellipse((x - vx) * s, (fy - vy) * s, r * s, r * 0.28 * s, 0, Math.PI, 2 * Math.PI);
        c.stroke();
      }
      c.globalAlpha = 1;
      const fg = c.createLinearGradient(0, (floor - vy) * s - 60, 0, (floor - vy) * s);
      fg.addColorStop(0, 'rgba(90,150,220,0)');
      fg.addColorStop(1, 'rgba(90,150,220,0.16)');
      c.fillStyle = fg;
      c.fillRect(0, (floor - vy) * s - 60, this.w, 60);
    }

    // ripples (taps)
    this.ripples = this.ripples.filter(r => T - r.t < 2.2);
    for (const r of this.ripples) {
      const age = T - r.t;
      if (age < 0) continue;
      const k = r.k || 1;
      for (let j = 0; j < 3; j++) {
        const a = age - j * 0.16;
        if (a <= 0) continue;
        const rad = a * 170 * k;
        const al = Math.max(0, 1 - a / 1.9) * 0.55;
        c.strokeStyle = `rgba(185,225,255,${al})`;
        c.lineWidth = (1.6 - j * 0.4) * Math.max(1, s * 0.8);
        c.beginPath();
        c.arc((r.x - vx) * s, (r.y - vy) * s, rad * s, 0, Math.PI * 2);
        c.stroke();
      }
      if (age < 0.9) {           // splash droplets
        c.fillStyle = `rgba(210,235,255,${(1 - age / 0.9) * 0.9})`;
        for (let n = 0; n < 12; n++) {
          const ang = hash(r.seed + n * 3) * Math.PI * 2;
          const sp = 90 + hash(r.seed + n * 3 + 1) * 220;
          const px = r.x + Math.cos(ang) * sp * age;
          const py = r.y + Math.sin(ang) * sp * age + 420 * age * age;
          c.beginPath(); c.arc((px - vx) * s, (py - vy) * s, 1.6 * Math.max(1, s * 0.8), 0, Math.PI * 2); c.fill();
        }
      }
    }

    // join flashes: a soft curtain of light spreading from the seam
    this.flashes = this.flashes.filter(f => T - f.t < 2.4);
    for (const f of this.flashes) {
      const age = T - f.t;
      if (age < 0) continue;
      const spread = age * 520;
      const al = Math.max(0, 1 - age / 2.4) * 0.35;
      for (const dir of [-1, 1]) {
        const x = (f.x + dir * spread - vx) * s;
        const gr = c.createLinearGradient(x - 70 * s, 0, x + 70 * s, 0);
        gr.addColorStop(0, 'rgba(120,190,255,0)');
        gr.addColorStop(0.5, `rgba(150,210,255,${al})`);
        gr.addColorStop(1, 'rgba(120,190,255,0)');
        c.fillStyle = gr;
        c.fillRect(x - 70 * s, 0, 140 * s, this.h);
      }
    }
    c.globalCompositeOperation = 'source-over';
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
    c.strokeStyle = 'rgba(120,170,230,0.12)'; c.lineWidth = 1; c.stroke();
    if (this.land) {
      c.beginPath(); this.path(this.land);
      c.fillStyle = 'rgba(40,80,130,0.16)'; c.fill();
      c.strokeStyle = 'rgba(140,195,255,0.45)'; c.lineWidth = 0.7; c.stroke();
    }
    if (!this.snap) return;
    c.globalCompositeOperation = 'lighter';
    const scl = Math.max(0.6, w / 700);
    for (const [lat, lon, mm, code] of this.snap.pts) {
      const p = this.proj([lon, lat]); if (!p) continue;
      if (mm == null && code == null) continue;
      if (!isRaining(mm, code)) {
        c.fillStyle = 'rgba(120,160,210,0.22)';
        c.fillRect(p[0] - 0.6, p[1] - 0.6, 1.2, 1.2);
        continue;
      }
      const inten = clamp(0.35 + Math.sqrt(mm || 0.2) / 2.2, 0.35, 1);
      const glow = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], 16 * scl * inten);
      glow.addColorStop(0, `rgba(120,190,255,${0.32 * inten})`); glow.addColorStop(1, 'rgba(120,190,255,0)');
      c.fillStyle = glow; c.beginPath(); c.arc(p[0], p[1], 16 * scl * inten, 0, Math.PI * 2); c.fill();
      c.strokeStyle = `rgba(200,230,255,${0.75 * inten})`; c.lineWidth = 0.9;
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
