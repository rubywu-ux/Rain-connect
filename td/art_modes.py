# ---- Connect the Rain: the wall's three views from TouchDesigner (run after art_switch.py)
# In the projector window: A / Z = step through the rain map, 1 Murmuration and 2 Umbrellas;
# 0 / X / Esc = the rain map, 1-2 = an art mode, W = mist on/off.
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
	elif ch == 'z': js('window.__wall.cycleArt(-1)')
	elif ch in ('0', '1', '2'): js('window.__wall.setArt(%s)' % ch)
	elif ch == 'x' or str(key).lower() in ('esc', 'escape') or ch == '\x1b': js('window.__wall.setArt(0)')
	elif ch == 'w': c.par.Mist = not c.par.Mist
	else: return
	print('wall key', ch)
"""
P = CR.op('projector')
if P is not None and hasattr(P.par, 'closeescape'): P.par.closeescape = False   # Esc turns art off; it must not close the wall
# The wall window shows a plain panel, not the TOP itself: a TOP in a window is shown in a viewer, and a
# viewer's own A key shows the alpha channel (a white screen) every time A is pressed to switch art modes.
WP = CR.op('wall_panel') or CR.create(containerCOMP, 'wall_panel')
WP.par.w = 1280; WP.par.h = 720; WP.par.hmode = 'fixed'; WP.par.vmode = 'fixed'
WP.par.top = CR.op('out').path; WP.par.topfill = 'fill'
if P is not None: P.par.winop = WP.path
# open the wall window by itself when the project starts
EX = CR.op('wall_autostart') or CR.create(executeDAT, 'wall_autostart')
EX.text = "def onStart():\n\top('/project1/connect_rain/projector').par.winopen.pulse()\n\treturn\n"
EX.par.start = True; EX.par.active = True
print('A / Z = next / previous view (map, birds, umbrellas), 0 = map, 1-2 = art, X = map, W = mist (in the projector window)')
