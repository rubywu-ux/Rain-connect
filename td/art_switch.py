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
