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
    font:italic 400 17px/1.6 'Cormorant Garamond','Times New Roman',serif;color:var(--ink,#3b4345);
    opacity:0;transition:opacity 1.2s ease}
  .umb-hint.on{opacity:.85}
  .umb-hint i{display:block;opacity:.75;font-size:15px;margin-bottom:4px}
  .umb-me{position:fixed;z-index:8;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;pointer-events:none;
    border:1.5px dashed rgb(var(--me,255,255,255));box-shadow:0 0 18px rgba(var(--me,255,255,255),.55);opacity:0;transition:opacity .6s ease}
  .umb-me::after{content:'';position:absolute;left:4px;top:4px;width:4px;height:4px;border-radius:50%;background:rgb(var(--me,255,255,255))}
  .umb-me.on{opacity:.9}
  .umb-ring{position:fixed;z-index:8;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;pointer-events:none;
    border:1.5px solid rgb(var(--me,255,255,255));opacity:0}
  .umb-ring.go{animation:umbring 1.1s ease-out infinite}
  @keyframes umbring{0%{transform:scale(1);opacity:.8}100%{transform:scale(9);opacity:0}}
  .umb-helpbtn{font-family:'Cormorant Garamond',serif;font-style:italic;font-size:22px}
  .umb-help{position:fixed;inset:0;z-index:40;display:flex;flex-direction:column;justify-content:center;padding:calc(env(safe-area-inset-top) + 24px) 26px 24px;overflow:auto;
    background:rgba(var(--bgrgb,232,235,234),.95);color:var(--ink,#3b4345);font:italic 400 17px/1.45 'Cormorant Garamond','Times New Roman',serif;
    opacity:0;pointer-events:none;transition:opacity .6s ease}
  .umb-help.on{opacity:1;pointer-events:auto}
  .umb-help p{margin:0 0 14px}
  .umb-help b{font-weight:500;display:block;margin-bottom:1px;opacity:.8;font-size:15px}
  .umb-help .umb-help-lede{font-size:20px;margin-bottom:20px}
  .umb-help .umb-dim{opacity:.45}
  .umb-help .umb-help-foot{opacity:.7;font-size:15px;margin-top:10px}`;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const h = document.createElement('p'); h.className = 'umb-hint'; h.id = 'umb-hint';
    h.innerHTML = '<i>the wall is a plaza in the rain</i>one finger · carry your umbrella<br>hold still · bring the rain<br>two fingers · a gust';
    document.body.appendChild(h);
    const d = document.createElement('i'); d.className = 'umb-me'; d.id = 'umb-me'; document.body.appendChild(d);
    const r = document.createElement('i'); r.className = 'umb-ring'; r.id = 'umb-ring'; document.body.appendChild(r);
    const hb = document.createElement('button'); hb.className = 'icon-btn umb-helpbtn'; hb.id = 'umb-helpbtn'; hb.textContent = '?'; hb.setAttribute('aria-label', 'what is this');
    const btns = document.querySelector('.hud-btns'); if (btns) btns.prepend(hb); else document.body.appendChild(hb);
    const sheet = document.createElement('div'); sheet.className = 'umb-help'; sheet.id = 'umb-help'; document.body.appendChild(sheet);
    hb.onclick = () => toggleHelp(!sheet.classList.contains('on'));
    sheet.onclick = () => toggleHelp(false);
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

  /* ---------------- pointer events, handed over by phone.js. Returns true when the gesture is ours.
     one finger: drag = carry your umbrella; hold still = rain there (while you hold; it fades when you lift)
     two fingers moving together = a gust across the plaza in that direction */
  const fingers = new Map();
  function down(e) {
    if (!on) return false;
    const t = performance.now();
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 1) g = { x0: e.clientX, y0: e.clientY, t0: t, x: e.clientX, y: e.clientY, t, moved: 0, hold: false, pos0: pos, two: null };
    else if (g && fingers.size === 2) {                             // the second finger: this is a gust, not a walk
      if (g.hold) { send('shower', { on: 0 }, true); $('#umb-ring').classList.remove('go'); g.hold = false; }
      const [a, b] = [...fingers.values()]; g.two = { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, t0: t, sent: false };
      pos = g.pos0; placeDot(); if (pos) send('walk', walkMsg(), true);   // the walk so far is undone: two fingers never carry
    }
    return true;
  }
  function move(e) {
    if (!on || !g) return false;
    const f = fingers.get(e.pointerId); if (f) { f.x = e.clientX; f.y = e.clientY; }
    const t = performance.now();
    if (g.two) {                                                    // two fingers: follow the centroid
      const pts = [...fingers.values()], cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      g.two.x = cx; g.two.y = cy; return true;
    }
    const dx = e.clientX - g.x, dy = e.clientY - g.y, d = Math.hypot(dx, dy);
    g.moved += d; g.x = e.clientX; g.y = e.clientY; g.t = t;
    if (g.hold) {                                                   // raining where the finger is: it can be dragged about
      send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 });
      const r = $('#umb-ring'); r.style.left = g.x + 'px'; r.style.top = g.y + 'px';
    } else if (g.moved > 8) {                                       // a drag: your umbrella follows the finger, right away
      pos = { u: g.x / innerWidth, v: g.y / innerHeight }; placeDot(); send('walk', walkMsg());
    }
    return true;
  }
  function up(e) {
    if (!on || !g) { fingers.delete(e.pointerId); return false; }
    fingers.delete(e.pointerId);
    if (g.two) {
      if (!g.two.sent) {                                            // the first finger lifted ends the gust
        g.two.sent = true;
        const dx = g.two.x - g.two.cx, dy = g.two.y - g.two.cy, L = Math.hypot(dx, dy) / innerWidth, dur = (performance.now() - g.two.t0) / 1000;
        if (L > 0.05) {
          const s = Math.min(1.4, Math.max(0.5, L / Math.max(0.15, dur) / 1.6));
          send('gust', { u: r3(g.two.cx / innerWidth), v: r3(g.two.cy / innerHeight), du: r3(dx / (L * innerWidth)), dv: r3(dy / (L * innerWidth)), s: r3(s), once: 1 }, true);
          if (navigator.vibrate) navigator.vibrate(20);
        }
      }
      if (fingers.size) return 'more';                              // the other finger is still down
      g = null; return true;
    }
    const dur = performance.now() - g.t0, mine = g; g = null;
    if (mine.hold) { send('shower', { on: 0 }, true); $('#umb-ring').classList.remove('go'); return true; }
    if (mine.moved < 12 && dur < 350) return false;                 // a tap: phone.js plays it as usual
    if (pos) send('walk', walkMsg(), true);                         // the drag ended: the umbrella stays here
    return true;
  }
  /* ---------------- the help sheet: what this is, and what the fingers do */
  function helpHtml() {
    const umb = modeName === 'umbrellas';
    return `<p class="umb-help-lede">Right now it is raining in many places on Earth. The wall shows them live, and your phone is one more drop in that rain.</p>
      <p><b>on the first screen</b><br>swipe the map to look around · tap a light to see where it is raining; the wall points there too</p>
      <p><b>in the rain</b><br>tap · a ripple and your note<br>drag · the rain bends around your finger<br>two phones edge to edge, one finger across both · one rain</p>
      <p class="${umb ? '' : 'umb-dim'}"><b>when the wall shows the plaza of umbrellas</b><br>one finger, drag · carry your umbrella (it stays where you leave it)<br>one finger, hold still · rain falls there while you hold<br>two fingers, move together · a gust across the plaza<br>someone whose umbrella the wind takes runs under yours</p>
      <p class="umb-help-foot">tap anywhere to close</p>`;
  }
  function toggleHelp(show) { const h = $('#umb-help'); if (show) h.innerHTML = helpHtml(); h.classList.toggle('on', show); }
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
    if (g && !g.two && !g.hold && g.moved < 12 && now - g.t0 > 420) {   // held still (one finger): rain here
      g.hold = true; send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 }, true);
      const r = $('#umb-ring'); r.style.left = g.x + 'px'; r.style.top = g.y + 'px'; r.classList.add('go');
      if (navigator.vibrate) navigator.vibrate(12);
    }
    if (g && g.hold && !g.two && now - keepT > 250) { keepT = now; send('shower', { u: r3(g.x / innerWidth), v: r3(g.y / innerHeight), on: 1 }, true); }
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
