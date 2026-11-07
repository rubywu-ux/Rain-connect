# ---- Connect the Rain: mist detection v5 (tuned on 15 recorded clips). Run in the Textport; safe to repeat.
#  v5: the mist maker's colour-changing light no longer looks like moving mist (each frame is matched
#  to the last one for brightness first); the pot found with the lights on is kept when the room goes
#  dark (or found by its glow if it never saw it lit); while a hand or arm is in view the mist movement
#  is not counted (the mist it stirred still counts once the hand is gone).
# ---- v4: finds the POT by its fixed rim.
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
_pg0 = next((p for p in CR.customPages if p.name == 'Mist'), None)
if getattr(CR.par, 'Stormx', None) is None:
	_sx = _pg0.appendFloat('Stormx', label='Storm when mist moves this many times more than when still')[0]
	_sx.default = 2.5; _sx.val = 2.5; _sx.normMin, _sx.normMax = 1.5, 6
if abs(CR.par.Motionhigh.eval() - 0.03) < 1e-6: CR.par.Motionhigh = 0.045
_pg = next((p for p in CR.customPages if p.name == 'Mist'), None)
if getattr(CR.par, 'Teststorm', None) is None: _pg.appendPulse('Teststorm', label='Test storm (5 s of lightning + thunder)')
_px = CR.op('mist_pars')
if "Teststorm" not in _px.text:
	_px.text = _px.text.replace("def onPulse(par):", '''def onPulse(par):
	if par.name == 'Teststorm':
		op('mist_weather').module.W['test'] = absTime.seconds + 5
		print('test storm for 5 s: the wall should flash and thunder')''', 1)
_pp = _px.par.pars.eval().split()
if 'Teststorm' not in _pp: _px.par.pars = ' '.join(_pp + ['Teststorm'])
if "module.calibrate()" not in _px.text:         # v5: Calibrate = learn the EMPTY pot (mist off) in this light
	_px.text = _px.text.replace("def onPulse(par):", '''def onPulse(par):
	if par.name == 'Calibrate':
		op('mist_weather').module.calibrate()
		return''', 1)
_pp = _px.par.pars.eval().split()
if 'Calibrate' not in _pp: _px.par.pars = ' '.join(_pp + ['Calibrate'])
try: CR.par.Calibrate.label = 'Calibrate: press with the mist OFF (pot clear), in the show light'
except Exception: pass
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
try:
    W['cal'] = dict(parent().fetch('mist_cal', {}, search=False))   # Calibrate (no mist) survives restarts
except Exception:
    W['cal'] = {}
def _cl(x): return max(0.0, min(1.0, float(x)))
def calibrate():
    # press with the mist maker OFF (and the pot clear), in the light the show will have
    W['calt'] = absTime.seconds + 3.0; W['cals'] = []
    print('calibrating for 3 s: mist off, hands away...')
def find_opening2(lum, rel=0.62):
    # Pot opening from any camera angle.
    # 1. The bright inside (the mist) is a hole in the dark pot: rim around it, body below it.
    # 2. From the side the back of the inside is dark too, so the hole is only the lower part of the
    # opening: grow it up to the top of the rim, and out to the sides of the pot at that height.
    # Falls back to the pot's outer outline (seen from straight above, when the rim has gaps).
    h, w = lum.shape
    base = lum < rel * float(np.median(lum))
    base = dilate(erode(base, 1), 1)                 # thin dark lines (the cable) removed
    for r in (1, 2, 3):
        dark = erode(dilate(base, r), r)             # close gaps in the rim, more each try
        holes = fill_holes(dark) & ~dark
        lab, info = components(holes)
        cand = [cc for cc in info if not cc[2] and cc[0] > 0.004 * h * w]
        if cand: break
    else:
        r2 = find_pot2(lum, rel)
        if r2 is None: return None
        cx, cy, a, b, th = r2[:5]
        return cx, cy, a * 0.85, b * 0.85, th, 'outline'   # just inside the rim
    reg = fill_holes(lab == max(cand)[1])
    ys, xs = np.nonzero(reg)
    hx0, hx1, hy0, hy1 = xs.min(), xs.max(), ys.min(), ys.max()
    hcx = xs.mean()
    # the dark pot around the hole
    dl, dinfo = components(dark)
    ring = np.zeros_like(dark)
    for yy, xx in ((hy0 - 1, int(hcx)), (hy1 + 1, int(hcx)), (int(ys.mean()), hx0 - 1), (int(ys.mean()), hx1 + 1)):
        if 0 <= yy < h and 0 <= xx < w and dark[yy, xx]: ring |= dl == dl[yy, xx]
    if not ring.any(): ring = dilate(reg, 2) & dark
    # top of the rim above the hole (search only columns over the middle of the hole)
    c0, c1 = int(hcx - (hx1 - hx0) * 0.25), int(hcx + (hx1 - hx0) * 0.25) + 1
    top = hy0
    for y in range(hy0, -1, -1):
        if ring[y, c0:c1].any(): top = y
        elif y < hy0 - 2 and not ring[max(0, y - 1), c0:c1].any(): break
    bottom = hy1
    cy = (top + bottom) / 2
    row = int(round((top + 2 * bottom) / 3))
    xs_r = np.nonzero(ring[row])[0]
    if len(xs_r) >= 2: left, right = xs_r.min(), xs_r.max()
    else: left, right = hx0, hx1
    left, right = min(left, hx0), max(right, hx1)
    cx = (left + right) / 2
    a = (right - left) / 2 * 0.94
    b = max((bottom - top) / 2, (hy1 - hy0) / 2)
    return float(cx), float(cy), float(a), float(b), 0.0, 'hole'

def _axis(e):
    # keep the oval's angle within +-45 deg (swap the axes otherwise), so results from the two ways of
    # finding the pot can be averaged
    cx, cy, a, b, th = e[:5]
    th = (th + np.pi / 2) % np.pi - np.pi / 2
    if abs(th) > np.pi / 4: a, b = b, a; th = th - np.sign(th) * np.pi / 2
    return cx, cy, a, b, th

def find_glow(M):
    # dark room: the opening is the glowing part (the mist maker's light on the mist), over the last few
    # seconds. That is mostly the lower middle of the opening, so the oval is grown a little and moved up.
    h, w = M.shape
    hi = float(np.percentile(M, 99.5)); lo = float(np.median(M))
    if hi - lo < 0.12: return None
    m = dilate(erode(M > lo + 0.3 * (hi - lo), 1), 1)
    lab, info = components(m)
    cand = [c for c in info if c[0] > 0.004 * h * w]
    if not cand: return None
    reg = lab == max(cand)[1]
    near = dilate(reg, 4)
    for cnt, n, b in info:
        if cnt > 0.002 * h * w and (near & (lab == n)).any(): reg |= lab == n
    reg = fill_holes(dilate(reg, 2))
    ys, xs = np.nonzero(reg)
    x0, x1, y0, y1 = np.percentile(xs, 1), np.percentile(xs, 99), np.percentile(ys, 1), np.percentile(ys, 99)
    a, b = (x1 - x0) / 2 * 1.4, (y1 - y0) / 2 * 1.4
    return float((x0 + x1) / 2), float((y0 + y1) / 2 - 0.2 * b), float(a), float(b), 0.0, 'glow'

def _set(k, v):
	t = op('state')
	if t is not None and t.row(k) is not None: t[k, 1] = v
def reset():
	W['flick'] = None; W['ell'] = None; W['prev'] = None; W['pot'] = None; W['bad'] = 0; W['pm'] = 0.0; W['ps'] = 0.0; W['mb'] = None; W['eh'] = []; W['es'] = 0.0; W['mh'] = 0.0; W['gmax'] = None; W['ht'] = -99.0; W['how'] = ''; W['eq'] = []
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
	if W['prev'] is not None and W['prev'].shape == lum.shape and float(np.abs(lum - W['prev']).max()) < 1e-6:
		return                                         # the camera gave the same picture again: nothing new
	prev = W['prev'] if W['prev'] is not None and W['prev'].shape == lum.shape else lum
	W['prev'] = lum
	d = np.abs(lum - prev)
	d = np.maximum(0, d - np.median(d))               # the camera's own brightness shifts affect everything: remove them
	# the oval: automatic = the pot itself, found by its dark rim and body (fixed, unlike the mist maker);
	# looked for every ~2 s, so tilting the camera (round <-> oval) is followed. Otherwise from the settings.
	if c.par.Potauto:
		if W['n'] % 20 and W.get('gmax') is not None and W['n'] % 4 == 0:
			try:
				pl_ = np.flipud(op('cam_pot').numpyArray()[:, :, 0]).astype(np.float32)
				if pl_.shape == W['gmax'].shape: W['gmax'] = np.maximum(W['gmax'] * 0.98, pl_)
			except Exception:
				pass
		if W['n'] % 20 == 0 or W['pot'] is None:
			try:
				big = op('cam_pot').numpyArray()
				pl = np.flipud(big[:, :, 0]).astype(np.float32)
				dark = float(np.median(pl)) < 0.25            # lights down: the room is darker than the pot's glow
				gm = W.get('gmax')
				W['gmax'] = gm = pl.copy() if gm is None or gm.shape != pl.shape else np.maximum(gm * 0.98, pl)
				if not dark: r = find_opening2(pl)
				elif W['pot'] is None: r = find_glow(gm)          # never saw it lit: find it by its glow
				else: r = None                                    # keep the pot found with the lights on
				if r is not None and r[5] == 'hole': W['hole_t'] = absTime.seconds
				# an empty pot (no bright mist) only shows its outline, which from the side is the whole
				# body: keep the opening found with mist in it (for 2 minutes; the camera may have moved)
				if r is not None and r[5] == 'outline' and absTime.seconds - W.get('hole_t', -1e9) < 120 and W['pot'] is not None: r = None
				if r is not None: W['how'] = r[5]; r = _axis(r) + (r[5],)
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
			p = W['pot']; W['ell'] = np.array([p[0], p[1], p[2] * 0.97, p[3] * 0.97, p[4]], np.float32)   # the opening
	else:
		W['ell'] = np.array([c.par.Roix * w, c.par.Roiy * h, c.par.Roiw * w / 2, c.par.Roih * h / 2, 0], np.float32)
	ell = W['ell']
	if ell is not None:
		r2 = _oval(h, w, *[float(x) for x in ell])
		inside = r2 < 1
	else:
		r2 = None; inside = np.zeros(lum.shape, bool)
	# a hand / an arm = a big, sudden change that reaches in from OUTSIDE the pot (an arm always does).
	# Big changes that stay inside the rim are the mist being blown or stirred: they count.
	# Mist that is blown hard can jump a lot and spill over the rim: that still counts.
	# An arm is different: it comes in from the edge of the picture, so its change reaches the border
	# (or covers a lot of the picture far from the pot).
	big = d > float(c.par.Solid)
	solid = np.zeros(lum.shape, bool)                 # (changes outside the pot don't count anyway)
	if big.any() and r2 is not None:
		# grow from the big changes into weaker ones next to them: over bright mist an arm only
		# differs a little, but it is still one connected shape reaching in from the edge
		low = d > 0.45 * float(c.par.Solid)
		lab, info = components(low)
		far = r2 > 2.6                                # far from the pot
		need = max(8, int(0.01 * h * w))
		for cnt, n, border in info:
			comp = lab == n
			if not (comp & big).any(): continue
			if border or (comp & far & big).sum() >= need: solid |= comp

	near = solid.copy()                               # ...and the blurry edges around it (2 px)
	for dy in (-2, -1, 1, 2):
		near |= np.roll(solid, dy, 0)
	nv = near.copy()
	for dx in (-2, -1, 1, 2):
		near |= np.roll(nv, dx, 1)
	sm = W.get('solidmem')
	sm = near.astype(np.float32) if sm is None or sm.shape != near.shape else np.maximum(sm * 0.85, near.astype(np.float32))
	W['solidmem'] = sm                                # where a hand was a moment ago stays ignored briefly
	handzone = sm > 0.2
	dm = np.where(handzone, 0, d)
	# the mist maker's light fades between colours: the whole inside gets brighter or darker together.
	# Match this frame to the last one for brightness inside the oval first (a gain and an offset), so
	# only real movement is left.
	sel = inside & ~handzone
	if sel.sum() > 12:
		l_, p_ = lum[sel], prev[sel]
		A_ = np.stack([p_, np.ones_like(p_)], 1)
		co_ = np.linalg.lstsq(A_, l_, rcond=None)[0]
		dm = dm.copy(); dm[sel] = np.abs(l_ - A_ @ co_)
	# a hand or an arm in view: big changes outside the pot (not below it, where blown mist runs down
	# the pot's side). While it is there, and a moment after, the mist movement is not counted.
	if r2 is not None:
		yy_, xx_ = np.mgrid[0:h, 0:w]
		cx_, cy_, a_ = float(ell[0]), float(ell[1]), float(max(ell[2], ell[3]))
		outz = (r2 > 2.6) & ~((np.abs(xx_ - cx_) < a_ * 1.2) & (yy_ > cy_))
		rel_ = d / (np.maximum(lum, prev) + 0.08)
		Hv = float(((d > 0.05) | (rel_ > 0.25))[outz].mean()) if outz.any() else 0.0
	else:
		Hv = 0.0
	W['hv'] = Hv
	# in a lit room it must also reach over the pot (an arm does; a head leaning in to blow doesn't).
	# In the dark an arm barely shows, so any big change around the pot counts.
	reach = r2 is not None and bool((handzone & (r2 < 1.3)).any())
	if Hv > 0.02 and (W.get('dk') or reach): W['ht'] = absTime.seconds
	handnow = absTime.seconds - W.get('ht', -99.0) < 0.8
	fl = W['flick'] if W['flick'] is not None and W['flick'].shape == lum.shape else np.zeros_like(lum)
	if not handnow: fl = fl * 0.93 + dm * 0.07        # ~1.5 s memory of how much each pixel flickers
	fl = np.where(handzone, 0, fl)                    # where an arm passed, forget the flicker it caused
	W['flick'] = fl
	noise = float(np.median(fl)) + 1e-4
	mistmap = (fl > noise * float(c.par.Mistlevel)) & (fl > 0.003)
	area = max(1, int(inside.sum()))
	frac = float((mistmap & inside).sum()) / area
	# is there mist? Compared with the room around the pot (so it works in any light):
	#  - flicker: mist always shimmers a little, an empty pot doesn't (middle of the opening vs the room)
	#  - glow: in a dark room the mist maker's light on the mist makes the opening glow
	#  - in a lit room an empty pot is dark inside; mist makes it lighter
	# After Calibrate (pressed with no mist) both are compared with the empty pot instead.
	pres = 0.0
	if ell is not None:
		core = r2 < 0.7; room = r2 > 4.0
		if core.sum() > 4 and room.sum() > 20:
			rl = float(np.median(lum[room]))
			bri = float(lum[core].mean()) / (rl + 0.03)
			fr = float(np.median(fl[core])) / (float(np.median(fl[room])) + 1e-4)
			dk = rl < 0.25
			W['pb'], W['pf'], W['dk'] = bri, fr, dk
			cal = W.get('cal', {}).get(dk); W['calok'] = False
			if cal is not None:                                   # the camera must not have moved since
				g_ = cal['rl'] / max(rl, 0.02)
				ok_ = False
				if cal['ref'].shape == lum.shape:
					a_ = lum[room] * g_; b_ = cal['ref'][room]
					a_ = a_ - a_.mean(); b_ = b_ - b_.mean()
					ncc_ = float((a_ * b_).sum() / (np.sqrt(float((a_ * a_).sum()) * float((b_ * b_).sum())) + 1e-6))
					W['calncc'] = ncc_
					# the room around the pot must still look the same (same camera angle); otherwise ignore it
					ok_ = ncc_ > 0.8 and float(np.abs(lum[room] * g_ - cal['ref'][room]).mean()) < 0.08 * (cal['rl'] + 0.05) / 0.5 + 0.02
				W['calok'] = ok_
				if not ok_: cal = None
			if cal is not None:
				# compared with the empty pot: mist makes the opening lighter (and shimmer more)
				dl_ = float((lum[core] * g_ - cal['ref'][core]).mean()) / (cal['rl'] + 0.03)
				fc_ = float(np.median(fl[core])) / (float(np.median(cal['fl'][core])) + 1e-4)
				W['pc'] = dl_
				pres = max(_cl((dl_ - 0.05) / 0.1), _cl((fc_ - 1.8) / 1.5))
			else:
				pf = _cl((fr - 1.4) / 1.6)
				pres = max(pf, _cl((bri - 1.2) / 0.8)) if dk else pf * _cl((bri - 0.2) / 0.1)
	# Calibrate: 3 s of the EMPTY pot -> its picture and how much each pixel shimmers, for this light
	if W.get('cals') is not None and not handnow:
		if absTime.seconds < W.get('calt', 0): W['cals'].append((lum.copy(), fl.copy()))
		elif len(W['cals']) > 5:
			rf_ = np.mean([q[0] for q in W['cals']], 0); ff_ = np.mean([q[1] for q in W['cals']], 0)
			rm_ = (r2 > 4.0) if r2 is not None else np.ones(lum.shape, bool)
			dk_ = float(np.median(rf_[rm_])) < 0.25
			W.setdefault('cal', {})[dk_] = {'ref': rf_.astype(np.float32), 'fl': ff_.astype(np.float32), 'rl': float(np.median(rf_[rm_]))}
			W['cals'] = None
			try: c.store('mist_cal', dict(W['cal']))
			except Exception: pass
			print('mist calibrated for a %s room (empty pot stored). Now turn the mist on.' % ('dark' if dk_ else 'lit'))
	moving = inside & mistmap & ~handzone
	m = float(dm[moving].mean()) if moving.any() else 0.0
	lo, hi = float(c.par.Motionlow), float(c.par.Motionhigh)
	# how much more the mist is moving than when it is left alone. The total movement inside the oval
	# (steadier than a per-pixel average) is smoothed a little, and compared with what the detector has
	# learned is "still" for THIS camera, light and mist maker: the quiet end of the last ~20 s.
	E = float(dm[inside & ~handzone].mean()) if (inside & ~handzone).any() else 0.0
	# the light switching colour can still jump for a frame or two: take the middle of the last 5 frames
	# (a blow moves the mist for longer than that)
	eq = W.get('eq')
	if eq is None: eq = W['eq'] = []
	if not handnow:
		eq.append(E)
		if len(eq) > 5: del eq[0]
		W['es'] = W.get('es', 0.0) * 0.7 + float(np.median(eq)) * 0.3
	es = W['es']
	eh = W.get('eh')
	if eh is None: eh = W['eh'] = []
	if W.get('pm', 0) > 0.2 and not handnow:
		eh.append(es)
		if len(eh) > 200: del eh[:20]
	mb = float(np.percentile(eh, 25)) if len(eh) >= 30 else None
	W['mb'] = mb
	sx = max(1.5, float(c.par.Stormx))
	if mb:
		mot_now = max(0.0, min(1.0, (es / max(mb, 1e-4) - 1.4) / (sx - 1.4)))
	else:                                                    # still learning (first ~3 s of mist): fixed levels
		mot_now = max(0.0, min(1.0, (m - lo) / max(1e-4, hi - lo)))
	if handnow: mot_now = 0.0                                # a hand in view: not counted
	W['mh'] = max(mot_now, W.get('mh', 0.0) * 0.9)           # a blow is gusty: hold it for a moment
	mot = W['mh']
	# where in the pot the mist is moving (for the art modes): -1..1 across the oval
	if moving.any() and ell is not None:
		ys_, xs_ = np.nonzero(moving); wt_ = dm[ys_, xs_] + 1e-6
		W['mx'] = float(((xs_ * wt_).sum() / wt_.sum() - ell[0]) / max(1.0, ell[2]))
		W['my'] = float(((ys_ * wt_).sum() / wt_.sum() - ell[1]) / max(1.0, ell[3]))
	W['e'] = W.get('e', 0.0) * 0.5 + mot_now * 0.5
	# blowing hard clears mist out of the pot for a moment: remember that there WAS mist for a few
	# seconds, so a hard blow reads as a storm instead of "no mist"
	if not handnow: W['ps'] = W.get('ps', 0.0) * 0.9 + pres * 0.1   # steady mist, not a brief flicker (a hand passing)
	W['pm'] = max(W['ps'], W.get('pm', 0.0) * 0.97)
	pm = W['pm']
	# any amount of mist can make a storm: the amount sets the rain, the movement sets the storm
	# v5: mist is either there or not: any steady mist = rain (0.32), movement on top of it = storm
	raw = 0.0 if pm < 0.1 else 0.32 * _cl((pm - 0.1) / 0.15) + 0.68 * mot
	hist = W.get('hist')
	if hist is None: hist = W['hist'] = []
	hist.append((round(frac, 3), round(es, 4), round(mot, 2), round(pm, 2), round(W['w'], 2)))
	if len(hist) > 400: del hist[:100]
	if W.get('test', 0) > absTime.seconds: raw = 1.0                  # Test storm button
	k = float(c.par.Smooth)
	W['w'] = W['w'] * k + raw * (1 - k)
	hand = float(handzone.sum()) / (h * w)
	label = 'CALM - no mist' if W['w'] < 0.25 else ('RAIN - mist, still' if W['w'] < 0.6 else 'STORM - mist moving  (lightning + thunder)')
	if handnow: label += '   [hand in view: ignored]'
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
			rgba[(pr > 0.9) & (pr < 1.12)] = (1.0, 0.85, 0.1, 1.0)                # yellow: the pot opening it found
		c.store('mist_dbg_img', np.ascontiguousarray(np.flipud(rgba)))
		op('mist_dbg').cook(force=True)
		t = op('mist_dbg_text')
		if t is not None:
			t.par.text = ('%s\\nmist fills %3.0f%% of the oval   presence %.2f\\nmist motion %.3f (still %.3f) -> %.2f\\nhands ignored %3.0f%%\\nweather %.2f   %s'
				% (label, frac * 100, pres, es, W.get('mb') or 0, mot, hand * 100, W['w'], (('pot opening: found' + (' by its glow' if W.get('how') == 'glow' else '') + ('  (calibrated)' if W.get('calok') else ('' if W.get('dk') else '  - press Calibrate with the mist off'))) if W['pot'] is not None else 'pot: looking...') if c.par.Potauto else 'oval: from settings'))
	W['n'] += 1
	if W['n'] % 2: return                                                    # ~5 messages a second
	try:
		op('mqtt').publish(BASE + 'weather', json.dumps({'w': round(W['w'], 3), 'e': round(W.get('e', 0), 2), 'x': round(W.get('mx', 0), 2), 'y': round(W.get('my', 0), 2)}).encode())
	except Exception as e:
		if W['n'] % 50 == 0: print('weather publish:', e)
"""
CR.op('mist_weather').module.reset()
me.time.play = True
d = os.path.expanduser('~/Desktop/ConnectTheRain')
nums = [int(m.group(1)) for f in os.listdir(d) for m in [re.match(r'ConnectTheRain\.(\d+)\.toe$', f)] if m]
project.save(os.path.join(d, 'ConnectTheRain.%d.toe' % (max(nums + [5]) + 1)))
print('MIST v5 READY: light changes ignored, hands ignored, pot kept in the dark.', project.name)
