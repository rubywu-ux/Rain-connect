# ---- Connect the Rain: mist detection v2 + DEBUG VIEW (run in the Textport, safe to run again).
#  * Mist = pixels brighter than the EMPTY room (per-pixel baseline from Calibrate), inside a view box.
#  * Mist motion = change only where there is mist. Sudden big changes (a hand, an arm) are counted
#    separately as "solid" and ignored, so waving a hand in front of the camera alone does nothing.
#  * Debug view: camera with overlays — cyan = mist, green = mist that is moving, red = hands/solid
#    things being ignored, yellow box = the area being watched — plus the live numbers.
import os
CR = op('/project1/connect_rain')
assert CR is not None, 'open ConnectTheRain first'
page = next((p for p in CR.customPages if p.name == 'Mist'), None) or CR.appendCustomPage('Mist')
def _sp(o, **kw):
	for k, v in kw.items():
		p = getattr(o.par, k, None)
		if p is None: print('  (skip)', o.name, k); continue
		try: p.val = v
		except Exception as e: print('  (skip)', o.name, k, e)
def _mk(t, name, x, y):
	o = CR.op(name) or CR.create(t, name)
	o.nodeX, o.nodeY = x, y
	return o
def _f(name, label, default, lo, hi):
	p = getattr(CR.par, name, None)
	if p is None:
		p = page.appendFloat(name, label=label)[0]; p.val = default
	p.label = label; p.default = default; p.normMin, p.normMax = lo, hi
	return p
_f('Mistlevel', 'Mist: brighter than empty room by', 0.06, 0, 0.4)
_f('Solid', 'Ignore sudden changes bigger than (hands)', 0.3, 0.05, 1)
_f('Roix', 'View box left', 0, 0, 1); _f('Roiy', 'View box top', 0, 0, 1)
_f('Roiw', 'View box width', 1, 0.05, 1); _f('Roih', 'View box height', 1, 0.05, 1)
if getattr(CR.par, 'Debug', None) is None: page.appendToggle('Debug', label='Debug view (what the camera counts)')
# the old knobs, re-meant for the new detector (they could have been left at 0 by the first setup)
for _n, _v in (('Presence', 0.15), ('Motionlow', 0.008), ('Motionhigh', 0.05), ('Smooth', 0.75)):
	if abs(getattr(CR.par, _n).eval()) < 1e-9: setattr(CR.par, _n, _v)
CR.par.Presence.label = 'Mist amount for full (share of view box)'; CR.par.Presence.normMax = 0.6
if abs(CR.par.Presence.eval() - 0.05) < 1e-6: CR.par.Presence = 0.15
CR.par.Motionlow.label = 'Mist motion: still below'
if abs(CR.par.Motionlow.eval() - 0.006) < 1e-6: CR.par.Motionlow = 0.008
CR.par.Motionhigh.label = 'Mist motion: frantic at'

# -- debug picture: a Script TOP paints the overlay from the detector's arrays
cb = _mk(textDAT, 'mist_dbg_cb', 1000, 150)
cb.text = """def onSetupParameters(scriptOp):
	return
def onPulse(par):
	return
def onCook(scriptOp):
	a = parent().fetch('mist_dbg_img', None)
	if a is not None:
		scriptOp.copyNumpyArray(a)
	return
"""
dbg = _mk(scriptTOP, 'mist_dbg', 1200, 150); _sp(dbg, callbacks=cb.path)
up = _mk(resolutionTOP, 'mist_dbg_up', 1400, 150); up.setInputs([dbg]); _sp(up, outputresolution='custom', resolutionw=1280, resolutionh=720)
txt = _mk(textTOP, 'mist_dbg_text', 1400, 0)
_sp(txt, outputresolution='custom', resolutionw=1280, resolutionh=720, text='mist debug', fontsizex=30, alignx='left', aligny='top', bgalpha=0)
_sp(txt, positionx=24, positiony=-20)
camfit = _mk(resolutionTOP, 'mist_dbg_cam', 1400, 300); camfit.setInputs([CR.op('cam')]); _sp(camfit, outputresolution='custom', resolutionw=1280, resolutionh=720)
view = _mk(compositeTOP, 'mist_debug_view', 1600, 150); view.setInputs([txt, up, camfit]); _sp(view, operand='over')
view.viewer = True

# -- the detector (replaces the old brightness/motion averages)
wx = _mk(executeDAT, 'mist_weather', 1000, 500)
wx.text = """import json
import numpy as np
BASE = 'rainconnect/rubywu-ux-k7q2/gallery/'
W = {'w': 0.0, 'n': 0, 'prev': None, 'avg': None}
def _set(k, v):
	t = op('state')
	if t is not None and t.row(k) is not None: t[k, 1] = v
def onFrameStart(frame):
	frame = absTime.frame                      # keeps running even when the timeline is paused
	if frame % 6: return
	c = parent()
	try:
		img = op('cam_blur').numpyArray()      # small grey picture, bottom row first
	except Exception:
		return
	lum = np.flipud(img[:, :, 0]).astype(np.float32)
	h, w = lum.shape
	W['avg'] = lum.copy() if W['avg'] is None or W['avg'].shape != lum.shape else W['avg'] * 0.8 + lum * 0.2
	x0 = int(c.par.Roix * w); y0 = int(c.par.Roiy * h)
	x1 = min(w, max(x0 + 1, int((c.par.Roix + c.par.Roiw) * w))); y1 = min(h, max(y0 + 1, int((c.par.Roiy + c.par.Roih) * h)))
	base = c.fetch('mist_bg', None)
	if base is None or getattr(base, 'shape', None) != lum.shape: base = np.zeros_like(lum)
	prev = W['prev'] if W['prev'] is not None and W['prev'].shape == lum.shape else lum
	W['prev'] = lum
	roi = np.zeros(lum.shape, bool); roi[y0:y1, x0:x1] = True
	lvl = float(c.par.Mistlevel)
	mist = (lum - base > lvl) & roi
	pmist = (prev - base > lvl) & roi
	d = np.abs(lum - prev)
	solid = (d > float(c.par.Solid)) & roi                # big sudden change = a hand / an arm: ignore it
	moving = (mist | pmist) & ~solid
	area = max(1, (y1 - y0) * (x1 - x0))
	frac = float(mist.sum()) / area
	pres = min(1.0, frac / max(1e-3, float(c.par.Presence)))
	m = float(d[moving].mean()) if moving.any() else 0.0
	lo, hi = float(c.par.Motionlow), float(c.par.Motionhigh)
	mot = max(0.0, min(1.0, (m - lo) / max(1e-4, hi - lo)))
	raw = 0.0 if pres < 0.08 else 0.3 * pres + 0.7 * pres * mot
	k = float(c.par.Smooth)
	W['w'] = W['w'] * k + raw * (1 - k)
	hand = float(solid.sum()) / area
	label = 'CALM - no mist' if W['w'] < 0.25 else ('RAIN - mist, still' if W['w'] < 0.6 else 'STORM - mist moving')
	_set('mist_on', 'on' if c.par.Mist else 'off'); _set('mist_bright', round(frac, 3)); _set('mist_motion', round(m, 4)); _set('weather', round(W['w'], 2))
	if c.par.Debug:
		rgba = np.zeros((h, w, 4), np.float32)
		rgba[mist] = (0.15, 0.75, 1.0, 0.45)                       # cyan: mist
		rgba[moving & (d > lo)] = (0.2, 1.0, 0.35, 0.75)           # green: mist that is moving (counts)
		rgba[solid] = (1.0, 0.15, 0.1, 0.8)                        # red: hands / solid things (ignored)
		rgba[~roi] = (0.0, 0.0, 0.0, 0.65)                         # outside the view box: darkened
		yel = (1.0, 0.85, 0.1, 1.0)
		rgba[y0, x0:x1] = yel; rgba[y1 - 1, x0:x1] = yel; rgba[y0:y1, x0] = yel; rgba[y0:y1, x1 - 1] = yel
		c.store('mist_dbg_img', np.ascontiguousarray(np.flipud(rgba)))
		op('mist_dbg').cook(force=True)
		t = op('mist_dbg_text')
		if t is not None:
			t.par.text = ('%s\\nmist in box %4.1f%%   presence %.2f\\nmist motion %.3f   -> %.2f\\nhands/solid ignored %4.1f%%\\nweather %.2f   (cyan mist, green moving mist, red ignored)'
				% (label, frac * 100, pres, m, mot, hand * 100, W['w']))
	W['n'] += 1
	if W['n'] % 2: return                                        # ~5 messages a second
	try:
		op('mqtt').publish(BASE + 'weather', json.dumps({'w': round(W['w'], 3)}).encode())
	except Exception as e:
		if W['n'] % 50 == 0: print('weather publish:', e)
"""
_sp(wx, framestart=True, active=True)

# -- Calibrate = remember the empty room picture (per pixel); Debug opens the debug view
px = _mk(parameterexecuteDAT, 'mist_pars', 1000, 300)
px.text = """def onPulse(par):
	if par.name == 'Calibrate':
		W = op('mist_weather').module.W
		bg = W.get('avg')
		if bg is not None:
			parent().store('mist_bg', bg.copy())
			print('mist calibrated: empty-room picture stored (%dx%d). Now turn the mist on.' % (bg.shape[1], bg.shape[0]))
def onValueChange(par, prev):
	if par.name == 'Mist':                     # flips the mist switch on the wall
		try: op('mqtt').publish('rainconnect/rubywu-ux-k7q2/gallery/weather', ('{"set": %d}' % (1 if par.eval() else 0)).encode())
		except Exception as e: print('mist switch:', e)
	if par.name == 'Cam':
		cam = op('cam'); n = len(cam.par.device.menuNames)
		if n: cam.par.device.menuIndex = min(int(par), n - 1)
	if par.name == 'Debug':
		v = op('mist_debug_view')
		if par.eval(): v.openViewer()
		else:
			try: v.closeViewer()
			except Exception: pass
"""
_sp(px, op=CR.path, pars='Calibrate Cam Mist Debug', onpulse=True, valuechange=True, active=True)
me.time.play = True
import re
d = os.path.expanduser('~/Desktop/ConnectTheRain')
nums = [int(m.group(1)) for f in os.listdir(d) for m in [re.match(r'ConnectTheRain\.(\d+)\.toe$', f)] if m]
n = max(nums + [5]) + 1                                    # always one above the newest, so the biggest number is the latest
project.save(os.path.join(d, 'ConnectTheRain.%d.toe' % n))
print('MIST v2 READY: turn the generator OFF, press Calibrate, then switch on Debug and turn the mist on.')
