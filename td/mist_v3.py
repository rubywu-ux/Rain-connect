# ---- Connect the Rain: mist detection v3 (finds the mist by itself). Run in the Textport; safe to repeat.
#  Mist never sits still: it flickers all the time, while the pot, the table and the room do not.
#  So the detector keeps a slow "flicker map" of the picture, picks out the pixels that flicker
#  clearly more than the room's own camera noise, and fits an OVAL around them: that is the mist
#  (the pot opening). Only what happens inside the oval counts. No calibration needed.
#    presence = how much of the oval is filled with flickering mist   -> mist on / off
#    motion   = how strongly the mist inside the oval is changing      -> calm / rain / storm
#    big sudden changes (a hand, an arm) are ignored and drawn red.
import os, re
CR = op('/project1/connect_rain')
assert CR is not None, 'open ConnectTheRain first'
page = next((p for p in CR.customPages if p.name == 'Mist'), None) or CR.appendCustomPage('Mist')
def _f(name, label, default, lo, hi, force=False):
	p = getattr(CR.par, name, None)
	if p is None:
		p = page.appendFloat(name, label=label)[0]; p.val = default
	elif force: p.val = default
	p.label = label; p.default = default; p.normMin, p.normMax = lo, hi
	return p
def _t(name, label, default):
	p = getattr(CR.par, name, None)
	if p is None: p = page.appendToggle(name, label=label)[0]; p.val = default
	p.label = label
	return p
_f('Mistlevel', 'Mist threshold (x room noise)', 3.0, 1.2, 10, force=True)
_f('Presence', 'Mist amount for full (share of the oval)', 0.35, 0.05, 1, force=True)
_f('Motionlow', 'Mist motion: still below', 0.008, 0, 0.1, force=True)
_f('Motionhigh', 'Mist motion: frantic at', 0.045, 0.005, 0.3, force=True)
_f('Smooth', 'Response (0 fast .. 1 slow)', 0.75, 0, 0.98)
_f('Solid', 'Ignore sudden changes bigger than (hands)', 0.25, 0.05, 1)
_t('Potauto', 'Find the pot oval by itself', True)
_f('Roix', 'Oval centre x (when not automatic)', 0.5, 0, 1); _f('Roiy', 'Oval centre y (when not automatic)', 0.55, 0, 1)
_f('Roiw', 'Oval width (when not automatic)', 0.35, 0.05, 1); _f('Roih', 'Oval height (when not automatic)', 0.3, 0.05, 1)
if getattr(CR.par, 'Calibrate', None) is not None: CR.par.Calibrate.label = 'Re-learn (forget where the mist was)'
if getattr(CR.par, 'Debug', None) is None: page.appendToggle('Debug', label='Debug view (what the camera counts)')

wx = CR.op('mist_weather')
wx.text = """import json
import numpy as np
BASE = 'rainconnect/rubywu-ux-k7q2/gallery/'
W = {'w': 0.0, 'n': 0, 'prev': None, 'flick': None, 'ell': None}
def _set(k, v):
	t = op('state')
	if t is not None and t.row(k) is not None: t[k, 1] = v
def reset():
	W['flick'] = None; W['ell'] = None; W['prev'] = None
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
	dm = np.where(solid, 0, d)
	fl = W['flick'] if W['flick'] is not None and W['flick'].shape == lum.shape else np.zeros_like(lum)
	fl = fl * 0.93 + dm * 0.07                        # ~1.5 s memory of how much each pixel flickers
	W['flick'] = fl
	noise = float(np.median(fl)) + 1e-4
	mistmap = (fl > noise * float(c.par.Mistlevel)) & (fl > 0.003)
	# the oval: automatic = fitted around the flickering mist; otherwise from the settings
	if c.par.Potauto:
		ys, xs = np.nonzero(mistmap)
		if len(xs) >= 6:
			wt = fl[ys, xs]; s = wt.sum()
			cx, cy = float((xs * wt).sum() / s), float((ys * wt).sum() / s)
			cxx = float(((xs - cx) ** 2 * wt).sum() / s); cyy = float(((ys - cy) ** 2 * wt).sum() / s); cxy = float(((xs - cx) * (ys - cy) * wt).sum() / s)
			ev, evec = np.linalg.eigh(np.array([[cxx, cxy], [cxy, cyy]]))
			a, b = 2.2 * np.sqrt(max(ev[1], 0.5)), 2.2 * np.sqrt(max(ev[0], 0.5))
			th = float(np.arctan2(evec[1, 1], evec[0, 1]))
			new = np.array([cx, cy, a, b, th], np.float32)
			W['ell'] = new if W['ell'] is None else W['ell'] * 0.9 + new * 0.1
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
	moving = inside & mistmap
	m = float(dm[moving].mean()) if moving.any() else 0.0
	lo, hi = float(c.par.Motionlow), float(c.par.Motionhigh)
	mot = max(0.0, min(1.0, (m - lo) / max(1e-4, hi - lo)))
	raw = 0.0 if pres < 0.15 else 0.3 * pres + 0.7 * pres * mot
	k = float(c.par.Smooth)
	W['w'] = W['w'] * k + raw * (1 - k)
	hand = float(solid.sum()) / (h * w)
	label = 'CALM - no mist' if W['w'] < 0.25 else ('RAIN - mist, still' if W['w'] < 0.6 else 'STORM - mist moving')
	_set('mist_on', 'on' if c.par.Mist else 'off'); _set('mist_bright', round(frac, 3)); _set('mist_motion', round(m, 4)); _set('weather', round(W['w'], 2))
	if c.par.Debug:
		rgba = np.zeros((h, w, 4), np.float32)
		if r2 is not None: rgba[~inside] = (0, 0, 0, 0.55)                     # outside the oval: dimmed
		rgba[mistmap & ~inside] = (0.15, 0.75, 1.0, 0.18)                      # flicker outside the pot (ignored)
		rgba[mistmap & inside] = (0.15, 0.75, 1.0, 0.5)                        # cyan: mist
		rgba[moving & (dm > lo)] = (0.2, 1.0, 0.35, 0.8)                       # green: mist that is moving
		rgba[solid] = (1.0, 0.15, 0.1, 0.8)                                    # red: hands (ignored)
		if r2 is not None: rgba[(r2 > 0.8) & (r2 < 1.25)] = (1.0, 0.85, 0.1, 1.0)   # yellow: the oval
		c.store('mist_dbg_img', np.ascontiguousarray(np.flipud(rgba)))
		op('mist_dbg').cook(force=True)
		t = op('mist_dbg_text')
		if t is not None:
			t.par.text = ('%s\\nmist fills %3.0f%% of the oval   presence %.2f\\nmist motion %.3f  -> %.2f\\nhands ignored %3.0f%%\\nweather %.2f   %s'
				% (label, frac * 100, pres, m, mot, hand * 100, W['w'], 'oval: found automatically' if c.par.Potauto else 'oval: from settings'))
	W['n'] += 1
	if W['n'] % 2: return                                                    # ~5 messages a second
	try:
		op('mqtt').publish(BASE + 'weather', json.dumps({'w': round(W['w'], 3)}).encode())
	except Exception as e:
		if W['n'] % 50 == 0: print('weather publish:', e)
"""
px = CR.op('mist_pars')
px.text = px.text.replace("""		W = op('mist_weather').module.W
		bg = W.get('avg')
		if bg is not None:
			parent().store('mist_bg', bg.copy())
			print('mist calibrated: empty-room picture stored (%dx%d). Now turn the mist on.' % (bg.shape[1], bg.shape[0]))""",
"""		op('mist_weather').module.reset()
		print('mist detector: forgot the old oval, finding the mist again')""")
CR.op('mist_weather').module.reset()
me.time.play = True
d = os.path.expanduser('~/Desktop/ConnectTheRain')
nums = [int(m.group(1)) for f in os.listdir(d) for m in [re.match(r'ConnectTheRain\\.(\\d+)\\.toe$', f)] if m]
project.save(os.path.join(d, 'ConnectTheRain.%d.toe' % (max(nums + [5]) + 1)))
print('MIST v3 READY: the yellow oval should settle on the pot within a few seconds once the mist is on.', project.name)
