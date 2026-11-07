# ---- Connect the Rain: fifteen art modes from TouchDesigner (run after art_switch.py)
# In the projector window: A = next art mode, Z = previous, 1-9 = pick a mode, 0 = mode 10, Shift+1-5 = modes 11-15,
# X / Esc = art off, W = mist on/off.
# WALL_V (set before exec) = the version tag for the wall page URL.
CR = op('/project1/connect_rain')
W = CR.op('wall_web')
V = globals().get('WALL_V')
if V:
	W.par.url = 'https://rubywu-ux.github.io/Rain-connect/wall.html?td&v=' + V
	print('wall url ->', W.par.url.eval())
KC = CR.op('wall_keys_cb')
KC.text = """def js(code):
	try: op('/project1/connect_rain/wall_web').executeJavaScript('window.__wall && ' + code)
	except Exception as e: print('wall key:', e)

def onKey(dat, key, character, *a, **k):
	st = a[9] if len(a) > 9 else k.get('state', 1)
	if not st: return
	ch = (str(character) or str(key)).lower()
	c = op('/project1/connect_rain')
	shift = bool(a[6]) if len(a) > 6 else bool(k.get('shift', 0))
	kd = str(key)[-1:] if str(key)[-1:].isdigit() else ''
	if ch in '!@#$%' and len(ch) == 1: js('window.__wall.setArt(%d)' % (11 + '!@#$%'.index(ch)))          # Shift+1..5 -> 11..15
	elif shift and kd in ('1', '2', '3', '4', '5'): js('window.__wall.setArt(%d)' % (10 + int(kd)))
	elif ch == 'a': js('window.__wall.cycleArt()')
	elif ch == 'z': js('window.__wall.cycleArt(-1)')
	elif len(ch) == 1 and ch.isdigit(): js('window.__wall.setArt(%d)' % (int(ch) or 10))
	elif ch == 'x' or str(key).lower() in ('esc', 'escape') or ch == '\x1b': js('window.__wall.setArt(0)')
	elif ch == 'w': c.par.Mist = not c.par.Mist
	else: return
	print('wall key', ch)
"""
print('A = next art mode, Z = previous, 1-9 = pick, 0 = mode 10, Shift+1-5 = 11-15, X = art off, W = mist (in the projector window)')
