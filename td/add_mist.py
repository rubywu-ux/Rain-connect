# ---- Connect the Rain: mist weather. Adds a webcam -> mist detector -> weather sender to the
#      open Connect the Rain project (/project1/connect_rain), then saves it as a new version.
#      Run inside TouchDesigner's Textport (see README). Safe to run again: it updates in place.
import os, json
CR = op('/project1/connect_rain')
assert CR is not None, 'open ConnectTheRain.toe first'
def _sp(o, **kw):
	for k, v in kw.items():
		p = getattr(o.par, k, None)
		if p is None:
			print('  (skip)', o.name, k); continue
		try: p.val = v
		except Exception as e: print('  (skip)', o.name, k, e)
def _mk(t, name, x, y):
	o = CR.op(name) or CR.create(t, name)
	o.nodeX, o.nodeY = x, y
	return o

# -- settings on the container (right-click connect_rain > Parameters > Mist page)
page = next((p for p in CR.customPages if p.name == 'Mist'), None) or CR.appendCustomPage('Mist')
def _par(kind, name, label, default, lo=None, hi=None):
	p = getattr(CR.par, name, None)
	if p is None:
		p = getattr(page, 'append' + kind)(name, label=label)[0]
	if kind in ('Float', 'Int'):
		p.default = default
		if lo is not None: p.normMin, p.min = lo, lo
		if hi is not None: p.normMax, p.max = hi, hi
	elif kind == 'Toggle':
		p.default = default
	return p
_par('Toggle', 'Mist', 'Mist detection (on/off)', True)
_par('Int', 'Cam', 'Camera (0 = built-in, 1 = next)', 0, 0, 8)
_par('Float', 'Presence', 'Mist presence threshold', 0.05, 0, 0.5)
_par('Float', 'Motionlow', 'Motion: still mist', 0.006, 0, 0.2)
_par('Float', 'Motionhigh', 'Motion: frantic', 0.05, 0, 0.5)
_par('Float', 'Smooth', 'Response (0 fast .. 1 slow)', 0.75, 0, 0.98)
if getattr(CR.par, 'Calibrate', None) is None: page.appendPulse('Calibrate', label='Calibrate (room without mist)')
if CR.par.Mist.val is None: CR.par.Mist = True
try: CR.par.Mist = True
except Exception: pass

# -- webcam -> small grey image -> (a) brightness = is there mist?  (b) frame difference = is it moving?
cam = _mk(videodeviceinTOP, 'cam', -800, 500)
names = list(cam.par.device.menuNames)
print('cameras:', names)
try: cam.par.device.menuIndex = min(int(CR.par.Cam), max(0, len(names) - 1))
except Exception as e: print('camera pick:', e)
_sp(cam, active=True)
mono = _mk(monochromeTOP, 'cam_mono', -600, 500); mono.setInputs([cam])
small = _mk(resolutionTOP, 'cam_small', -400, 500); small.setInputs([mono])
_sp(small, outputresolution='custom', resolutionw=64, resolutionh=36)
blur = _mk(blurTOP, 'cam_blur', -200, 500); blur.setInputs([small]); _sp(blur, size=3)
bright = _mk(analyzeTOP, 'bright_an', 0, 600); bright.setInputs([blur]); _sp(bright, function='average')
cache = _mk(cacheTOP, 'cam_cache', 0, 400); cache.setInputs([blur]); _sp(cache, cachesize=4)
prev = _mk(cacheselectTOP, 'cam_prev', 200, 400); prev.setInputs([cache]); _sp(prev, index=3)
diff = _mk(compositeTOP, 'cam_diff', 400, 450); diff.setInputs([blur, prev]); _sp(diff, operand='difference')
motion = _mk(analyzeTOP, 'motion_an', 600, 450); motion.setInputs([diff]); _sp(motion, function='average')
bch = _mk(toptoCHOP, 'bright_chop', 800, 600); _sp(bch, top=bright.path)
mch = _mk(toptoCHOP, 'motion_chop', 800, 450); _sp(mch, top=motion.path)
diff.viewer = True; cam.viewer = True

# -- weather: computed ~10x a second, sent to the wall page over MQTT (the phones never hear it)
state = CR.op('state')
if state is not None:
	for k in ('mist_on', 'mist_bright', 'mist_motion', 'weather'):
		if state.row(k) is None: state.appendRow([k, ''])
wx = _mk(executeDAT, 'mist_weather', 1000, 500)
wx.text = """import json
BASE = 'rainconnect/rubywu-ux-k7q2/gallery/'
W = {'w': 0.0, 'n': 0}
def _ch(name):
	try: return float(op(name)['r'].eval())
	except Exception: return 0.0
def _set(k, v):
	t = op('state')
	if t is not None and t.row(k) is not None: t[k, 1] = v
def onFrameStart(frame):
	if frame % 6: return
	c = parent()
	on = bool(c.par.Mist)
	b = _ch('bright_chop'); m = _ch('motion_chop')
	base = float(c.fetch('mist_base', 0.0)); mbase = float(c.fetch('mist_mbase', 0.0))
	pres = max(0.0, min(1.0, (b - base - float(c.par.Presence)) / 0.12))        # 0 none .. 1 lots of mist
	lo, hi = float(c.par.Motionlow), float(c.par.Motionhigh)
	mot = max(0.0, min(1.0, (m - mbase - lo) / max(1e-4, hi - lo)))             # 0 still .. 1 frantic
	raw = 0.0 if pres < 0.08 else 0.3 * pres + 0.7 * pres * mot
	k = float(c.par.Smooth)
	W['w'] = W['w'] * k + raw * (1 - k)
	_set('mist_on', 'on' if on else 'off'); _set('mist_bright', round(b - base, 3)); _set('mist_motion', round(m - mbase, 4)); _set('weather', round(W['w'], 2))
	W['n'] += 1
	if W['n'] % 2: return                                                        # ~5 messages a second
	try:
		op('mqtt').publish(BASE + 'weather', json.dumps({'on': 1 if on else 0, 'w': round(W['w'], 3)}).encode(), 0, True)
	except Exception as e:
		if W['n'] % 50 == 0: print('weather publish:', e)
"""
_sp(wx, framestart=True, active=True)

# -- Calibrate button + camera switch
px = _mk(parameterexecuteDAT, 'mist_pars', 1000, 300)
px.text = """def onPulse(par):
	if par.name == 'Calibrate':
		c = parent()
		try:
			b = float(op('bright_chop')['r'].eval()); m = float(op('motion_chop')['r'].eval())
		except Exception:
			b, m = 0.0, 0.0
		c.store('mist_base', b); c.store('mist_mbase', m)
		print('mist calibrated: brightness', round(b, 3), 'motion', round(m, 4), '(room with NO mist)')
def onValueChange(par, prev):
	if par.name == 'Cam':
		cam = op('cam'); n = len(cam.par.device.menuNames)
		if n: cam.par.device.menuIndex = min(int(par), n - 1)
"""
_sp(px, op=CR.path, pars='Calibrate Cam', pulse=True, valuechange=True, active=True)
if CR.fetch('mist_base', None) is None:
	CR.store('mist_base', 0.0); CR.store('mist_mbase', 0.0)

# -- the wall page gets the latest build
w = CR.op('wall_web')
if w is not None:
	w.par.url = 'https://rubywu-ux.github.io/Rain-connect/wall.html?td&v=VERSION'
	w.par.active = True
try:
	target = os.path.expanduser('~/Desktop/ConnectTheRain/ConnectTheRain.6.toe')
	project.save(target)
	print('saved', target)
except Exception as e:
	print('save:', e)
print('MIST READY. Set the camera (Cam), press Calibrate with no mist, then turn the mist on.')
