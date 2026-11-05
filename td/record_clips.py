# Connect the Rain - record labelled webcam clips for tuning the mist detector.
# Run in the Textport (downloads this file, puts it in a Text DAT 'rec_seq', starts it):
#   import urllib.request as U, ssl; S=U.urlopen('<url of this file>', context=ssl.create_default_context(cafile='/etc/ssl/cert.pem')).read().decode('utf-8'); exec(S, dict(globals()))
# A voice (macOS 'say') tells you what to do before each 10 s clip.
# Clips go to ~/Desktop/ConnectTheRain/mist_clips/<set>_<still|blow|hand>.mov
# Later, from the Textport:
#   op('/project1/connect_rain/rec_seq').module.start(['low'])      # only the low-light set
#   op('/project1/connect_rain/rec_seq').module.one('set1_blow')    # redo one clip
#   op('/project1/connect_rain/rec_seq').module.cancel()            # stop everything

MODULE = r'''
import os, subprocess, time
CR = op('/project1/connect_rain')
D = os.path.expanduser('~/Desktop/ConnectTheRain/mist_clips')
SECS = 10
M = "op('/project1/connect_rain/rec_seq').module."
WORDS = {
    'still': 'Next: leave the mist still. Hands away from the pot.',
    'blow':  'Next: blow into the mist. Soft and hard puffs.',
    'hand':  'Next: wave your hand over the pot.',
}
NAMES = {'set1': 'Set one', 'set2': 'Set two', 'low': 'Low light set'}

def say(t):
    try:
        subprocess.Popen(['say', '-r', '190', t])
    except Exception as e:
        print('say failed', e)

def at(ms, call):
    run(M + call, delayMilliSeconds=int(ms), group='recseq')

def log(line):
    print('[rec]', line)
    try:
        with open(D + '/log.txt', 'a') as f:
            f.write(time.strftime('%H:%M:%S ') + line + '\n')
    except Exception:
        pass

def weather():
    # live detector reading, so each clip is logged with what TD saw
    try:
        W = CR.op('mist_weather').module.W
        return 'weather=%.2f mist=%.2f' % (W.get('w', 0), W.get('pm', 0))
    except Exception:
        return ''

def prep(name):
    mo = CR.op('rec')
    mo.par.record = False
    mo.par.type = 'movie'
    mo.par.videocodec = 'mjpa'
    mo.par.file = D + '/' + name + '.mov'
    say(WORDS[name.split('_')[1]])

def rec_on(name):
    say('Go.')
    CR.op('rec').par.record = True
    log('REC  ' + name)

def half(name):
    log('mid  ' + name + ' ' + weather())

def rec_off(name):
    CR.op('rec').par.record = False
    say('Stop.')
    log('DONE ' + name + ' ' + weather())

def saved(name):
    p = D + '/' + name + '.mov'
    log('FILE %s %s' % (name, ('%.1f MB' % (os.path.getsize(p) / 1e6)) if os.path.exists(p) else 'MISSING'))

def plan(sets, t=0):
    for s in sets:
        if s == 'low':
            at(t, "say('Low light set next. Please dim the lights now. Starting in 20 seconds.')")
            at(t + 12000, "say('8 seconds.')")
            t += 20000
        at(t, 'say(%r)' % (NAMES.get(s, s) + '.'))
        t += 1500
        for k in ('still', 'blow', 'hand'):
            name = '%s_%s' % (s, k)
            t = clip(name, t)
        at(t, 'say(%r)' % (NAMES.get(s, s) + ' done.'))
        t += 3000
    return t

def clip(name, t=0):
    at(t, 'prep(%r)' % name)
    t += 5000
    at(t, 'rec_on(%r)' % name)
    at(t + SECS * 500, 'half(%r)' % name)
    t += SECS * 1000
    at(t, 'rec_off(%r)' % name)
    at(t + 1000, 'saved(%r)' % name)
    return t + 2000

def start(sets=('set1', 'set2', 'low')):
    cancel()
    os.makedirs(D, exist_ok=True)
    say('Recording mist clips. ' + NAMES.get(sets[0], sets[0]) + ' starts in a few seconds.')
    t = plan(list(sets), 4000)
    at(t, "say('All done. Thank you.')")
    at(t, "log('ALL DONE')")
    log('START %s, about %d s' % (','.join(sets), t / 1000))

def one(name):
    cancel()
    os.makedirs(D, exist_ok=True)
    t = clip(name, 500)
    at(t, "say('Done.')")

def cancel():
    for r in list(runs):
        try:
            if r.group == 'recseq':
                r.kill()
        except Exception:
            pass
    try:
        CR.op('rec').par.record = False
    except Exception:
        pass
'''

CR = op('/project1/connect_rain')
rs = CR.op('rec_small') or CR.create(resolutionTOP, 'rec_small')
rs.setInputs([CR.op('cam')])
rs.par.outputresolution = 'custom'
rs.par.resolutionw = 640
rs.par.resolutionh = 360
mo = CR.op('rec') or CR.create(moviefileoutTOP, 'rec')
mo.setInputs([rs])
mo.par.record = False
mo.par.type = 'movie'
mo.par.videocodec = 'mjpa'
rq = CR.op('rec_seq') or CR.create(textDAT, 'rec_seq')
rq.text = MODULE
for i, o in enumerate((rs, mo, rq)):
    o.nodeX = -2000 + 200 * i
    o.nodeY = -800
print('recorder ready ->', rq.module.D)
if globals().get('AUTOSTART', True):
    rq.module.start()
