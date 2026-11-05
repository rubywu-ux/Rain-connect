# ---- Connect the Rain: five art modes from TouchDesigner (run after art_switch.py)
# In the projector window: A = next art mode (off > 1..5 > off), 1-5 = pick a mode, 0 = art off, W = mist on/off.
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
	if ch == 'a': js('window.__wall.cycleArt()')
	elif ch in '012345' and len(ch) == 1: js('window.__wall.setArt(%s)' % ch)
	elif ch == 'w': c.par.Mist = not c.par.Mist
	else: return
	print('wall key', ch)
"""
print('A = next art mode, 1-5 = pick, 0 = off, W = mist (in the projector window)')
