/* Rain Connect — phone TEST PANEL (low fidelity, on purpose).
 * Tries out interaction ideas for the wall's art modes. When the wall shows Birds or Umbrellas, this panel
 * appears on the phones (after "Catch the rain") with three ideas, A / B / C. The grey box stands for the wall.
 * Messages go to the wall as hub/in {type: 'ix', m: mode, k: kind, ...}; wall.js ixIn() keeps them and the
 * art modes read them (artmodes.js ixOf). Force it without the wall: index.html?lab=birds or ?lab=umbrellas */
const RCLab = (() => {
  const IDEAS = {
    murmuration: { title: 'Birds', ideas: [
      { id: 'A', name: 'Your own bird', k: 'bird', pad: 'steer', keep: 1,
        hint: 'A bird in your colour joins the flock. Drag in the box to fly it. The flock follows you.' },
      { id: 'B', name: 'Draw the flock', k: 'shape', pad: 'draw',
        hint: 'Draw a shape in the box (a loop works best). The starlings fly it for a few seconds.' },
      { id: 'C', name: 'Be the falcon', k: 'falcon', pad: 'hold',
        hint: 'Hold and drag in the box to hunt. The flock splits around you. Drag fast to swoop.' },
    ] },
    umbrellas: { title: 'Umbrellas', ideas: [
      { id: 'A', name: 'Share an umbrella', k: 'walk', pad: 'steer', keep: 1, btn: 'open',
        hint: 'Your walker carries the only coloured umbrella. Drag to walk. When the wind tears someone\'s umbrella away (a storm, or press GUST), they run in under yours. Works while it rains.' },
      { id: 'B', name: 'Make it rain here', k: 'shower', pad: 'hold',
        hint: 'Hold a finger in the box. A shower falls on that spot and people under it open their umbrellas.' },
      { id: 'C', name: 'Gust', k: 'gust', pad: 'swipe',
        hint: 'Swipe in the box: wind sweeps across the plaza that way. Swipe hard to flip open umbrellas inside out (best while it rains).' },
    ] },
  };
  const ALIAS = { birds: 'murmuration', bird: 'murmuration', murmuration: 'murmuration', umbrellas: 'umbrellas', umbrella: 'umbrellas' };
  const qs = new URLSearchParams(location.search), forced = ALIAS[(qs.get('lab') || '').toLowerCase()] || null;
  let net = null, ME = '', colorIdx = () => 0;
  let mode = forced, artSeen = forced ? Infinity : 0, shown = false, collapsed = false;
  const tab = { murmuration: 0, umbrellas: 0 };
  let cur = null;                       // the idea in use right now
  let pos = { u: 0.5, v: 0.6 }, open = true, lastSend = 0, keepT = 0, down = null;
  const $ = s => document.querySelector(s);

  /* black and white; only what you touch is in colour (your phone's colour, --me) */
  const CSS = `
  .lab{position:fixed;left:8px;right:8px;bottom:calc(8px + env(safe-area-inset-bottom));z-index:60;background:#000;color:#fff;
    border:1px solid #fff;border-radius:10px;padding:10px 10px 8px;font:12px/1.35 'IBM Plex Mono',ui-monospace,Menlo,monospace;
    -webkit-user-select:none;user-select:none}
  .lab.hidden,.lab-open.hidden{display:none}
  .lab-top{display:flex;justify-content:space-between;align-items:center;letter-spacing:.08em;text-transform:uppercase;font-size:11px}
  .lab-top b{font-weight:400}
  .lab-x,.lab-open{border:1px solid #fff;border-radius:6px;padding:3px 10px;background:#000;color:#fff;font:inherit}
  .lab-open{position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:60;font:11px 'IBM Plex Mono',ui-monospace,monospace;
    text-transform:uppercase;letter-spacing:.08em;padding:8px 12px}
  .lab-tabs{display:flex;gap:6px;margin:8px 0}
  .lab-tabs button{flex:1;border:1px dashed #fff;background:#000;border-radius:6px;padding:7px 3px;font:inherit;font-size:11px;color:#fff;line-height:1.2}
  .lab-tabs button.on{border:1px solid #fff;background:#fff;color:#000}
  .lab-hint{margin:0 0 8px;color:#fff;opacity:.75;min-height:5.5em}
  .lab-pad{position:relative;width:100%;aspect-ratio:16/9;border:1px dashed #fff;border-radius:6px;overflow:hidden;touch-action:none;
    background:repeating-linear-gradient(0deg,transparent 0 23px,#222 23px 24px),repeating-linear-gradient(90deg,transparent 0 23px,#222 23px 24px),#000}
  .lab-tag{position:absolute;left:6px;top:4px;font-size:10px;color:#fff;opacity:.5;text-transform:uppercase;letter-spacing:.08em;pointer-events:none}
  .lab-pad svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
  .lab-dot{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid rgb(var(--me,255,255,255));
    background:rgb(var(--me,255,255,255));box-shadow:0 0 14px rgba(var(--me,255,255,255),.7);display:none;pointer-events:none}
  .lab-dot.ring{background:transparent;border-style:dashed}
  .lab-row{display:flex;gap:6px;margin-top:8px}
  .lab-row:empty{display:none}
  .lab-btn{flex:1;border:1px solid #fff;border-radius:6px;background:#000;padding:9px;font:inherit;color:#fff}
  .lab-btn.on{border-color:rgb(var(--me,255,255,255));background:rgb(var(--me,255,255,255));color:#000}
  .lab-foot{margin:6px 0 0;color:#fff;opacity:.5;font-size:10px;display:flex;justify-content:space-between}
  .lab-foot #lab-sent{color:rgb(var(--me,255,255,255));opacity:1}`;

  function build() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'lab'; el.className = 'lab hidden';
    el.innerHTML = `<div class="lab-top"><b id="lab-title">Test</b><button class="lab-x" id="lab-x">hide</button></div>
      <div class="lab-tabs" id="lab-tabs"></div>
      <p class="lab-hint" id="lab-hint"></p>
      <div class="lab-pad" id="lab-pad"><span class="lab-tag">the wall</span><svg id="lab-svg"></svg><i class="lab-dot" id="lab-dot"></i></div>
      <div class="lab-row" id="lab-row"></div>
      <p class="lab-foot"><span id="lab-foot">low-fi test</span><span id="lab-sent"></span></p>`;
    document.body.appendChild(el);
    const ob = document.createElement('button'); ob.className = 'lab-open hidden'; ob.id = 'lab-open'; ob.textContent = 'test panel';
    document.body.appendChild(ob);
    $('#lab-x').onclick = () => { collapsed = true; update(); };
    ob.onclick = () => { collapsed = false; update(); };
    padEvents($('#lab-pad'));
  }

  /* ---------------- sending */
  function send(k, data, force) {
    if (!net) return;
    const now = performance.now();
    if (!force && now - lastSend < 80) return;
    lastSend = now;
    net.pub('hub/in', Object.assign({ type: 'ix', id: ME, m: mode, k }, data));
    const s = $('#lab-sent'); if (s) { s.textContent = 'sent ●'; clearTimeout(s._t); s._t = setTimeout(() => { s.textContent = ''; }, 400); }
  }
  const r3 = x => Math.round(x * 1000) / 1000;
  function steady() {                     // what a steady control (A) says while it is on
    if (!cur) return null;
    if (cur.k === 'bird') return { u: r3(pos.u), v: r3(pos.v), on: 1, keep: 1 };
    if (cur.k === 'walk') return { u: r3(pos.u), v: r3(pos.v), on: 1, keep: 1, open: open ? 1 : 0 };
    return null;
  }
  function stopCur() {                    // leaving an idea: tell the wall it is over
    if (!cur) return;
    if (cur.keep || cur.pad === 'hold') send(cur.k, { on: 0 }, true);
    down = null;
  }

  /* ---------------- the panel */
  function render() {
    const M = IDEAS[mode]; if (!M) return;
    const i = tab[mode], idea = M.ideas[i];
    if (cur !== idea) { stopCur(); cur = idea; pos = { u: 0.5, v: 0.6 }; clearSvg(); }
    $('#lab-title').textContent = 'Test · ' + M.title + ' · idea ' + idea.id;
    $('#lab-tabs').innerHTML = M.ideas.map((d, j) => `<button data-j="${j}" class="${j === i ? 'on' : ''}">${d.id} · ${d.name}</button>`).join('');
    $('#lab-tabs').querySelectorAll('button').forEach(b => { b.onclick = () => { tab[mode] = +b.dataset.j; render(); }; });
    $('#lab-hint').textContent = idea.hint;
    $('#lab-foot').textContent = 'low-fi test · ' + (forced ? 'forced with ?lab' : 'wall is on ' + M.title);
    const row = $('#lab-row'); row.innerHTML = '';
    if (idea.btn === 'open') {
      const b = document.createElement('button'); b.className = 'lab-btn' + (open ? ' on' : '');
      const label = () => { b.textContent = open ? '☂ umbrella OPEN' : '⌒ umbrella CLOSED'; b.classList.toggle('on', open); };
      label(); b.onclick = () => { open = !open; label(); send(cur.k, steady(), true); if (navigator.vibrate) navigator.vibrate(15); };
      row.appendChild(b);
      // a strong gust across the plaza, through where your walker is, from the far side
      const g = document.createElement('button'); g.className = 'lab-btn'; g.style.flex = '0 0 34%'; g.textContent = 'GUST ≋';
      g.onclick = () => {
        const fromRight = pos.u < 0.5;
        send('gust', { u: fromRight ? 0.98 : 0.02, v: r3(pos.v), du: fromRight ? -1 : 1, dv: 0, s: 1.3, once: 1 }, true);
        g.classList.add('on'); setTimeout(() => g.classList.remove('on'), 500); if (navigator.vibrate) navigator.vibrate(25);
      };
      row.appendChild(g);
    }
    const dot = $('#lab-dot');
    dot.classList.toggle('ring', idea.k === 'walk');
    dot.style.display = idea.keep ? 'block' : 'none';
    placeDot();
    if (idea.keep) send(idea.k, steady(), true);
  }
  function placeDot() { const d = $('#lab-dot'); d.style.left = pos.u * 100 + '%'; d.style.top = pos.v * 100 + '%'; }
  function clearSvg() { const s = $('#lab-svg'); if (s) s.innerHTML = ''; }
  function svgPath(pts, dashed, arrow) {
    const s = $('#lab-svg'), r = s.getBoundingClientRect();
    const d = pts.map(([u, v], i) => (i ? 'L' : 'M') + (u * r.width).toFixed(1) + ' ' + (v * r.height).toFixed(1)).join(' ');
    const ink = 'stroke:rgb(var(--me,255,255,255))';
    let h = `<path d="${d}" fill="none" style="${ink}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"${dashed ? ' stroke-dasharray="5 5"' : ''}/>`;
    if (arrow && pts.length > 1) {
      const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]], ang = Math.atan2((b[1] - a[1]) * r.height, (b[0] - a[0]) * r.width);
      const x = b[0] * r.width, y = b[1] * r.height, L = 12;
      h += `<path d="M${x - L * Math.cos(ang - 0.5)} ${y - L * Math.sin(ang - 0.5)} L${x} ${y} L${x - L * Math.cos(ang + 0.5)} ${y - L * Math.sin(ang + 0.5)}" fill="none" style="${ink}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    s.innerHTML = h;
  }

  function padEvents(pad) {
    const at = e => { const r = pad.getBoundingClientRect(); return { u: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), v: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
    pad.addEventListener('pointerdown', e => {
      if (!cur) return;
      pad.setPointerCapture(e.pointerId);
      const p = at(e), t = performance.now();
      down = { pts: [[p.u, p.v]], t0: t, last: t, lu: p.u, lv: p.v, s: 0 };
      touchDot(p);
      if (cur.pad === 'steer') { pos = p; placeDot(); send(cur.k, steady(), true); }
      if (cur.pad === 'hold') { pos = p; send(cur.k, { u: r3(p.u), v: r3(p.v), on: 1 }, true); svgPath([[p.u - 0.001, p.v], [p.u, p.v]]); }
      if (cur.pad === 'draw' || cur.pad === 'swipe') clearSvg();
    });
    pad.addEventListener('pointermove', e => {
      if (!down || !cur) return;
      const p = at(e), t = performance.now(), dts = Math.max(1, t - down.last) / 1000;
      const sp = Math.hypot(p.u - down.lu, (p.v - down.lv) * 9 / 16) / dts;     // box widths per second
      down.s = down.s * 0.7 + Math.min(1, sp / 2.5) * 0.3; down.last = t; down.lu = p.u; down.lv = p.v;
      touchDot(p);
      if (cur.pad === 'steer') { pos = p; placeDot(); send(cur.k, steady()); }
      if (cur.pad === 'hold') { pos = p; send(cur.k, { u: r3(p.u), v: r3(p.v), on: 1, s: r3(down.s) }); down.pts.push([p.u, p.v]); if (down.pts.length > 40) down.pts.shift(); svgPath(down.pts, true); }
      if (cur.pad === 'draw' || cur.pad === 'swipe') {
        const q = down.pts[down.pts.length - 1];
        if (Math.hypot(p.u - q[0], p.v - q[1]) > 0.01) { down.pts.push([p.u, p.v]); svgPath(down.pts, false, cur.pad === 'swipe'); }
      }
    });
    const up = e => {
      if (!down || !cur) { down = null; return; }
      const p = at(e), pts = down.pts, dur = (performance.now() - down.t0) / 1000;
      if (cur.pad === 'hold') { send(cur.k, { on: 0 }, true); clearSvg(); }
      if (cur.pad === 'draw' && pts.length > 3) {
        // at most 48 points, evenly along the stroke
        const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        const L = cum[cum.length - 1], n = Math.min(48, pts.length), out = [];
        for (let k = 0, j = 0; k < n; k++) { const d = L * k / (n - 1); while (j < cum.length - 2 && cum[j + 1] < d) j++; const a = pts[j], b = pts[j + 1] || a, t = (d - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]); out.push([r3(a[0] + (b[0] - a[0]) * Math.min(1, t)), r3(a[1] + (b[1] - a[1]) * Math.min(1, t))]); }
        if (L > 0.08) { send('shape', { pts: out, once: 1 }, true); svgPath(out, true); if (navigator.vibrate) navigator.vibrate(20); }
      }
      if (cur.pad === 'swipe') {
        const a = pts[0], du = p.u - a[0], dv = (p.v - a[1]) * 9 / 16, L = Math.hypot(du, dv);
        if (L > 0.06) {
          const s = Math.min(1.6, Math.max(0.3, (L / Math.max(0.08, dur)) / 1.6));
          send('gust', { u: r3(a[0]), v: r3(a[1]), du: r3(du / L), dv: r3(dv / L), s: r3(s), once: 1 }, true);
          svgPath([a, [p.u, p.v]], false, true); if (navigator.vibrate) navigator.vibrate(20);
          setTimeout(clearSvg, 1200);
        }
      }
      down = null;
      if (!cur.keep) $('#lab-dot').style.display = 'none';
    };
    // your finger, in your colour (a steady control's dot stays where you left it)
    const touchDot = p => { const d = $('#lab-dot'); d.style.display = 'block'; d.style.left = p.u * 100 + '%'; d.style.top = p.v * 100 + '%'; };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  }

  /* ---------------- show / hide: only after "Catch the rain", only while the wall is on Birds or Umbrellas */
  function update() {
    const world = document.getElementById('world');
    const entered = !world || world.classList.contains('hidden');
    const want = entered && !!IDEAS[mode] && (forced || Date.now() - artSeen < 20000);
    if (want !== shown || (want && !$('#lab-title').textContent.includes(IDEAS[mode].title))) {
      if (!want) stopCur(), cur = null;
      shown = want;
      if (want) render();
    }
    $('#lab').classList.toggle('hidden', !want || collapsed);
    $('#lab-open').classList.toggle('hidden', !want || !collapsed);
    // steady controls keep saying they are there (the wall forgets a silent one after a few seconds)
    const now = performance.now();
    if (want && cur && cur.keep && now - keepT > 1000) { keepT = now; send(cur.k, steady(), true); }
    if (want && cur && cur.pad === 'hold' && down && now - keepT > 250) { keepT = now; send(cur.k, { u: r3(pos.u), v: r3(pos.v), on: 1, s: r3(down.s) }, true); }
  }

  return {
    init(o) {
      net = o.net; ME = o.ME; colorIdx = o.color;
      build();
      setInterval(update, 250);
      addEventListener('pagehide', stopCur);
    },
    onArt(m) {
      if (!m || forced) return;
      if (m.at && Math.abs(Date.now() - m.at) > 60000) return;     // an old retained message: the wall isn't running
      artSeen = Date.now();
      const nm = m.name || 'map';
      if (nm !== mode) { stopCur(); cur = null; mode = nm; shown = false; }
    },
  };
})();
