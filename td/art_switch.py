# ---- Connect the Rain: an "Art mode" switch in TouchDesigner (keys like A don't reach the web page inside TD)
CR = op('/project1/connect_rain')
page = next((p for p in CR.customPages if p.name == 'Mist'), None) or CR.appendCustomPage('Mist')
if getattr(CR.par, 'Art', None) is None: page.appendToggle('Art', label='Art mode on the wall (no map, no numbers)')
px = CR.op('mist_pars')
if "par.name == 'Art'" not in px.text:
	px.text = px.text.replace("def onValueChange(par, prev):", """def onValueChange(par, prev):
	if par.name == 'Art':                      # flips the wall between the map view and art mode
		try: op('wall_web').executeJavaScript('window.__wall && window.__wall.setArt(%s)' % ('true' if par.eval() else 'false'))
		except Exception as e: print('art switch:', e)""", 1)
pars = px.par.pars.eval().split()
if 'Art' not in pars: px.par.pars = ' '.join(pars + ['Art'])
print('Art switch ready on the Mist page of connect_rain')

# A / W keys inside TouchDesigner (use the projector window: a node viewer uses A for "show alpha")
K = CR.op('wall_keys') or CR.create(keyboardinDAT, 'wall_keys')
KC = CR.op('wall_keys_cb') or CR.create(textDAT, 'wall_keys_cb')
KC.text = """def onKey(dat, key, character, *a, **k):
	st = a[9] if len(a) > 9 else k.get('state', 1)
	if not st: return
	ch = (str(character) or str(key)).lower()
	c = op('/project1/connect_rain')
	if ch == 'a': c.par.Art = not c.par.Art
	if ch == 'w': c.par.Mist = not c.par.Mist
	if ch in ('a', 'w'): print('wall key', ch, 'art', c.par.Art.eval(), 'mist', c.par.Mist.eval())
"""
K.par.callbacks = KC.path; K.par.active = True
P = CR.op('projector')
if 'custom' in P.par.size.menuNames: P.par.size = 'custom'
P.par.winw = 1280; P.par.winh = 720; P.par.borders = True
print('A = art mode, W = mist on/off (in the projector window)')
