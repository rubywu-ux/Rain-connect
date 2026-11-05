# ---- Connect the Rain: mist detection v4 (finds the POT by its fixed rim). Run in the Textport; safe to repeat.
#  The mist maker moves around inside the pot, but the pot (its dark rim and body, between the two
#  handles) stays put. Every ~2 s the detector finds the pot's outline, fits an ellipse to it (round
#  from above, oval from an angle) and measures mist only just inside the rim. Mist = flicker there.
import os, re
CR = op('/project1/connect_rain')
assert CR is not None, 'open ConnectTheRain first'
mono = CR.op('cam_mono')
pot = CR.op('cam_pot') or CR.create(resolutionTOP, 'cam_pot')
pot.nodeX, pot.nodeY = -400, 650
pot.setInputs([mono]); pot.par.outputresolution = 'custom'; pot.par.resolutionw = 160; pot.par.resolutionh = 90
CR.par.Potauto.label = 'Find the pot by its rim (automatic)'
CR.par.Potauto = True
CR.par.Solid = 0.18                              # hands over bright mist differ less than over the room
wx = CR.op('mist_weather')
wx.text = """import json
import numpy as np
from collections import deque
def _shift_and(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out &= np.roll(np.roll(m, dy, 0), dx, 1)
    return out
def erode(m, r=1): return _shift_and(m, r)
def dilate(m, r=1): return ~_shift_and(~m, r)
def components(m):
    h, w = m.shape; lab = np.zeros((h, w), np.int32); info = []; n = 0
    for y0, x0 in zip(*np.nonzero(m)):
        if lab[y0, x0]: continue
        n += 1; q = deque([(y0, x0)]); lab[y0, x0] = n; cnt = 0; border = False
        while q:
            y, x = q.popleft(); cnt += 1
            if y == 0 or x == 0 or y == h - 1 or x == w - 1: border = True
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and m[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n; q.append((yy, xx))
        info.append((cnt, n, border))
    return lab, info
def fill_holes(m):
    h, w = m.shape; outside = np.zeros((h, w), bool); q = deque()
    for y in range(h):
        for x in (0, w - 1):
            if not m[y, x] and not outside[y, x]: outside[y, x] = True; q.append((y, x))
    for x in range(w):
        for y in (0, h - 1):
            if not m[y, x] and not outside[y, x]: outside[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
            if 0 <= yy < h and 0 <= xx < w and not m[yy, xx] and not outside[yy, xx]:
                outside[yy, xx] = True; q.append((yy, xx))
    return ~outside

def fit_ellipse(x, y):
    '''Fitzgibbon direct least-squares ellipse fit -> (cx, cy, a, b, theta) or None'''
    D = np.vstack([x * x, x * y, y * y, x, y, np.ones_like(x)]).T
    S = D.T @ D
    C = np.zeros((6, 6)); C[0, 2] = C[2, 0] = 2; C[1, 1] = -1
    try:
        ev, evec = np.linalg.eig(np.linalg.solve(S, C))
    except np.linalg.LinAlgError:
        return None
    ev = np.real(ev); evec = np.real(evec)
    best = None
    for i in range(6):
        p = evec[:, i]
        if 4 * p[0] * p[2] - p[1] ** 2 > 0 and np.isfinite(ev[i]): best = p; break
    if best is None: return None
    A, B, Cc, Dd, E, F = best
    den = B * B - 4 * A * Cc
    cx = (2 * Cc * Dd - B * E) / den; cy = (2 * A * E - B * Dd) / den
    num = 2 * (A * E * E + Cc * Dd * Dd - B * Dd * E + den * F)
    s = np.sqrt((A - Cc) ** 2 + B * B)
    a = -np.sqrt(abs(num * (A + Cc + s))) / den; b = -np.sqrt(abs(num * (A + Cc - s))) / den
    th = 0.5 * np.arctan2(-B, Cc - A)
    a, b = abs(a), abs(b)
    if b > a: a, b = b, a; th += np.pi / 2
    return float(cx), float(cy), float(a), float(b), float(th)

def find_pot2(lum, rel=0.62):
    '''The pot's outline as the camera sees it: dark rim + dark body around the bright inside.
    1. dark pixels (well below the room's typical brightness), thin lines (the cable) removed
    2. the biggest dark piece that doesn't touch the picture's edge, plus dark pieces next to it
    3. from their middle, look out in 72 directions and take the farthest dark pixel: the outline
       (the black mist maker inside is never the farthest, so it doesn't matter where it sits)
    4. fit an ellipse to that outline, dropping stray points, twice'''
    h, w = lum.shape
    dark = lum < rel * float(np.median(lum))
    dark = dilate(erode(dark, 1), 1)
    lab, info = components(dark)
    cand = [c for c in info if not c[2] and c[0] > 0.008 * h * w]
    if not cand: return None
    big = max(cand)[1]
    ys, xs = np.nonzero(lab == big)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    mx, my = (x1 - x0) * 0.35 + 2, (y1 - y0) * 0.6 + 2
    keep = np.zeros_like(dark)
    for cnt, n, border in info:
        if border or cnt < 4: continue
        yy, xx = np.nonzero(lab == n)
        if xx.max() >= x0 - mx and xx.min() <= x1 + mx and yy.max() >= y0 - my and yy.min() <= y1 + my: keep |= lab == n
    ys, xs = np.nonzero(keep)
    cx, cy = xs.mean(), ys.mean()
    ang = np.arctan2(ys - cy, xs - cx); rad = np.hypot(xs - cx, ys - cy)
    bins = np.floor((ang + np.pi) / (2 * np.pi) * 72).astype(int) % 72
    px, py = [], []
    for k in range(72):
        sel = bins == k
        if sel.any():
            i = np.argmax(np.where(sel, rad, -1)); px.append(xs[i]); py.append(ys[i])
    px, py = np.array(px, float), np.array(py, float)
    if len(px) < 12: return None
    e = None
    for _ in range(3):
        e = fit_ellipse(px, py)
        if e is None: return None
        ecx, ecy, a, b, th = e
        u = ((px - ecx) * np.cos(th) + (py - ecy) * np.sin(th)) / a; v = (-(px - ecx) * np.sin(th) + (py - ecy) * np.cos(th)) / b
        r = np.abs(np.sqrt(u * u + v * v) - 1)
        ok = r < max(0.12, 2.0 * np.median(r))
        if ok.sum() < 10 or ok.all(): break
        px, py = px[ok], py[ok]
    return e + (keep, (px, py))

BASE = 'rainconnect/rubywu-ux-k7q2/gallery/'
W = {'w': 0.0, 'n': 0, 'prev': None, 'flick': None, 'ell': None, 'pot': None, 'bad': 0}
def _set(k, v):
	t = op('state')
	if t is not None and t.row(k) is not None: t[k, 1] = v
def reset():
	W['flick'] = None; W['ell'] = None; W['prev'] = None; W['pot'] = None; W['bad'] = 0
def _oval(h, w, cx, cy, a, b, th):
	yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
	dx, dy = xx - cx, yy - cy
	ct, st = np.cos(th), np.sin(th)
	u = (dx * ct + dy * st) / max(a, 0.5); v = (-dx * st + dy * ct) / max(b, 0.5)
	return u * u + v * v                                # < 1 inside the oval
def onFrameStart(frame):
	frame = absTime.frame                              # keeps running even when the timeline is paused
	if frame % 6: return
	c = parent()
	try:
		img = op('cam_blur').numpyArray()              # small grey picture, bottom row first
	except Exception:
		return
	lum = np.flipud(img[:, :, 0]).astype(np.float32)
	h, w = lum.shape
	prev = W['prev'] if W['prev'] is not None and W['prev'].shape == lum.shape else lum
	W['prev'] = lum
	d = np.abs(lum - prev)
	d = np.maximum(0, d - np.median(d))               # the camera's own brightness shifts affect everything: remove them
	solid = d > float(c.par.Solid)                    # a hand / an arm: big, sudden
	near = solid.copy()                               # ...and the blurry edges around it
	for dy in (-2, -1, 1, 2):
		near |= np.roll(solid, dy, 0)
	for dx in (-2, -1, 1, 2):
		near |= np.roll(near, dx, 1)
	sm = W.get('solidmem')
	sm = near.astype(np.float32) if sm is None or sm.shape != near.shape else np.maximum(sm * 0.75, near.astype(np.float32))
	W['solidmem'] = sm                                # where a hand was a moment ago stays ignored briefly
	handzone = sm > 0.2
	dm = np.where(handzone, 0, d)
	fl = W['flick'] if W['flick'] is not None and W['flick'].shape == lum.shape else np.zeros_like(lum)
	fl = fl * 0.93 + dm * 0.07                        # ~1.5 s memory of how much each pixel flickers
	W['flick'] = fl
	noise = float(np.median(fl)) + 1e-4
	mistmap = (fl > noise * float(c.par.Mistlevel)) & (fl > 0.003)
	# the oval: automatic = the pot itself, found by its dark rim and body (fixed, unlike the mist maker);
	# looked for every ~2 s, so tilting the camera (round <-> oval) is followed. Otherwise from the settings.
	if c.par.Potauto:
		if W['n'] % 20 == 0 or W['pot'] is None:
			try:
				big = op('cam_pot').numpyArray()
				pl = np.flipud(big[:, :, 0]).astype(np.float32)
				r = find_pot2(pl)
			except Exception as e:
				r = None
			if r is not None:
				ph, pw = pl.shape
				sx, sy = w / pw, h / ph
				e = np.array([r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy, r[4]], np.float32)
				ok = 0.03 * w < e[2] < 0.7 * w and 0.03 * h < e[3] < 0.8 * h
				if ok and W['pot'] is not None:
					jump = abs(e[0] - W['pot'][0]) + abs(e[1] - W['pot'][1]) > 0.25 * (W['pot'][2] + W['pot'][3])
					if jump and W['bad'] < 2: W['bad'] += 1; ok = False          # a one-off odd result: ignore it
				if ok:
					W['bad'] = 0
					if W['pot'] is not None and abs(((e[4] - W['pot'][4] + np.pi / 2) % np.pi) - np.pi / 2) > 0.6: e[4] = W['pot'][4]
					W['pot'] = e if W['pot'] is None else W['pot'] * 0.6 + e * 0.4
		if W['pot'] is not None:
			p = W['pot']; W['ell'] = np.array([p[0], p[1], p[2] * 0.85, p[3] * 0.85, p[4]], np.float32)   # just inside the rim
	else:
		W['ell'] = np.array([c.par.Roix * w, c.par.Roiy * h, c.par.Roiw * w / 2, c.par.Roih * h / 2, 0], np.float32)
	ell = W['ell']
	if ell is not None:
		r2 = _oval(h, w, *[float(x) for x in ell])
		inside = r2 < 1
	else:
		r2 = None; inside = np.zeros(lum.shape, bool)
	area = max(1, int(inside.sum()))
	frac = float((mistmap & inside).sum()) / area
	pres = min(1.0, frac / max(1e-3, float(c.par.Presence))) if ell is not None else 0.0
	moving = inside & mistmap & ~handzone
	m = float(dm[moving].mean()) if moving.any() else 0.0
	lo, hi = float(c.par.Motionlow), float(c.par.Motionhigh)
	mot = max(0.0, min(1.0, (m - lo) / max(1e-4, hi - lo)))
	raw = 0.0 if pres < 0.15 else 0.3 * pres + 0.7 * pres * mot
	k = float(c.par.Smooth)
	W['w'] = W['w'] * k + raw * (1 - k)
	hand = float(handzone.sum()) / (h * w)
	label = 'CALM - no mist' if W['w'] < 0.25 else ('RAIN - mist, still' if W['w'] < 0.6 else 'STORM - mist moving')
	_set('mist_on', 'on' if c.par.Mist else 'off'); _set('mist_bright', round(frac, 3)); _set('mist_motion', round(m, 4)); _set('weather', round(W['w'], 2))
	if c.par.Debug:
		rgba = np.zeros((h, w, 4), np.float32)
		if r2 is not None: rgba[~inside] = (0, 0, 0, 0.55)                     # outside the oval: dimmed
		rgba[mistmap & ~inside] = (0.15, 0.75, 1.0, 0.18)                      # flicker outside the pot (ignored)
		rgba[mistmap & inside] = (0.15, 0.75, 1.0, 0.5)                        # cyan: mist
		rgba[moving & (dm > lo)] = (0.2, 1.0, 0.35, 0.8)                       # green: mist that is moving
		rgba[handzone] = (1.0, 0.15, 0.1, 0.55)                                 # red: hands (ignored)
		rgba[solid] = (1.0, 0.15, 0.1, 0.85)
		if r2 is not None: rgba[(r2 > 0.85) & (r2 < 1.2)] = (0.15, 0.9, 1.0, 1.0)  # cyan line: where mist is measured
		if W['pot'] is not None:
			pr = _oval(h, w, *[float(x) for x in W['pot']])
			rgba[(pr > 0.88) & (pr < 1.14)] = (1.0, 0.85, 0.1, 1.0)               # yellow: the pot rim it found
		c.store('mist_dbg_img', np.ascontiguousarray(np.flipud(rgba)))
		op('mist_dbg').cook(force=True)
		t = op('mist_dbg_text')
		if t is not None:
			t.par.text = ('%s\\nmist fills %3.0f%% of the oval   presence %.2f\\nmist motion %.3f  -> %.2f\\nhands ignored %3.0f%%\\nweather %.2f   %s'
				% (label, frac * 100, pres, m, mot, hand * 100, W['w'], ('pot: found by its rim' if W['pot'] is not None else 'pot: looking...') if c.par.Potauto else 'oval: from settings'))
	W['n'] += 1
	if W['n'] % 2: return                                                    # ~5 messages a second
	try:
		op('mqtt').publish(BASE + 'weather', json.dumps({'w': round(W['w'], 3)}).encode())
	except Exception as e:
		if W['n'] % 50 == 0: print('weather publish:', e)
"""
CR.op('mist_weather').module.reset()
me.time.play = True
d = os.path.expanduser('~/Desktop/ConnectTheRain')
nums = [int(m.group(1)) for f in os.listdir(d) for m in [re.match(r'ConnectTheRain\.(\d+)\.toe$', f)] if m]
project.save(os.path.join(d, 'ConnectTheRain.%d.toe' % (max(nums + [5]) + 1)))
print('MIST v4 READY: the yellow line should sit on the pot rim; mist is measured inside the cyan line.', project.name)
