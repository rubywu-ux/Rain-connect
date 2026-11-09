/* Rain Connect — the phone while the wall shows Umbrellas.
 * No panel: the rain screen itself is the plaza. Three gestures, told apart by how the finger moves:
 *   drag ........ carry your umbrella (the one coloured umbrella on the wall; it stays where you leave it)
 *   hold still .. rain falls hard on that spot
 *   flick ....... a gust sweeps across the plaza that way
 * A quick tap keeps its usual meaning (a ripple and your note), and edge swipes still join phones.
 * Messages go to the wall as hub/in {type: 'ix', m: 'umbrellas', k, ...}; artmodes.js reads them (ixOf).
 * Try it without the wall: index.html?lab=umbrellas */
const RCLab = (() => {
  const qs = new URLSearchParams(location.search), forced = /umbrella/i.test(qs.get('lab') || '');
  let net = null, ME = '', on = false, artSeen = forced ? Infinity : 0, modeName = forced ? 'umbrellas' : 'map';
  let pos = null;                       // where your umbrella stands, 0..1 of the screen (null = not placed yet)
  let g = null;                         // the gesture in progress
  let lastSend = 0, keepT = 0, hintT = 0;
  const $ = s => document.querySelector(s);
  const r3 = x => Math.round(x * 1000) / 1000;

  const CSS = `
  .umb-hint{position:fixed;left:0;right:0;bottom:calc(22px + env(safe-area-inset-bottom));z-index:9;text-align:center;pointer-events:none;
    font:italic 15px/1.6 'Cormorant Garamond','Times New Roman',serif;color:rgb(var(--rgb,92,100,102));
    opacity:0;transition:opacity 1.2s ease}
  .umb-hint.on{opacity:.6}
  .umb-hint i{display:block;opacity:.6;font-size:13px;margin-bottom:4px}
  .umb-me{position:fixed;z-index:8;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;
    border:1.5px dashed rgb(var(--me,255,255,255));box-shadow:0 0 18px rgba(var(--me,255,255,255),.55);opacity:0;transition:opacity .6s ease}
  .umb-me::after{content:'';position:absolute;left:4px;top:4px;width:4px;height:4px;border-radius:50%;background:rgb(var(--me,255,255,255))}
  .umb-me.on{opacity:.9}
  .umb-ring{position:fixed;z-index:8;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;pointer-events:none;
    border:1.5px solid rgb(var(--me,255,255,255));opacity:0}
  .umb-ring.go{animation:umbring 1.1s ease-out infinite}
  @keyframes umbring{0%{transform:scale(1);opacity:.8}100%{transform:scale(9);opacity:0}}`;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const h = document.createElement('p'); h.className = 'umb-hint'; h.id = 'umb-hint';
    h.innerHTML = '<i>the wall is a plaza in the rain</i>drag · carry your umbrella<br>hold still · bring the rain<br>flick · a gust';
    document.body.appendChild(h);
    const d = document.createElement('i'); d.className = 'umb-me'; d.id = 'umb-me'; document.body.appendChild(d);
    const r = document.createElement('i'); r.className = 'umb-ring'; r.id = 'umb-ring'; document.body.appendChild(r);
  }
  function send(k, data, force) {
    if (!net) return;
    const now = performance.now();
    if (!force && now - lastSend < 40) return;
    lastSend = now;
    net.pub('hub/in', Object.assign({ type: 'ix', id: ME, m: 'umbrellas', k }, data));
  }
  const placeDot = () => { const d = $('#umb-me'); if (!pos) { d.classList.remove('on'); return; } d.style.left = pos.u * 100 + '%'; d.style.top = pos.v * 100 + '%'; d.classList.add('on'); };
  const walkMsg = () => ({ u: r3(pos.u), v: r3(pos.v), on: 1, keep: 1 });
  const hint = show => { $('#umb-hint').classList.toggle('on', show); };

  /* ---------------- pointer events, handed over by phone.js. Returns true when the gesture is ours. */
  function down(e) {
    if (!on) return false;
    const t = performance.now();
    g = { x0: e.clientX, y0: e.clientY, t0: t, x: e.clientX, y: e.clientY, t, moved: 0, hold: false, pk: 0, pos0: pos };
    return true;
  }
  function move(e) {
    if (!on || !g) return false;
    const t = performance.now(), dx = e.clientX - g.x, dy = e.clientY - g.y, d = Math.hypot(dx, dy);
    g.moved += d; g.pk = Math.max(g.pk, d / Math.max(1, t - g.t) * 1000 / innerWidth);   // peak speed, screens per second
    g.x = e.clientX; g.y = e.clientY; g.t = t;
    if (g.hold) {                                            // raining where the finger is: it can be dragged about
      send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 });
      const r = $('#umb-ring'); r.style.left = g.x + 'px'; r.style.top = g.y + 'px';
    } else if (g.moved > 8) {                                // a drag: your umbrella follows the finger, right away
      pos = { u: g.x / innerWidth, v: g.y / innerHeight }; placeDot(); send('walk', walkMsg());
    }
    return true;
  }
  function up(e) {
    if (!on || !g) return false;
    const dur = performance.now() - g.t0, dx = e.clientX - g.x0, dy = e.clientY - g.y0, L = Math.hypot(dx, dy) / innerWidth, mine = g; g = null;
    if (mine.hold) { send('shower', { on: 0 }, true); $('#umb-ring').classList.remove('go'); return true; }
    if (mine.moved < 12 && dur < 350) return false;          // a tap: phone.js plays it as usual
    if (L > 0.22 && dur < 420 && mine.pk > 2.2) {            // a flick: a gust across the plaza from where it started
      const s = Math.min(1.4, Math.max(0.5, L / (dur / 1000) / 2.2));
      send('gust', { u: r3(mine.x0 / innerWidth), v: r3(mine.y0 / innerHeight), du: r3(dx / (L * innerWidth)), dv: r3(dy / (L * innerWidth)), s: r3(s), once: 1 }, true);
      pos = mine.pos0; placeDot(); if (pos) send('walk', walkMsg(), true);   // a flick is wind, not a walk: the umbrella goes back where it was
      if (navigator.vibrate) navigator.vibrate(20);
      return true;
    }
    if (pos) send('walk', walkMsg(), true);                  // the drag ended: the umbrella stays here
    return true;
  }
  function tick() {
    const world = document.getElementById('world'), entered = !world || world.classList.contains('hidden');
    const want = entered && modeName === 'umbrellas' && (forced || Date.now() - artSeen < 20000);
    if (want !== on) {
      on = want;
      if (on) { hintT = performance.now(); hint(true); const h0 = document.getElementById('hint'); if (h0) h0.classList.add('hidden'); if (pos) send('walk', walkMsg(), true); placeDot(); }
      else { hint(false); if (pos) send('walk', { on: 0 }, true); $('#umb-me').classList.remove('on'); }
    }
    if (!on) return;
    const now = performance.now();
    if (hintT && now - hintT > 9000) { hint(false); hintT = 0; }
    if (g && !g.hold && g.moved < 12 && now - g.t0 > 420) {       // held still: rain here
      g.hold = true; send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 }, true);
      const r = $('#umb-ring'); r.style.left = g.x + 'px'; r.style.top = g.y + 'px'; r.classList.add('go');
      if (navigator.vibrate) navigator.vibrate(12);
    }
    if (g && g.hold && now - keepT > 250) { keepT = now; send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 }, true); }
    else if (pos && !g && now - keepT > 1000) { keepT = now; send('walk', walkMsg(), true); }   // the wall forgets a silent umbrella after a few seconds
  }
  return {
    init(o) { net = o.net; ME = o.ME; build(); setInterval(tick, 100); addEventListener('pagehide', () => { if (pos) send('walk', { on: 0 }, true); }); },
    onArt(m) {
      if (!m || forced) return;
      if (m.at && Math.abs(Date.now() - m.at) > 60000) return;     // an old retained message: the wall isn't running
      artSeen = Date.now(); modeName = m.name || 'map';
    },
    down, move, up,
    get active() { return on; },
  };
})();
