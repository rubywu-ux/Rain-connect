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
 * The rain is a field of "plumes": petal-shaped sheets of fine dotted filaments that bloom
 * from a point, breathe, and dissolve, while their sparkling rims fall as drops. Dots flow
 * along every filament. Everything is a deterministic function of world position + shared
 * time, so plumes continue across phones placed side by side.
 * Default: white light on black.  ?ink : black ink on white paper. */
/* the theme: fog (pale ground, grey ink) or night (light on black). A choice made on this screen is kept
   (localStorage rc_theme); otherwise ?dark / ?ink from the URL; otherwise fog. */
let INK = (() => {
  try { const t = localStorage.getItem('rc_theme'); if (t === 'fog') return true; if (t === 'dark') return false; } catch (e) {}
  const p = new URLSearchParams(location.search);
  return p.has('dark') ? false : true;
})();
const PAL_DARK = { bg: '4,4,5', bg2: '4,4,5', ink: '236,237,240', comp: 'lighter', fade: 0.26 };
const PAL_LIGHT = { bg: '232,235,234', bg2: '214,219,218', ink: '92,100,102', comp: 'source-over', fade: 0.24 };   // fog: milky, a touch cool, darker toward the floor
const PAL = Object.assign({}, INK ? PAL_LIGHT : PAL_DARK);
if (INK) document.documentElement.classList.add('ink');
/* switch the whole page between light (ink on paper) and dark (light on black) while it runs */
function setInk(on) {
  if (on === INK) return;
  INK = on; Object.assign(PAL, on ? PAL_LIGHT : PAL_DARK);
  document.documentElement.classList.toggle('ink', on);
  _spark = null;
  try { localStorage.setItem('rc_theme', on ? 'fog' : 'dark'); } catch (e) {}
  dispatchEvent(new Event('inkchange'));
}
/* one colour per phone (strands stay black & white; a person's touches carry their colour) */
const COLORS_LIGHT = ['168,88,92', '84,128,100', '86,110,158', '160,122,62', '126,102,160', '72,130,134', '172,110,86', '106,130,72'];
const COLORS_DARK = ['222,150,150', '152,194,162', '150,172,214', '220,188,132', '188,168,214', '140,194,194', '226,184,162', '174,194,142'];
function colorOf(i) { const C = INK ? COLORS_LIGHT : COLORS_DARK; return i == null ? PAL.ink : C[((i % C.length) + C.length) % C.length]; }
const PLUME_LANE = 380;    // world px between plume lanes
const PLUME_GAP = 15;      // seconds between plumes in one lane (divided by rain density)
const PLUME_LIFE = 24;     // seconds a plume lives (bloom -> breathe -> dissolve into rain)
const PLUME_DRIFT = 14;    // world px/s a plume sinks while it lives
const PLUME_SEG = 14;      // samples per filament
const PLUME_DROPS = 34;    // drops released over a plume's life
const DRIZZLE_LANE = 26;   // fine background rain
const RIVER_LINES = 26;    // filaments in the river when phones are joined
function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
let _spark = null;         // soft glow sprite for the brightest sparkles
/* the people under the umbrellas: 0 walkers (head, shoulders, legs), 1 ghosts (soft light, no edges). V on the wall, ?fig=N. */
const FIGS = ['walkers', 'ghosts'];
let FIG = (() => { try { const v = new URLSearchParams(location.search).get('fig'); if (v != null) return clamp(+v | 0, 0, FIGS.length - 1); } catch (e) {} return 0; })();
function setFig(n) { FIG = clamp(n | 0, 0, FIGS.length - 1); try { localStorage.setItem('rc_fig', String(FIG)); } catch (e) {} dispatchEvent(new CustomEvent('figchange', { detail: FIG })); }
/* the ground: PAL.bg at the top shading to PAL.bg2 at the floor, at a given opacity */
function fogFill(c, w, h, a) {
  if (PAL.bg2 === PAL.bg) { c.fillStyle = `rgba(${PAL.bg},${a})`; c.fillRect(0, 0, w, h); return; }
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, `rgba(${PAL.bg},${a})`); g.addColorStop(1, `rgba(${PAL.bg2},${a})`);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
}
function sparkSprite() {
  if (_spark) return _spark;
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, `rgba(${PAL.ink},1)`); gr.addColorStop(0.16, `rgba(${PAL.ink},0.85)`);
  gr.addColorStop(0.42, `rgba(${PAL.ink},0.16)`); gr.addColorStop(1, `rgba(${PAL.ink},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return (_spark = cv);
}

class RainRenderer {
  constructor(canvas, opts = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = opts.scale || 1;          // screen px per world px
    this.detail = opts.detail || 1;        // fraction of filaments to draw (big screens can use fewer)
    this.sites = null;                     // real raining places [{id,x,y,k}] (the wall) instead of lanes
    this.presence = 1;                     // 0..1: how much rain is showing (the wall's calm weather fades it out)
    this.memory = null;                    // stain layer: where it has rained
    this.view = { x: 0, y: 0 };            // world coords of the screen's top-left
    this.floor = null;                     // world y where drops land (null = none)
    this.tiltX = 0; this.tiltY = 0;        // the phone's tilt (-1..1), set by the page; the plumes lean into it slowly, like a lava lamp
    this._tx = 0; this._ty = 0; this._tiltT = null;
    this.density = 1;
    this.impulses = [];                    // drag / push fields (shared events)
    this.ripples = [];                     // taps -> ink blooms
    this.flashes = [];                     // joins -> orbit threads
    this.river = null;                     // {cy, since, speed} while phones are joined
    this.trails = [];                      // coloured glints along drags
    this.bolts = [];                       // lightning strikes
    this.storm = 0;                        // 0..1, shared: how many people are blowing
    this.bright = 0;
    this.art = false; this.artIdx = 0;     // the wall's art modes (see _drawArt)
    this.snapPts = null;                   // the wall: every sample point [lat, lon, mm, code], for the art modes
    this.mistW = 0; this.mistE = 0;        // the wall: mist weather 0..1 and how hard the mist is moving right now 0..1
    this.mistX = 0; this.mistY = 0;        // the wall: where in the pot the mist moves, -1..1
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
    if (this.art) return this._drawArt(T);
    const c = this.ctx, s = this.scale, vx = this.view.x, vy = this.view.y;
    const W = this.worldW, H = this.worldH, lw = Math.max(1, s * 0.75);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    fogFill(c, this.w, this.h, this.fresh ? 1 : (this.fade || PAL.fade));           // soft persistence = smoky trails
    const und = this._under();            // the faint world + the stains where it has rained, in one layer
    if (und) {
      c.save();
      c.globalAlpha = INK ? 0.3 : 0.16;   // with the frame fade this settles at about 0.6 x the layer (the fog shows its land more)
      c.globalCompositeOperation = INK ? 'source-over' : 'lighter';
      c.drawImage(und, 0, 0, this.w, this.h);
      c.restore();
    }
    this.fresh = false;
    if (this.haze) { c.globalCompositeOperation = PAL.comp; const hz = c.createLinearGradient(0, 0, 0, this.h * 0.55); hz.addColorStop(0, `rgba(${PAL.ink},${this.haze})`); hz.addColorStop(1, `rgba(${PAL.ink},0)`); c.fillStyle = hz; c.fillRect(0, 0, this.w, this.h * 0.55); c.globalCompositeOperation = 'source-over'; }
    this.impulses = this.impulses.filter(m => T - m.t < 3);
    this.bright = Math.max(0, this.bright - 0.01);
    { const dtt = this._tiltT == null ? 0.016 : clamp(T - this._tiltT, 0, 0.1), kk = 1 - Math.exp(-dtt * 1.1);   // viscous: it takes a second or two to settle
      this._tiltT = T; this._tx += (this.tiltX - this._tx) * kk; this._ty += (this.tiltY - this._ty) * kk; }
    const tx = this._tx, ty = this._ty;
    const boost = (1 + this.bright * 0.6) * (this.breathe ? 0.9 + 0.1 * Math.sin(T * 6.283 / 26) : 1);   // the rain's slow breath

    c.globalCompositeOperation = PAL.comp;
    c.lineCap = 'round'; c.lineJoin = 'round';
    const floor = this.floor;
    const yMax = floor != null ? Math.min(vy + H, floor) : vy + H;
    // ---- plumes: fans of fine dotted filaments that bloom from a point, breathe,
    //      and let their sparkling tips fall as rain. When phones join, they bend
    //      into one horizontal river that flows across every screen.
    const river = this.river, storm = this.storm, dens = this.density;
    const rho = river ? clamp((T - river.since) / 2.5, 0, 1) : 0;    // river fades in after a join
    const fib = [new Path2D(), new Path2D(), new Path2D()];           // dim / mid / bright filaments
    const sparks = [], glows = [], streaks = [], floorHits = [];
    const smooth = (path, pts) => {                                  // curve through midpoints
      if (pts.length < 2) return;
      path.moveTo(pts[0][0], pts[0][1]);
      for (let q = 1; q < pts.length - 1; q++) {
        const mx = (pts[q][0] + pts[q + 1][0]) / 2, my = (pts[q][1] + pts[q + 1][1]) / 2;
        path.quadraticCurveTo(pts[q][0], pts[q][1], mx, my);
      }
      const e = pts[pts.length - 1]; path.lineTo(e[0], e[1]);
    };
    const yBot = vy + H + 40, yLand = floor != null ? floor : 1e9;
    // plumes come from lanes (phones), or one per real place where it is raining (the wall: this.sites)
    const sites = this.sites;
    const i0 = Math.floor((vx - 620) / PLUME_LANE), i1 = Math.ceil((vx + W + 620) / PLUME_LANE);
    const nLanes = sites ? sites.length : i1 - i0 + 1;
    for (let li = 0; li < nLanes; li++) {
      const site = sites ? sites[li] : null, i = site ? site.id : i0 + li;
      // a raining place keeps blooming in the same spot: one plume follows the next, a little overlapping
      const Pi = site ? PLUME_LIFE * 0.92 * (0.85 + 0.3 * hash(i + 3)) / Math.max(0.03, dens) : PLUME_GAP * (0.8 + 0.5 * hash(i + 3)) / dens;
      const ph = hash(i + 7) * Pi;
      const kHi = Math.floor((T - ph) / Pi), kLo = Math.ceil((T - ph - PLUME_LIFE - 5) / Pi);
      for (let k = kLo; k <= kHi; k++) {
        const pl = this._plume(i, k, Pi, ph, site);
        const a = T - pl.tb;
        if (a < 0) continue;
        if (site && this.memory && !this.hideUnder && this.presence > 0.3 && a > PLUME_LIFE - 4 && !pl.stamped) { pl.stamped = true; this._stamp(pl, T); }
        // where the plume is now: a rough box test before doing any real work
        const ry = pl.ry0 + pl.drift * a;
        if (pl.rx + 640 < vx || pl.rx - 640 > vx + W || ry - 80 > yBot) continue;
        const alive = a < PLUME_LIFE;
        const dis = smoothstep(PLUME_LIFE - 7, PLUME_LIFE, a);       // dissolving: filaments thin out from the root
        const joins = rho > 0 && pl.joinable && ry < river.cy - 60;
        if (alive) {
          for (const lb of pl.lobes) {
            const nf = Math.max(5, Math.round(lb.nf * this.detail));
            for (let f = 0; f < nf; f++) {
              const q = f / (nf - 1) * 2 - 1;
              const fs = lb.seed + f * 7;
              if (hash(fs + 1) < dis * 1.15) continue;              // this filament has already let go
              const lum = lb.lum * (0.55 + 0.45 * hash(fs + 2)) * (1 - 0.6 * q * q * hash(fs + 3));
              const bucket = lum > 0.62 ? 2 : lum > 0.36 ? 1 : 0;
              const wp = this._fiber(pl, lb, q, fs, T, this._tmp || (this._tmp = []));
              const pts = [];
              for (let n = 0; n < wp.length; n++) {
                let [x, y] = wp[n];
                if (joins) {                                          // swept sideways where it reaches the river
                  const top = river.cy - 34, ex = y - top;
                  if (ex > 0) { y = top + ex * (1 - 0.72 * rho); x += Math.sign(river.speed) * ex * 1.5 * rho; }
                }
                if (y > yLand) y = yLand;
                const [dx, dy] = this.disp(x, y, T);
                pts.push([(x + dx - vx) * s, (y + dy - vy) * s]);
              }
              let on = false;                                         // skip filaments entirely off this screen
              for (const [px, py] of pts) if (px > -24 && px < this.w + 24 && py > -24 && py < this.h + 24) { on = true; break; }
              if (!on) continue;
              const cut = Math.round(PLUME_SEG * 0.55);                // brighter toward the rim
              smooth(fib[Math.max(0, bucket - 1)], pts.slice(0, cut + 1));
              smooth(fib[bucket], pts.slice(cut));
              // sparkle dust that gathers at the filament tips (and a little along the rim)
              const e = pts[pts.length - 1], e2 = pts[pts.length - 3];
              if (e[1] < -30 || e[1] > this.h + 30 || e[0] < -30 || e[0] > this.w + 30) continue;
              const ux = e[0] - e2[0], uy = e[1] - e2[1], ul = Math.hypot(ux, uy) || 1;
              for (let m = 0; m < 3; m++) {
                const hs = fs * 13 + m * 101;
                const out = (hash(hs) * hash(hs) * 26 - 4) * s, side = (hash(hs + 1) - 0.5) * 12 * s;
                const tw = 0.5 + 0.5 * Math.sin(T * (1.5 + 2.5 * hash(hs + 2)) + hash(hs + 3) * 6.28);
                const al = lum * (0.35 + 0.65 * tw) * (1 - dis * 0.5);
                const px = e[0] + (ux / ul) * out - (uy / ul) * side, py = e[1] + (uy / ul) * out + (ux / ul) * side;
                if (hash(hs + 4) < 0.035) glows.push([px, py, al]); else sparks.push([px, py, al, hash(hs + 5) < 0.3 ? 1.6 : 1]);
              }
            }
          }
        }
        // rain: tips release glittering drops that fall (more as the plume dissolves, more in a storm)
        const nd = Math.round(PLUME_DROPS * dens * (1 + storm * 1.5) * (site ? 0.4 + 0.8 * site.k : 1));
        for (let j = 0; j < nd; j++) {
          const ds = pl.seed * 3 + j * 17;
          const tr = pl.tb + 2.5 + Math.sqrt(hash(ds)) * (PLUME_LIFE - 2.5);   // skewed toward the end of life
          const dt = T - tr;
          if (dt < 0 || dt > 4.5) continue;
          const lb = pl.lobes[Math.floor(hash(ds + 1) * pl.lobes.length)];
          const q = hash(ds + 2) * 2 - 1;
          const tip = this._fiber(pl, lb, q, lb.seed, tr, this._tmp2 || (this._tmp2 = [])), [x0, y0] = tip[tip.length - 1];
          const g = 320 + 120 * hash(ds + 3);
          let y = y0 + 24 * dt + 0.5 * g * dt * dt;
          const x = x0 + (hash(ds + 4) - 0.5) * 14 * dt + (storm * 90 + tx * 140) * dt * dt;   // drops drift to the low side of a tilted phone
          if (y > yLand) {                                            // landed: a small splash on the floor
            const hit = (y - yLand) / (24 + g * dt);
            if (hit < 1.2) floorHits.push([x, yLand, hit, ds, 0.7]);
            continue;
          }
          if (y < vy - 20 || y > yBot) continue;
          const vyv = 24 + g * dt, len = Math.min(26, vyv * 0.045);
          const [sx, sy] = [(x - vx) * s, (y - vy) * s];
          const al = 0.75 * (0.6 + 0.4 * hash(ds + 5));
          sparks.push([sx, sy, al, 1.3]);
          if (len > 3) streaks.push([sx, sy, len * s, al]);
        }
      }
    }
    // a whisper of fine rain behind everything
    const nl = Math.ceil(W / DRIZZLE_LANE) + 2, d0 = Math.floor(vx / DRIZZLE_LANE);
    for (let i = d0; i < d0 + nl; i++) {
      const v = 380 + 260 * hash(i * 3 + 1), P = (2.2 + 3 * hash(i * 3 + 2)) / (dens * (1 + storm)), ph = hash(i * 3 + 5) * P;
      const span = (yBot + 200) / v + 0.3;
      for (let k = Math.floor((T - ph) / P); k * P + ph > T - span; k--) {
        const age = T - (k * P + ph), y = -200 + v * age;
        if (y > yLand || y < vy - 40) continue;
        const x = i * DRIZZLE_LANE + hash(i * 31 + k) * DRIZZLE_LANE + (storm * 0.12 + tx * 0.2) * (y - vy);
        streaks.push([(x - vx) * s, (y - vy) * s, (14 + 16 * hash(i + k * 7)) * s, 0.16 + 0.12 * hash(k * 5 + i)]);
      }
    }

    // draw: a faint silk line under each filament, then the same filament as flowing dots
    const flow = -(T * (16 + 40 * storm)) * s;
    const pres = this.presence;                                       // 0 = the rain has stopped (fades smoothly)
    c.globalAlpha = pres;
    c.setLineDash([]); c.lineCap = 'round'; c.lineJoin = 'round';
    const strandQ = INK ? 0.5 : 0.7, pointQ = INK ? 1.7 : 1;           // soft strands in both themes (quietest in the fog), firm points
    for (let b = 0; b < 3; b++) {                                     // each strand bleeds: a wide faint pass, then a thin one
      const a = Math.min(1, (0.11 + b * 0.15) * boost * strandQ);
      c.strokeStyle = `rgba(${PAL.ink},${(a * 0.16).toFixed(3)})`; c.lineWidth = lw * 3.4; c.stroke(fib[b]);
      c.strokeStyle = `rgba(${PAL.ink},${(a * 0.55).toFixed(3)})`; c.lineWidth = lw * 0.9; c.stroke(fib[b]);
    }
    c.globalAlpha = 1;
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
          pts.push([(x + dx - vx) * s, (y + dy - vy) * s]);
        }
        smooth(paths[hash(j + 900) < 0.35 ? 1 : 0], pts);
      }
      const ro = (xs - T * river.speed) * s;                          // same dot phase on every phone
      [[0, 0.14], [1, 0.32]].forEach(([b, al]) => {                  // the current, as soft bleeding lines
        c.strokeStyle = `rgba(${PAL.ink},${(0.12 * al * rho * boost).toFixed(3)})`; c.lineWidth = lw * 3.6; c.stroke(paths[b]);
        c.strokeStyle = `rgba(${PAL.ink},${(0.5 * al * rho * boost).toFixed(3)})`; c.lineWidth = lw; c.stroke(paths[b]);
      });
      for (let j = 0; j < 70; j++) {                                  // glitter drifting along the current
        const sp = river.speed * (0.7 + 0.6 * hash(j + 40)), span = W + 400;
        const x = vx - 200 + ((((hash(j + 41) * span + T * sp - vx) % span) + span) % span);
        const y = river.cy + (hash(j + 42) - 0.5) * 110 + 20 * vnoise(x * 0.004, j);
        const tw = 0.5 + 0.5 * Math.sin(T * 3 + j);
        sparks.push([(x - vx) * s, (y - vy) * s, 0.7 * rho * tw, hash(j + 43) < 0.3 ? 1.6 : 1]);
      }
    }
    // falling streaks and sparkles, batched into a few alpha levels (far fewer draw calls)
    const SL = 4, sp = [], st = [];
    for (let k = 0; k < SL; k++) { sp.push(new Path2D()); st.push(new Path2D()); }
    const lvl = al => Math.min(SL - 1, Math.floor(clamp(al * boost, 0, 0.999) * SL));
    for (const [sx, sy, len, al] of streaks) { const p = st[lvl(al)]; p.moveTo(sx, sy - len); p.lineTo(sx, sy); }
    for (const [sx, sy, al0, r] of sparks) {
      const al = Math.min(1, al0 * pointQ); if (al <= 0.03) continue;
      const d = r * lw * 2.2; sp[lvl(al)].moveTo(sx + d / 2, sy); sp[lvl(al)].arc(sx, sy, d / 2, 0, 6.283);   // soft round glints
    }
    c.lineWidth = lw * 0.8;
    c.globalAlpha = pres;
    for (let k = 0; k < SL; k++) {
      const al = (k + 0.5) / SL;
      c.strokeStyle = `rgba(${PAL.ink},${al * 0.45})`; c.stroke(st[k]);
      c.fillStyle = `rgba(${PAL.ink},${al})`; c.fill(sp[k]);
    }
    const spr = sparkSprite();
    for (const [sx, sy, al] of glows) {
      c.globalAlpha = Math.min(1, al * boost * pointQ) * pres;
      c.drawImage(spr, sx - 7 * lw, sy - 7 * lw, 14 * lw, 14 * lw);
    }
    c.globalAlpha = 1;

    // where drops reach the floor they spread out like ink touching water
    for (const [x, fy, age, seed, lum] of floorHits) {
      this._drop(c, x, fy, age * 1.6, seed, { k: 0.45, alpha: 0.22 * lum, lw, soft: true });
    }
    if (floor != null && floor < vy + H + 40) {
      const fy = (floor - vy) * s;
      const g = c.createLinearGradient(0, fy - 50, 0, fy);
      g.addColorStop(0, `rgba(${PAL.ink},0)`); g.addColorStop(1, `rgba(${PAL.ink},0.05)`);
      c.fillStyle = g; c.fillRect(0, fy - 50, this.w, 50);
    }

    // taps: a drop landing on water, rings of dots widening in the tapper's colour
    this.ripples = this.ripples.filter(r => T - r.t < 3.2);
    for (const r of this.ripples) {
      const age = T - r.t; if (age < 0) continue;
      this._drop(c, r.x, r.y, age, r.seed || 1, { k: r.k || 1, alpha: r.echo ? 0.4 : 0.8, lw, col: colorOf(r.c) });
    }

    // drags leave a trail of small drops that fall away in the dragger's colour
    this.trails = this.trails.filter(d => T - d.t < 1.6);
    if (this.trails.length) {
      const byCol = new Map();
      for (const d of this.trails) {
        const age = T - d.t; if (age < 0) continue;
        const [sx, sy] = this._toScreen(d.x, d.y);
        if (sx < -40 || sy < -40 || sx > this.w + 40 || sy > this.h + 40) continue;
        const a = Math.pow(1 - age / 1.6, 1.3), col = colorOf(d.c), sd = Math.round(d.x * 7 + d.y * 13);
        let P = byCol.get(col); if (!P) byCol.set(col, P = [new Path2D(), new Path2D(), new Path2D()]);
        for (let j = 0; j < 3; j++) {
          const f = hash(sd + j * 3), px = sx + (f - 0.5) * 10 * s, py = sy + age * (30 + 60 * hash(sd + j * 3 + 1)) * s, dd = (j ? 2.2 : 3) * lw;
          P[Math.min(2, Math.floor(a * 3))].moveTo(px + dd, py); P[Math.min(2, Math.floor(a * 3))].arc(px, py, dd, 0, 6.283);
        }
      }
      for (const [col, P] of byCol) P.forEach((p, i) => { c.fillStyle = `rgba(${col},${(0.18 + 0.16 * i).toFixed(2)})`; c.fill(p); });
    }

    // lightning: white bolts (same seed -> same bolt on every screen), with a brief sky flash
    this.bolts = this.bolts.filter(b => T - b.t < 1.2);
    for (const b of this.bolts) {
      const age = T - b.t; if (age < 0) continue;
      this._bolt(c, b, age, lw);
    }

    // the wall: thin the haze at the bottom a little (with the frame fade this settles at ~75%)
    if (this.bottomFade) {
      c.globalCompositeOperation = 'source-over';
      const g = c.createLinearGradient(0, this.h * 0.45, 0, this.h);
      g.addColorStop(0, `rgba(${PAL.bg},0)`); g.addColorStop(1, `rgba(${PAL.bg},${this.bottomFade})`);
      c.fillStyle = g; c.fillRect(0, this.h * 0.45, this.w, this.h * 0.55);
      c.globalCompositeOperation = PAL.comp;
    }
    // the wall: every raining place as a clear point, like the phone's map
    if (this.points && this.points.length && !this.hideUnder) {
      c.globalCompositeOperation = PAL.comp;
      for (const p of this.points) {
        if (p.k == null) continue;                                     // only where it rains
        const [sx, sy] = this._toScreen(p.x, p.y);
        if (sx < -30 || sx > this.w + 30 || sy < -30 || sy > this.h + 30) continue;
        const z = (14 + 22 * p.k) * lw;
        c.globalAlpha = (0.6 + 0.4 * p.k) * pres; c.drawImage(spr, sx - z / 2, sy - z / 2, z, z);
      }
      c.globalAlpha = 1;
    }

    // joins: a luminous orbit thread drawn across the connected screens
    this.flashes = this.flashes.filter(f => T - f.t < 5);
    for (const f of this.flashes) {
      const age = T - f.t; if (age < 0) continue;
      this._orbit(c, f, age, lw);
    }
    c.globalCompositeOperation = 'source-over';
  }

  /* one plume: a few overlapping fans ("lobes") of filaments sharing one root */
  _plume(i, k, Pi, ph, site) {
    const cache = this._pc || (this._pc = new Map()), key = (site ? 's' + site.k.toFixed(2) + ':' : '') + i + ':' + k;
    let p = cache.get(key);
    if (p) return p;
    if (cache.size > 500) cache.clear();
    const seed = (Math.imul(i, 977) + Math.imul(k, 131)) & 0xffffff;
    // a real place: heavier rain there = a bigger, brighter, fuller plume
    const sk = site ? site.k : 0;
    const nL = site ? 1 + Math.round(sk * 2.2 + hash(seed + 1) * 0.8) : 3 + Math.floor(hash(seed + 1) * 3);
    const lean = (hash(seed + 2) - 0.5) * 0.4, size = (site ? 0.3 + 0.62 * sk : 0.8 + 0.45 * hash(seed + 3)) * (site && site.big ? site.big : 1);
    const lobes = [];
    for (let m = 0; m < nL; m++) {
      const ls = (seed * 7 + m * 1013) & 0xffffff;
      lobes.push({
        seed: ls, th0: lean + (hash(ls + 1) - 0.5) * 1.5, S0: 0.42 + 0.4 * hash(ls + 2),
        bend: (hash(ls + 11) - 0.5) * 1.6, cup: 0.15 + 0.45 * hash(ls + 12),
        L0: size * (200 + 220 * hash(ls + 3)), nf: Math.round((22 + 16 * hash(ls + 4)) * (site ? 0.35 + 0.5 * sk : 1)),
        lum: (0.35 + 0.65 * hash(ls + 5)) * (site ? 0.4 + 0.4 * sk : 1), curl: 0.3 + 0.8 * hash(ls + 6),
        w1: 0.12 + 0.2 * hash(ls + 7), w2: 0.1 + 0.18 * hash(ls + 8),
        p1: hash(ls + 9) * 6.283, p2: hash(ls + 10) * 6.283,
      });
    }
    p = site
      ? { seed, lobes, tb: k * Pi + ph, joinable: false, drift: 3, site, size,
          rx: site.x + (hash(seed + 4) - 0.5) * 18, ry0: site.y - 10 * hash(seed + 5) }
      : { seed, lobes, tb: k * Pi + ph, joinable: hash(seed + 6) < 0.8, drift: PLUME_DRIFT,
          rx: i * PLUME_LANE + (hash(seed + 4) - 0.5) * PLUME_LANE * 0.9, ry0: -200 + hash(seed + 5) * 560 };
    cache.set(key, p);
    return p;
  }
  /* a stain where a plume's rain fell: a dried-drop ring of dots with a faint wash inside.
     Many plumes at one place over the day darken that place: the memory of where it rained. */
  _stamp(pl, T) {
    const m = this.memory, g = m.getContext('2d'), sx = m.width / this.w, sd = pl.seed;
    g.save(); g.globalCompositeOperation = 'lighter';
    const k = pl.site ? pl.site.k : 0.4, tip = [];
    for (const lb of pl.lobes) { const f = this._fiber(pl, lb, 0, lb.seed, T, tip); const e = f[f.length - 1]; this._ring(g, e[0], e[1], 4 + 9 * k * (0.7 + 0.6 * hash(lb.seed)), k, sd + lb.seed, sx); }
    g.restore();
    this.memoryDirty = true; this.memVer = (this.memVer || 0) + 1;
  }
  _ring(g, wx, wy, r, k, sd, sx) {
    const x = (wx - this.view.x) * this.scale * sx, y = (wy - this.view.y) * this.scale * sx, R = r * this.scale * sx;
    if (x < -R || y < -R || x > this.memory.width + R || y > this.memory.height + R) return;
    const wash = g.createRadialGradient(x, y, 0, x, y, R);
    wash.addColorStop(0, `rgba(255,255,255,${0.012 + 0.015 * k})`); wash.addColorStop(0.8, `rgba(255,255,255,${0.02 + 0.025 * k})`); wash.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = wash; g.beginPath(); g.arc(x, y, R, 0, 6.283); g.fill();
    g.fillStyle = `rgba(255,255,255,${0.1 + 0.14 * k})`;
    const n = Math.round(12 + 26 * k);
    for (let q = 0; q < n; q++) {                       // the ring: dots crowd at the edge, like a dried raindrop
      const th = hash(sd + q * 3) * 6.283, rr = R * (0.82 + 0.22 * hash(sd + q * 3 + 1)) * (1 + 0.12 * Math.sin(th * 3 + sd));
      const d = 0.6 + 1.1 * hash(sd + q * 3 + 2);
      g.fillRect(x + Math.cos(th) * rr, y + Math.sin(th) * rr, d, d);
    }
    for (let q = 0; q < 3 + 6 * k; q++) {               // a few splashes flung outside it
      const th = hash(sd + 500 + q) * 6.283, rr = R * (1.2 + 0.9 * hash(sd + 600 + q));
      g.fillRect(x + Math.cos(th) * rr, y + Math.sin(th) * rr, 1.2, 1.2);
    }
  }
  /* ghost map + memory, tinted for the current theme; rebuilt only when either changes */
  _under() {
    if ((!this.ghost && !this.memory) || this.hideUnder) return null;
    const src = this.memory || this.ghost, key = (this.memVer || 0) + ':' + (this.ghostVer || 0) + ':' + INK + ':' + src.width;
    if (this._und && this._undKey === key) return this._und;
    const u = this._und || document.createElement('canvas');
    u.width = src.width; u.height = src.height;
    const g = u.getContext('2d');
    g.clearRect(0, 0, u.width, u.height);
    if (this.ghost) { g.globalAlpha = INK ? 0.2 : 0.22; g.drawImage(this.ghost, 0, 0, u.width, u.height); g.globalAlpha = 1; }
    if (this.memory) g.drawImage(this.memory, 0, 0, u.width, u.height);
    g.globalCompositeOperation = 'source-in'; g.fillStyle = `rgb(${PAL.ink})`; g.fillRect(0, 0, u.width, u.height);
    g.globalCompositeOperation = 'source-over';
    this._und = u; this._undKey = key;
    return u;
  }
  /* the memory canvas (half resolution); kept between reloads by the page that owns it */
  enableMemory() {
    if (this.memory) return this.memory;
    const m = document.createElement('canvas'); m.width = Math.round(this.w / 2); m.height = Math.round(this.h / 2);
    this.memory = m; return m;
  }
  /* slowly forget: everything fades a little (called every few minutes) */
  fadeMemory(f = 0.03) {
    if (!this.memory) return;
    const g = this.memory.getContext('2d');
    g.save(); g.globalCompositeOperation = 'destination-out'; g.fillStyle = `rgba(0,0,0,${f})`; g.fillRect(0, 0, this.memory.width, this.memory.height); g.restore();
    this.memoryDirty = true; this.memVer = (this.memVer || 0) + 1;
  }
  /* the whole filament q (-1..1) of a lobe at time Tq, as world points root -> tip.
     A lobe is a sheet of filaments laid along one flowing S-shaped spine: tight at the root,
     flaring like a ginkgo leaf, with the outer filaments rolling back at the rim. */
  _fiber(pl, lb, q, fs, Tq, out) {
    const a = Tq - pl.tb, g = smoothstep(0, 5, a), st = this.storm, tx = this._tx || 0, ty = this._ty || 0;
    const rx = pl.rx, ry = pl.ry0 + pl.drift * a;
    // a tilted phone: the plumes lean toward its low side and stretch toward the person, slowly (see draw)
    const th = lb.th0 + 0.14 * Math.sin(Tq * lb.w1 + lb.p1) + st * 0.5 * (0.75 + 0.25 * Math.sin(Tq * 1.3 + lb.p2)) + tx * 0.6;
    const bend = lb.bend * (0.75 + 0.35 * Math.sin(Tq * lb.w2 + lb.p2)) + st * 0.25 + tx * 0.25;
    const L = lb.L0 * (0.15 + 0.85 * g) * (1 + 0.05 * Math.sin(Tq * 0.27 + lb.p1)) * (1 + 0.22 * ty);
    const Wd = L * lb.S0 * (0.35 + 0.65 * g) * (1 + 0.18 * Math.sin(Tq * lb.w2 * 1.3 + lb.p1));
    const ns = (lb.seed & 1023) * 0.37, tw = Tq * (0.18 + st * 0.7);
    const sn = Math.sin(th), cs = Math.cos(th);
    // spine control points (local frame: "down" rotated by th, bend swings it sideways)
    const c1x = sn * 0.3 * L, c1y = cs * 0.34 * L;
    const c2x = sn * 0.62 * L + cs * bend * 0.38 * L, c2y = cs * 0.66 * L - sn * bend * 0.38 * L;
    const c3x = sn * 0.92 * L + cs * bend * 0.12 * L, c3y = cs * 0.92 * L - sn * bend * 0.12 * L;
    const lf = 1 - 0.16 * q * q + 0.07 * vnoise(q * 3.1 + ns, tw);          // scalloped rim
    const roll = lb.curl * q * q;
    out.length = 0;
    for (let n = 0; n <= PLUME_SEG; n++) {
      const t = n / PLUME_SEG * lf, u = 1 - t;
      const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t;
      const cx = b1 * c1x + b2 * c2x + b3 * c3x, cy = b1 * c1y + b2 * c2y + b3 * c3y;
      let tx = 3 * u * u * c1x + 6 * u * t * (c2x - c1x) + 3 * t * t * (c3x - c2x);
      let ty = 3 * u * u * c1y + 6 * u * t * (c2y - c1y) + 3 * t * t * (c3y - c2y);
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      const wide = Wd * Math.pow(t, 1.45) * (1 + lb.cup * Math.sin(3.1416 * t)) + 2.5;   // cupped like a petal
      const wave = 9 * t * vnoise(q * 1.7 + ns + t * 1.2, tw + (fs & 255) * 0.01);
      const off = q * wide + wave;
      const back = roll * L * 0.22 * smoothstep(0.6, 1, t);                   // rim rolls back toward the root
      out.push([rx + cx - ty * off - tx * back, ry + cy + tx * off - ty * back]);
    }
    return out;
  }

  /* ---------------- art modes (the wall). No map, no words: the same live data drawn as one of several
     pictures (js/artmodes.js: ART_MODES, picked by this.artIdx, 1-based). This hands the chosen mode the
     data and the mist weather, then draws what every mode shares on top: taps from phones bloom faintly
     and lightning strikes (a mode that sets bolts: false draws its lightning itself, in its own place). */
  _drawArt(T) {
    const c = this.ctx, modes = typeof ART_MODES !== 'undefined' ? ART_MODES : [];
    const dt = this._artT != null ? clamp(T - this._artT, 0, 0.1) : 0.016;
    this._artT = T;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    this.impulses = this.impulses.filter(m => T - m.t < 3);
    this.ripples = this.ripples.filter(r => T - r.t < 3.2);
    this.bolts = this.bolts.filter(b => T - b.t < 1.2);
    this.bright = Math.max(0, this.bright - 0.01);
    if (!modes.length) { c.fillStyle = `rgb(${PAL.bg})`; c.fillRect(0, 0, this.w, this.h); this.fresh = false; return; }
    const idx = clamp((this.artIdx || 1) - 1, 0, modes.length - 1), mode = modes[idx];
    let fresh = this.fresh;
    if (!this._artSt || this._artMode !== idx) { this._artSt = {}; this._artMode = idx; fresh = true; }   // a new mode starts clean
    this.fresh = false;
    // the mist, eased every frame (its messages arrive about 5 times a second): energy follows fast, position a bit slower
    const m = this._mist || (this._mist = { w: 0, e: 0, x: 0, y: 0 }), ke = 1 - Math.exp(-dt * 10), kx = 1 - Math.exp(-dt * 5);
    m.w += ((this.mistW || 0) - m.w) * kx; m.e += ((this.mistE || 0) - m.e) * ke;
    m.x += ((this.mistX || 0) - m.x) * kx; m.y += ((this.mistY || 0) - m.y) * kx;
    const none = this._noSites || (this._noSites = []), lw = Math.max(1, this.scale * 0.75);
    const env = { T, dt, W: this.w, H: this.h, s: this.scale, lw, sites: this.sites || none, pts: this.snapPts || none,
                  storm: this.storm, pres: this.presence, mist: m.w, e: m.e, mx: m.x, my: m.y, light: INK, fresh,
                  st: this._artSt, boost: 1 + this.bright * 0.6, dpr: this.dpr };
    // a mode with its own dark palette is drawn (taps and lightning too) light-on-dark in either theme
    const swap = !!mode.dark && INK, keep = swap ? Object.assign({}, PAL) : null;
    if (swap) { INK = false; Object.assign(PAL, PAL_DARK); }
    try {
      c.save();
      try { mode.draw(this, c, env); }
      catch (err) { if (!this._artErr) { this._artErr = true; console.error('art mode ' + mode.name, err); } }   // never stop the wall's loop
      c.restore();
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.globalAlpha = 1; c.setLineDash([]); c.globalCompositeOperation = PAL.comp;
      for (const r of this.ripples) {
        const age = T - r.t; if (age < 0) continue;
        const k = r.k || 1;
        this._drop(c, r.x, r.y, age, r.seed || 1, { k, alpha: r.echo ? 0.12 : 0.3, lw, col: colorOf(r.c) });
      }
      if (mode.bolts !== false) for (const b of this.bolts) { const age = T - b.t; if (age >= 0) this._bolt(c, b, age, lw); }
      c.globalCompositeOperation = 'source-over';
      } finally {
      if (swap) { INK = true; Object.assign(PAL, keep); }
    }
  }
  /* a drop on water: three dotted rings widening and fading, a soft core, a few flung drops that sink */
  _drop(c, x, y, age, seed, o) {
    const s = this.scale, [sx, sy] = this._toScreen(x, y), col = o.col || PAL.ink, life = 2.6;
    if (age > life) return;
    c.setLineDash([]); c.lineCap = 'round';
    for (let i = 0; i < 3; i++) {                                     // rings that bleed as they widen
      const u = age - i * 0.22; if (u < 0) continue;
      const fade = Math.pow(Math.max(0, 1 - u / (life - i * 0.22)), 1.3), rad = (20 + 70 * o.k) * s * (1 - Math.exp(-1.6 * u)) * (1 + 0.35 * i), a = o.alpha * fade * (i ? 0.5 : 0.85);
      c.beginPath(); c.ellipse(sx, sy, rad, rad * 0.62, 0, 0, 6.283);
      c.strokeStyle = `rgba(${col},${(a * 0.18).toFixed(3)})`; c.lineWidth = o.lw * (3 + 4 * u); c.stroke();
      c.strokeStyle = `rgba(${col},${(a * 0.5).toFixed(3)})`; c.lineWidth = o.lw * 0.9; c.stroke();
    }
    const cf = Math.pow(Math.max(0, 1 - age / 1.1), 1.5);
    if (cf > 0) { const z = (18 + 30 * age) * s * o.k, g = sparkSprite(); c.globalAlpha = o.alpha * cf * 0.9; c.drawImage(g, sx - z / 2, sy - z / 2, z, z); c.globalAlpha = 1;
      if (o.col) { const gr = c.createRadialGradient(sx, sy, 0, sx, sy, z); gr.addColorStop(0, `rgba(${col},${(0.5 * cf * o.alpha).toFixed(3)})`); gr.addColorStop(1, `rgba(${col},0)`); c.fillStyle = gr; c.beginPath(); c.arc(sx, sy, z, 0, 6.283); c.fill(); } }
    const df = Math.pow(Math.max(0, 1 - age / 1.8), 1.2);
    if (df > 0) {
      const g = sparkSprite(); c.globalAlpha = o.alpha * df * 0.8;
      for (let j = 0; j < 7; j++) {                                   // a few soft drops flung out, sinking
        const th = hash(seed + j * 5) * 6.283, sp = (40 + 90 * hash(seed + j * 5 + 1)) * s * o.k, rad = sp * (1 - Math.exp(-2.2 * age)) / 2.2;
        const px = sx + Math.cos(th) * rad, py = sy + Math.sin(th) * rad * 0.62 + 90 * age * age * s, d = (hash(seed + j * 5 + 2) < 0.3 ? 9 : 6) * o.lw;
        c.drawImage(g, px - d / 2, py - d / 2, d, d);
      }
      c.globalAlpha = 1;
    }
  }
  _bloom(c, x, y, age, seed, o) {
    const fade = Math.pow(Math.max(0, 1 - age / o.life), 1.4);
    if (fade <= 0) return;
    const s = this.scale;
    const path = new Path2D(), tips = [];
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
        if (n === 10) tips.push([sx, sy, hash(seed + j * 5 + 4)]);
      }
    }
    const col = o.col || PAL.ink;
    c.setLineDash([]); c.strokeStyle = `rgba(${col},${o.alpha * fade * 0.3})`; c.lineWidth = o.lw * 0.5; c.stroke(path);
    c.setLineDash([0.01, 3 * s]); c.lineDashOffset = -age * 30 * s;
    c.strokeStyle = `rgba(${col},${Math.min(1, o.alpha * fade * 1.7)})`; c.lineWidth = o.lw * 1.1; c.stroke(path);
    c.setLineDash([]); c.lineDashOffset = 0;
    c.fillStyle = `rgba(${col},${Math.min(1, o.alpha * fade * 2.2)})`;
    for (const [tx, ty, h] of tips) { const d = (h < 0.3 ? 2.3 : 1.3) * o.lw; c.fillRect(tx - d / 2, ty - d / 2, d, d); }
    if (o.core) {
      const [sx, sy] = this._toScreen(x, y);
      const R = (24 + 40 * age) * s;
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, R);
      g.addColorStop(0, `rgba(${col},${0.5 * fade})`); g.addColorStop(0.35, `rgba(${col},${0.16 * fade})`); g.addColorStop(1, `rgba(${col},0)`);
      c.fillStyle = g; c.beginPath(); c.arc(sx, sy, R, 0, 6.283); c.fill();
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
      const fk = this.art ? 0.3 : 1;                    // art mode keeps long trails: a softer flash
      c.fillStyle = INK ? `rgba(20,20,24,${0.18 * b.power * fl * fk})` : `rgba(235,240,255,${0.22 * b.power * fl * fk})`;
      c.fillRect(0, 0, W, H);
      c.globalCompositeOperation = PAL.comp;
    }
    if (this.noBoltLines) return;                       // the wall: the sky lights up and thunder rolls, but no bolt is drawn
    const col = INK ? '20,20,24' : '255,255,255';
    const main = new Path2D(), branches = new Path2D();
    if (b.across) {
      // sideways: from one side of the sky to the other, with forks dropping toward the ground
      let x = W * (0.02 + 0.2 * hash(sd + 3)), y = H * (0.08 + 0.3 * hash(sd + 4));
      const endX = W * (0.7 + 0.28 * hash(sd + 5)), step = 22 + 14 * hash(sd + 6);
      main.moveTo(x, y);
      let n = 0;
      while (x < endX) {
        x += step * (0.6 + 0.8 * hash(sd + 20 + n));
        y += (hash(sd + 30 + n) - 0.5) * 38 + (hash(sd + 31 + n) - 0.5) * 8;
        main.lineTo(x, y);
        if (hash(sd + 40 + n) < 0.16) {
          let bx = x, by = y; branches.moveTo(bx, by);
          const len = 3 + Math.floor(hash(sd + 50 + n) * 7);
          for (let k = 0; k < len; k++) { bx += (hash(sd + 60 + n * 13 + k) - 0.5) * 30; by += 12 + 16 * hash(sd + 70 + n * 13 + k); branches.lineTo(bx, by); }
        }
        n++;
      }
      [[11, 0.07], [4.5, 0.24], [1.7, 1]].forEach(([w, a]) => {
        c.strokeStyle = `rgba(${col},${a * fl})`; c.lineWidth = w * lw; c.stroke(main);
        c.lineWidth = w * lw * 0.5; c.stroke(branches);
      });
      return;
    }
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
    const a = this.ctx, len = Math.max(64, Math.round(a.sampleRate * sec)), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    const f = Math.min(4000, len >> 2); for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[len - f + i] * (1 - t); }
    return buf;
  }
  /* storm wind: airy noise (no low drone), shaped by random gusts that rise and fall at their own
     pace, plus a faint whistle that glides around. Nothing repeats on a fixed cycle. */
  _pinkBuffer(sec) {
    const a = this.ctx, len = Math.round(a.sampleRate * sec), buf = a.createBuffer(2, len, a.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      }
      const f = 6000; for (let i = 0; i < f; i++) { const t = i / f; d[i] = d[i] * t + d[len - f + i] * (1 - t); }
    }
    return buf;
  }
  setStorm(level) {
    const a = this.ctx; if (!a) return;
    if (!this.storm) {
      const out = a.createGain(); out.gain.value = 0.0001; out.connect(this.master);
      const send = a.createGain(); send.gain.value = 0.25; out.connect(send); send.connect(this.wet);
      // two long noise beds of different lengths, so their loops never line up
      const bed = (sec, f, q, gain) => {
        const src = a.createBufferSource(); src.buffer = this._pinkBuffer(sec); src.loop = true;
        const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 220;
        const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
        const g = a.createGain(); g.gain.value = gain;
        src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(out); src.start(a.currentTime, Math.random() * sec);
        return { bp, g };
      };
      const body = bed(11.3, 650, 0.55, 0.9), air = bed(7.7, 2200, 0.7, 0.35);
      // the whistle: a narrow resonance that wanders
      const wsrc = a.createBufferSource(); wsrc.buffer = this._pinkBuffer(9.1); wsrc.loop = true;
      const wbp = a.createBiquadFilter(); wbp.type = 'bandpass'; wbp.frequency.value = 1100; wbp.Q.value = 14;
      const wg = a.createGain(); wg.gain.value = 0.0001;
      wsrc.connect(wbp); wbp.connect(wg); wg.connect(out); wsrc.start(a.currentTime, Math.random() * 9);
      this.storm = { out, body, air, wbp, wg, level: 0 };
      // gusts: every so often pick a new strength and tone, and glide there at a random pace
      const step = () => {
        const st = this.storm, lv = st.level, t = a.currentTime;
        if (lv > 0.01) {
          const lull = Math.random() < 0.25;                            // sometimes the wind drops right off
          const strength = lull ? 0.05 + 0.15 * Math.random() : 0.35 + 0.65 * Math.random(), pace = 0.5 + Math.random() * 2;
          st.body.g.gain.setTargetAtTime(0.15 + 1.25 * strength, t, pace);
          st.body.bp.frequency.setTargetAtTime(380 + 520 * strength + 350 * lv, t, pace * 1.2);
          st.air.g.gain.setTargetAtTime(0.12 + 0.4 * strength * lv, t, pace);
          st.air.bp.frequency.setTargetAtTime(1600 + 1400 * Math.random(), t, pace * 1.5);
          st.wbp.frequency.setTargetAtTime(800 + 900 * Math.random() + 400 * strength, t, pace * 2);
          st.wg.gain.setTargetAtTime(Math.random() < 0.55 ? (0.05 + 0.12 * strength) * lv : 0.0001, t, pace * 1.5);
        }
      };
      this.storm.step = step;
      const gusts = () => { step(); setTimeout(gusts, 600 + Math.random() * 2600); };
      gusts();
    }
    // 0 = calm; 2 people ~ quiet; more people = louder
    this.storm.level = level;
    this.storm.out.gain.setTargetAtTime(level <= 0 ? 0.0001 : 0.12 + level * 0.6, a.currentTime, level > 0 ? 1.2 : 1.6);
  }
  /* thunder after a strike: low rumble (+ a crack when it is close) */
  /* thunder, built like the real thing, and different every time:
       1. the crack  - a crisp rip of noise right on the flash (sometimes two, sometimes none)
       2. the boom   - a deep falling thump, its pitch and weight vary
       3. the rumble - a long roll of low noise that swells a few times and travels across the
                       room from one side to the other, then dies away into the echo
     Each strike picks a character (close crack / rolling / double strike / distant grumble /
     long roll) and randomises its tone, length, swells and direction.
     power 0..1 = how close / big; loud scales the whole thing */
  thunder(power = 0.6, delay = 0, loud = 1) {
    const a = this.ctx; if (!a) return;
    const R = (lo, hi) => lo + Math.random() * (hi - lo);
    const t0 = a.currentTime + Math.max(0, delay), near = Math.min(1, Math.max(0, power));
    // pick a character: close strikes are cracks and doubles, far ones grumble and roll
    const roll = Math.random() + near * 0.5;
    const kind = roll > 1.15 ? 'close' : roll > 0.9 ? 'double' : roll > 0.6 ? 'rolling' : roll > 0.35 ? 'long' : 'grumble';
    const K = {
      close:   { crack: 1.0, body: 1.0, boom: 1.0, dur: R(3.2, 4.6), bright: R(1.1, 1.5), rolls: [2, 4] },
      double:  { crack: 0.8, body: 0.9, boom: 0.8, dur: R(4.0, 5.8), bright: R(0.9, 1.3), rolls: [3, 5] },
      rolling: { crack: 0.45, body: 0.7, boom: 0.7, dur: R(5.0, 7.5), bright: R(0.8, 1.1), rolls: [4, 7] },
      long:    { crack: 0.25, body: 0.5, boom: 0.6, dur: R(6.5, 9.0), bright: R(0.7, 1.0), rolls: [5, 8] },
      grumble: { crack: 0, body: 0.25, boom: 0.45, dur: R(4.5, 7.0), bright: R(0.55, 0.8), rolls: [3, 6] },
    }[kind];
    const dur = K.dur;
    // the sound travels: it starts on one side and rolls toward the other
    const pan = a.createStereoPanner ? a.createStereoPanner() : null;
    const bus = a.createGain(); bus.gain.value = 0.95 * loud * R(0.85, 1.1);
    const warm = a.createWaveShaper();                                 // gentle saturation: lows read on small speakers
    const curve = new Float32Array(1024), drive = R(1.4, 2.2);
    for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
    warm.curve = curve;
    bus.connect(warm);
    if (pan) {
      const p0 = R(-0.75, 0.75), p1 = Math.max(-0.9, Math.min(0.9, -p0 * R(0.3, 1.1) + R(-0.2, 0.2)));
      pan.pan.setValueAtTime(p0, t0); pan.pan.linearRampToValueAtTime(p1, t0 + dur);
      warm.connect(pan); pan.connect(this.master);
    } else warm.connect(this.master);
    const send = a.createGain(); send.gain.value = R(0.4, 0.7); warm.connect(send); send.connect(this.wet);
    // 1. crack
    const crack = (f, q, peak, decay, at) => {
      if (peak <= 0.005) return;
      const src = a.createBufferSource(); src.buffer = this._noiseBuffer(decay + 0.3, false);
      src.playbackRate.value = R(0.85, 1.15);
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
      const g = a.createGain(); g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + R(0.008, 0.02)); g.gain.exponentialRampToValueAtTime(peak * 0.35, at + decay * R(0.25, 0.45));
      g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
      src.connect(bp); bp.connect(g); g.connect(bus); src.start(at); src.stop(at + decay + 0.3);
    };
    const cracks = kind === 'double' ? [0, R(0.18, 0.55)] : [0];
    cracks.forEach((dt, j) => {
      const sc = j ? R(0.6, 1) : 1;
      crack((1500 + 1100 * near) * K.bright * R(0.85, 1.2), R(0.45, 0.8), (0.05 + 0.14 * near * near) * K.crack * sc, R(0.25, 0.5) + 0.2 * near, t0 + dt);
      crack(R(380, 620) * K.bright, R(0.5, 0.9), (0.1 + 0.16 * near) * K.body * sc, R(0.6, 1.1) + 0.3 * near, t0 + dt + 0.02);
    });
    // 2. boom
    const boom = (type, f0, f1, peak, len, at) => {
      const o = a.createOscillator(), g = a.createGain(); o.type = type;
      o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + len);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + R(0.2, 0.4)); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
      o.connect(g); g.connect(bus); o.start(at); o.stop(at + len + 0.05);
    };
    const bf = R(44, 66);
    boom('sine', bf, bf * R(0.5, 0.62), (0.1 + 0.08 * near) * K.boom, R(1.6, 2.6) + 0.6 * near, t0);
    boom('triangle', bf * 1.9, bf * R(0.9, 1.05), (0.025 + 0.02 * near) * K.boom, R(1, 1.6), t0);
    // 3. rumble: brown noise, low-passed, with a rolling envelope of several swells
    const src = a.createBufferSource(); src.buffer = this._noiseBuffer(dur + 0.5, true);
    src.playbackRate.value = R(0.8, 1.2);
    const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = R(0.5, 1.1);
    const f0 = (420 + 380 * near) * K.bright, fMid = R(180, 300) * K.bright, fEnd = R(70, 130);
    lp.frequency.setValueAtTime(f0, t0); lp.frequency.exponentialRampToValueAtTime(fMid, t0 + R(0.8, 1.6)); lp.frequency.exponentialRampToValueAtTime(fEnd, t0 + dur);
    const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = R(24, 40);
    const g = a.createGain(); g.gain.value = 0;
    const N = 256, env = new Float32Array(N), bumps = [];
    const nb = K.rolls[0] + Math.floor(Math.random() * (K.rolls[1] - K.rolls[0] + 1));
    const first = kind === 'grumble' ? R(0.8, 1.6) : R(0.35, 0.65) + 0.35 * (1 - near);
    bumps.push([first, R(0.35, 0.65), 1]);                                                      // the first big roll builds in
    for (let k = 1; k < nb; k++) bumps.push([first + R(0.4, dur * 0.65), R(0.25, 0.8), R(0.35, 0.95)]);
    if (kind === 'double') bumps.push([first + R(0.2, 0.6), R(0.3, 0.5), R(0.8, 1)]);
    let mx = 0;
    const tail = R(0.4, 0.6), floor = R(0.08, 0.16), fadeIn = kind === 'grumble' ? R(0.6, 1) : R(0.25, 0.45);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1) * dur;
      let v = floor;
      for (const [c, w, h] of bumps) v += h * Math.exp(-(((t - c) / w) ** 2));
      v *= Math.exp(-t / (dur * tail)) * Math.min(1, t / fadeIn);
      env[i] = v; mx = Math.max(mx, v);
    }
    const peak = (0.7 + 0.3 * near) * (kind === 'grumble' ? 0.8 : 1);
    for (let i = 0; i < N; i++) env[i] = env[i] / mx * peak;
    env[N - 1] = 0;
    g.gain.setValueCurveAtTime(env, t0 + 0.01, dur);
    src.connect(lp); lp.connect(hp); hp.connect(g); g.connect(bus);
    src.start(t0); src.stop(t0 + dur + 0.4);
    return kind;
  }
  /* calm weather (no mist): rain gives way to leaves rustling and small birds. 0 = off, 1 = full */
  setCalm(level) {
    const a = this.ctx; if (!a) return;
    if (!this.calm) {
      const src = a.createBufferSource(); src.buffer = this._noiseBuffer(5, false); src.loop = true;
      const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.45;
      const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
      // leaves: the hiss breathes slowly and flutters, like wind moving through a tree
      const sway = a.createGain(); sway.gain.value = 0.55;
      const lfo1 = a.createOscillator(), l1 = a.createGain(); lfo1.frequency.value = 0.11; l1.gain.value = 0.3;
      const lfo2 = a.createOscillator(), l2 = a.createGain(); lfo2.frequency.value = 2.3; l2.gain.value = 0.12;
      lfo1.connect(l1); l1.connect(sway.gain); lfo2.connect(l2); l2.connect(sway.gain); lfo1.start(); lfo2.start();
      const g = a.createGain(); g.gain.value = 0.0001;
      src.connect(hp); hp.connect(bp); bp.connect(sway); sway.connect(g); g.connect(this.master); src.start();
      this.calm = { g, level: 0, timer: null };
      const birds = () => {
        const lv = this.calm.level;
        if (lv > 0.15 && Math.random() < 0.35 + lv * 0.5) this.chirp(Math.random(), 0.05 + 0.07 * lv);
        this.calm.timer = setTimeout(birds, 1200 + Math.random() * 4500 / Math.max(0.2, lv));
      };
      birds();
    }
    this.calm.level = level;
    this.calm.g.gain.setTargetAtTime(level <= 0 ? 0.0001 : 0.02 + 0.06 * level, a.currentTime, level > 0 ? 2 : 1.2);
  }
  /* a small bird: a short phrase of 2-5 whistled notes, each a quick frequency sweep */
  chirp(pan = 0.5, vol = 0.08) {
    const a = this.ctx; if (!a) return;
    const n = 2 + Math.floor(Math.random() * 4), f0 = 2200 + Math.random() * 2600;
    let t = a.currentTime + 0.05;
    const p = a.createStereoPanner ? a.createStereoPanner() : null;
    const out = a.createGain(); out.gain.value = vol;
    if (p) { p.pan.value = pan * 2 - 1; out.connect(p); p.connect(this.master); p.connect(this.wet); } else out.connect(this.master);
    for (let i = 0; i < n; i++) {
      const o = a.createOscillator(), g = a.createGain(); o.type = 'sine';
      const d = 0.05 + Math.random() * 0.09, up = Math.random() < 0.6, f1 = f0 * (0.85 + Math.random() * 0.3), f2 = f1 * (up ? 1.35 : 0.72);
      o.frequency.setValueAtTime(f1, t); o.frequency.exponentialRampToValueAtTime(f2, t + d * 0.7); o.frequency.exponentialRampToValueAtTime(f1 * 1.05, t + d);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(1, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(out); o.start(t); o.stop(t + d + 0.02);
      t += d + 0.03 + Math.random() * 0.08;
    }
  }
  /* one person blowing: a soft whoosh */
  gust(strength = 0.5) {
    // one breath of wind: airy noise that swells and fades at a random pace and pitch
    const a = this.ctx; if (!a) return;
    const t = a.currentTime, rise = 0.35 + Math.random() * 0.6, fall = 0.9 + Math.random() * 1.4, len = rise + fall;
    const src = a.createBufferSource(); src.buffer = this._pinkBuffer(len + 0.2);
    const hp = a.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 240;
    const bp = a.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.5 + Math.random() * 0.5;
    const f0 = 450 + Math.random() * 400, f1 = f0 * (1.4 + Math.random() * 0.8);
    bp.frequency.setValueAtTime(f0, t); bp.frequency.linearRampToValueAtTime(f1, t + rise); bp.frequency.linearRampToValueAtTime(f0 * 0.9, t + len);
    const g = a.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.04 + 0.07 * strength, t + rise); g.gain.linearRampToValueAtTime(0.0001, t + len);
    const p = a.createStereoPanner ? a.createStereoPanner() : null;
    src.connect(hp); hp.connect(bp); bp.connect(g);
    if (p) { p.pan.setValueAtTime(Math.random() * 1.2 - 0.6, t); p.pan.linearRampToValueAtTime(Math.random() * 1.2 - 0.6, t + len); g.connect(p); p.connect(this.master); }
    else g.connect(this.master);
    src.start(t); src.stop(t + len + 0.1);
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
/* the phone's little world: the same map the wall hangs its plumes from. Land is one soft shape (places.js
   LAND_MASK, 2° cells blurred together), east-west across and 80N..60S down; every raining place is a spark
   with a short plume falling from it, bigger and firmer where it rains harder. */
class WorldMap {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.snap = null; this.land = null; this.key = '';
    this.zoom = 1; this.ox = 0; this.oy = 0; this.vx = 0; this.vy = 0;     // the view: how much wider than the screen, and where it looks
    this._pan(canvas);
  }
  setSnapshot(s) { this.snap = s; }
  /* the map is `zoom` screens wide (and tall enough to keep its shape); ox/oy = the corner shown, in map px */
  _size(w, h) { const mw = w * this.zoom, mh = mw * 0.62; return [mw, mh]; }      // a little taller than true, like the wall
  _xy(lat, lon, w, h) { const [mw, mh] = this._size(w, h); return [mw * (0.03 + 0.94 * (lon + 180) / 360) - this.ox, mh * (0.08 + 0.84 * clamp((80 - lat) / 140, 0, 1)) - this.oy]; }
  _clamp(w, h) {                                                             // the map slides side to side within its edges
    const [mw, mh] = this._size(w, h);
    if (this.centre) { this.centre = false; this.ox = (mw - w) / 2; this.oy = mh <= h ? -(h - mh) / 2 : (mh - h) / 2; }
    this.ox = clamp(this.ox, 0, Math.max(0, mw - w)); this.oy = mh <= h ? -(h - mh) / 2 : (mh - h) / 2;   // side to side only; the map stays centred vertically
  }
  _pan(cv) {                                                                // drag to look around; a flick keeps going a little
    let d = null;
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); d = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 }; this.vx = this.vy = 0; });
    cv.addEventListener('pointermove', e => {
      if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y, now = performance.now(), dt = Math.max(1, now - d.t);
      this.ox -= dx; this.vx = -dx / dt * 1000; this.vy = 0; d.moved += Math.hypot(dx, dy); d.x = e.clientX; d.y = e.clientY; d.t = now;
      this._clamp(cv.clientWidth, cv.clientHeight);
    });
    const up = e => { if (!d) return; if (d.moved < 8 && this.onTap) this.onTap(e.clientX, e.clientY); if (performance.now() - d.t > 80) this.vx = this.vy = 0; d = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }
  /* the raining place nearest a screen point, within reach (for a tap) */
  nearest(sx, sy, w, h) {
    if (!this.snap) return null; let best = null, bd = 28 * 28;
    this.snap.pts.forEach((p, idx) => { if (!isRaining(p[2], p[3])) return; const [x, y] = this._xy(p[0], p[1], w, h), dd = (x - sx) ** 2 + (y - sy) ** 2; if (dd < bd) { bd = dd; best = { idx, lat: p[0], lon: p[1], mm: p[2], code: p[3], x, y }; } });
    return best;
  }
  _ground(w, h, dpr) {                         // the whole land, drawn once per size and theme (then panned)
    const [mw, mh] = this._size(w, h), key = mw + 'x' + mh + ':' + dpr + ':' + INK;
    if (key === this.key && this.land) return this.land;
    this.key = key;
    const cv = this.land || document.createElement('canvas'); cv.width = Math.round(mw * dpr); cv.height = Math.round(mh * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, mw, mh);
    const ox = this.ox, oy = this.oy; this.ox = this.oy = 0;
    const sh = document.createElement('canvas'); sh.width = cv.width; sh.height = cv.height;   // the land as one soft shape
    const q = sh.getContext('2d'); q.setTransform(dpr, 0, 0, dpr, 0, 0); q.fillStyle = `rgb(${PAL.ink})`;
    if (typeof LAND_MASK !== 'undefined') for (let r = 0; r < 90; r++) for (let c = 0; c < 180; c++) {
      if (!LAND_MASK[r * 180 + c]) continue;
      const lat = 89 - r * 2, lon = -179 + c * 2;
      if (lat < -60 || lat > 80) continue;
      const [x0, y0] = this._xy(lat + 1, lon - 1, w, h), [x1, y1] = this._xy(lat - 1, lon + 1, w, h);
      q.fillRect(x0 - 0.3, y0 - 0.3, x1 - x0 + 0.6, y1 - y0 + 0.6);
    }
    g.globalAlpha = INK ? 0.13 : 0.12;
    try { g.filter = `blur(${Math.max(2, mw / 200)}px)`; } catch (e) {}
    g.drawImage(sh, 0, 0, sh.width, sh.height, 0, 0, mw, mh);
    try { g.filter = 'none'; } catch (e) {}
    g.globalAlpha = 1;
    this.ox = ox; this.oy = oy;
    return (this.land = cv);
  }
  draw(T, w, h, dpr) {
    const c = this.ctx;
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    if (this.vx || this.vy) { this.ox += this.vx / 60; this.oy += this.vy / 60; this.vx *= 0.93; this.vy *= 0.93; if (Math.abs(this.vx) + Math.abs(this.vy) < 4) this.vx = this.vy = 0; }
    this._clamp(w, h);
    const [mw, mh] = this._size(w, h), gnd = this._ground(w, h, dpr);
    c.drawImage(gnd, 0, 0, gnd.width, gnd.height, -this.ox, -this.oy, mw, mh);
    if (!this.snap) return;
    c.globalCompositeOperation = PAL.comp;
    const spr = sparkSprite(), scl = Math.max(0.7, w / 420), core = new Path2D(), fall = [new Path2D(), new Path2D(), new Path2D()];
    for (const [lat, lon, mm, code] of this.snap.pts) {
      if (!isRaining(mm, code)) continue;                               // only where it rains
      const [x, y] = this._xy(lat, lon, w, h);
      if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;
      const k = rainStrength(mm, code), seed = Math.round((lat + 90) * 1000 + lon * 7);
      const z = (12 + 18 * k) * scl, cr = (1.6 + 1.2 * k) * scl;        // the spark, with a crisp core
      c.globalAlpha = 0.7 + 0.3 * k; c.drawImage(spr, x - z / 2, y - z / 2, z, z);
      core.moveTo(x + cr, y); core.arc(x, y, cr, 0, 6.283);
      for (let q = 0, n = 2 + Math.round(3 * k); q < n; q++) {           // its plume: a few dotted strands falling from it
        const per = 1.6 + hash(seed + q + 9) * 1.2, ph = ((T + hash(seed + q + 5) * per) % per) / per;
        const sx = x + (hash(seed + q) - 0.5) * 7 * scl * k, L = (9 + 14 * k) * scl, pp = fall[Math.min(2, Math.floor(k * 3))];
        const f = ph; pp.moveTo(sx, y + f * L * 0.6); pp.lineTo(sx, y + f * L * 0.6 + L * 0.35);   // a soft streak falling from it
      }
    }
    c.globalAlpha = 1;
    c.fillStyle = `rgba(${PAL.ink},0.9)`; c.fill(core);
    c.lineCap = 'round'; fall.forEach((pp, i) => { c.strokeStyle = `rgba(${PAL.ink},${(0.12 + 0.1 * i).toFixed(2)})`; c.lineWidth = 3 * scl; c.stroke(pp); c.strokeStyle = `rgba(${PAL.ink},${(0.3 + 0.2 * i).toFixed(2)})`; c.lineWidth = 1 * scl; c.stroke(pp); });
    c.globalCompositeOperation = 'source-over';
  }
}

function fmtTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; }
}
