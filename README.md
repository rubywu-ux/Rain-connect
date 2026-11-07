# Connect the Rain

A rain installation for phones. Open the wall page on the projector laptop. Visitors open
the phone page by tapping an NFC sticker or scanning the QR code. Their phone shows how
much of Earth is under rain right now (live data from Open-Meteo), then catches the rain.
Put phones side by side and swipe one finger across both screens: they join into one
continuous canvas. Black-and-white plumes of fine, flowing dotted filaments bloom, breathe and slowly dissolve, their sparkling rims falling as rain; once phones are joined
the rain converges into one horizontal river that flows across all the screens. Each join
draws a glowing orbit thread and plays a chime; taps bloom like ink in water and drags swirl
the strands, on every connected screen, echoed on the wall.

- Each phone gets its own colour (status-pill dot, its blooms, swirl trails and
  join thread) and its own instrument: bell, marimba, glass, kalimba, felt piano, music
  box, soft flute, vibraphone. All phones share one clock, so every note is a tone of the
  same slowly changing chord (Dmaj9 → Bm9 → Gmaj9 → A6sus, 8 s each) and lands on a shared
  84 bpm pulse. A quiet pad holds the chord, and each phone plays softer in bigger groups,
  so everyone's touches blend into one piece of music. A tap also echoes, smaller and in
  the tapper's colour, on every other connected screen.
- Breath storm: tap ≋ on the phone to let it hear your breath (microphone, opt-in). Blowing
  sends a gust through your own strands. When 2+ people blow at the same time (any phones)
  a storm starts on every phone and on the wall: a quiet storm wind, strands leaning,
  white lightning in sync on all screens, and thunder. More people blowing = louder and more
  lightning. Breath is told apart from voices/music by its noisy, low-heavy spectrum.
- Looks: white light on black (default), or black ink on white paper: add `?ink` to the wall
  URL (its QR code then sends phones to the ink version too).

- Phone page: `index.html`
- Wall page (exactly one, it is also the hub): `wall.html`. Click once to start the sound,
  then press **F** for full screen. Press **M** to show or hide the world map.
- Sync: a public MQTT relay (`broker.emqx.io`). Nothing personal is sent, only swipe and
  tap positions.
- Data: 320 evenly spaced points on Earth, checked through Open-Meteo every 30 minutes by
  the wall and shared with the phones. Raining = a WMO rain, drizzle, shower or
  thunderstorm code, or ≥0.1 mm of non-snow precipitation.
- Separate rooms for testing: add `?room=test` to both URLs.

## TouchDesigner
Load `wall.html?td` in a Web Render TOP. It runs the hub with no click-to-start, and
TouchDesigner makes the sound. Every phone event is also published as JSON on the MQTT
topic `rainconnect/rubywu-ux-k7q2/gallery/td`, as `{type: tap|wind|join, u, v, ...}` with
u and v from 0 to 1 on the wall. The live data is on `.../rainnow` and `.../stats`, both
retained. Listen with an MQTT Client DAT at `tcp://broker.emqx.io:1883`.
Run only ONE wall: either the browser one or the one in TouchDesigner, never both.

## Mist weather (webcam -> TouchDesigner -> the wall)

A mist generator stands in front of a webcam. Visitors blow at the mist or wave through it;
TouchDesigner watches it and the wall's weather follows. This is wall-only: the phones never
receive the weather, so their rain, music and breath storm are untouched.

| mist | wall |
|---|---|
| none (generator off / mist cleared) | rain stops, the room brightens to light mode, leaves rustle, small birds |
| present but still | the usual rain, dark |
| moving frantically | gusts of wind, dark, the rain leans, lightning across the wall with deep rolling thunder; more and louder the harder the mist moves |

Setup, once (TouchDesigner, with ConnectTheRain open): paste this into the Textport
(Dialogs > Textport and DATs) and press Return (TouchDesigner's Python uses the Mac's own
certificate list for the download):

    import urllib.request as U, ssl; exec(U.urlopen('https://rubywu-ux.github.io/Rain-connect/td/add_mist.py', context=ssl.create_default_context(cafile='/etc/ssl/cert.pem')).read().decode('utf-8'), dict(globals()))

It adds `cam -> cam_small -> cam_diff -> bright_chop / motion_chop -> mist_weather` inside
`/project1/connect_rain`, a **Mist** page of settings on the container (Mist on/off, Camera,
thresholds, Calibrate), and saves it as the next free `ConnectTheRain.N.toe` (older versions are kept).

Then load the current detector (v5) the same way, with `td/mist_v5.py` in the URL. It finds the pot
by itself (the bright opening inside the dark pot, from above or from the side; in a dark room it
keeps the pot it found with the lights on, or finds it by its glow), and was tuned on recorded clips
(still mist, blowing, a hand waving, no mist; bright and dark rooms; two camera angles):

- the mist maker's colour-changing light is ignored (each frame is matched to the last one for
  brightness first, and one-frame jumps when the light switches colour are dropped);
- while a hand or arm is in view the mist movement is not counted; mist it stirred still counts
  once the hand is gone;
- any steady mist = rain; the mist moving clearly more than its own quiet level = storm.

Using it: on the Mist page press **Calibrate** once with the mist maker OFF and the pot clear, in
the light the show will have (it learns the empty pot; kept across restarts; press again if the
camera moves). Without it "no mist" is still recognised in a dark room, and in a lit room from
above, but from the side in a lit room an empty pot can read as rain. **Debug** opens the camera
view: yellow = the pot opening, cyan = mist, green = moving mist, red = a hand (ignored). The wall
shows `mist · calm / rain / storm` bottom-left; **Mist** on the container (or the W key / that
button on the wall page) switches the whole feature off. **Test storm** gives 5 s of lightning and
thunder. `td/record_clips.py` records labelled 10 s clips with voice prompts, for tuning.

## The data as art (what the wall shows)

- **Every plume is a real place.** Each of the 320 evenly spread points where it is raining right now
  becomes a plume on the wall, placed like a map (east-west across, north-south down) and sized and
  lit by how hard it is raining there (WMO weather code + mm). A faint stippled world sits underneath.
- **The rain remembers.** When a plume finishes, it leaves a stain (a dried-drop ring) where its rain
  fell. Places where it keeps raining darken over the day; stains fade over about 24 hours and are kept
  across reloads (browser storage on the wall).
- **A drop with a name.** A tap on a phone picks the raining place nearest that spot of the (joined)
  screens and says where it is: "light rain near Hanoi, Vietnam · your drop is falling there now". The
  wall lights up that place's plume and names it. The wall also names a random place now and then.
  Names come from ~250 cities (`js/places.js`) or the sea/region the point lies over.

## Art mode (wall)

Five art modes, no map, numbers or names. They all use the same live rain data and the mist from
TouchDesigner (how much it moves, and where in the pot). The **art** button (bottom-left of the wall)
and the **A** key cycle through all modes and off, **Z** goes back one; keys **1-5** pick a mode, and
**X** or **Esc** turns art off.
In TouchDesigner use the projector window (same keys), or Mist page > Art mode (on = last mode used).

1. **Murmuration** - a flock of starlings over a gold-leaf folding screen; each raining place leads a
   patch of the flock (bigger = stronger) in a formation that folds and pulses. Breath is a hawk: the
   birds burst away from where it comes in and the flock flees the other way; storms bring falcons that
   tear it apart; lightning startles every bird at once. Calm, the flock draws together and drifts.
2. **Umbrellas** - a plaza in the rain seen from a high window: one person under an umbrella per
   raining place (where they walk = longitude and latitude, size = strength, colour = latitude,
   pattern = rain type: drizzle plain, rain two-tone, showers rainbow, thunderstorms black). Breath
   leans the umbrellas away from you and blows the weak ones inside out; storms tear some away;
   lightning throws hard shadows and everyone jumps. Calm, umbrellas close, the sun and long shadows
   come out and a rainbow shows in a puddle. A tap twirls the umbrella of that place.
3. **Marbling** - Turkish paper marbling (ebru) seen from above: every raining place drops ink at its
   own spot again and again (bigger and more often = stronger), and each new drop pushes all the ink
   before it into rings and veins (the real mathematics of marbling: the ink keeps its area and never
   blurs). Colour = rain type, then latitude: drizzle aqua and celadon in sprinkles; rain teal, cobalt
   or violet from the tropics to the poles; showers saffron, coral and rose in bursts of rings;
   thunderstorms crimson and ink black. Now and then clear water rings a drop in ivory. Breath is the
   marbler's comb: one stroke of tines through the bath in the direction you blow, around where the mist
   moved, pulling the rings into feathers (a long breath draws the next stroke between the lines of the
   last); storms stir the bath into whirlpools; lightning leaves a jagged chain of white drops. Calm, the
   drops come slowly and the bath rests like a finished print. A tap drops gold (on a raining place, a
   bull's-eye of rings).
4. **Cymatics** - a Chladni plate in a dark studio, out in the rain under a spotlight: a black plate
   dusted with white sand that the rain plays. The raining places take turns (east to west): a drop from
   that place strikes the plate and it rings with that place's note, so the sand dances off the parts
   that shake and gathers on the still lines, drawing its figure (drizzle fine lace, rain rings and
   spokes, showers a rosette, thunderstorms a dense star; heavier rain = a deeper, bolder figure that
   rings longer); the light under the plate takes the colour of the rain type. More raining places =
   more drops and more sand. Breath blows the sand across and off the plate, away from you (fresh sand
   is sifted back on after); storms ring note over note and the sand leaps; lightning makes every grain
   jump. Calm, one pure figure holds and the studio turns to daylight on a brass plate. A tap strikes
   the plate where it lands (on a raining place, its note).
5. **Sea Glow** - a beach at night where the sea glows blue wherever it is disturbed: waves roll in out
   of the dark and their crests flare as they break, and the foam runs up the sand glittering and fades.
   Every raining place is a shower out at sea (across = longitude, further out = further north): a grey
   curtain of rain whose drops spark where they hit (wider and brighter = stronger; drizzle glitters,
   showers come in bursts, thunderstorms flash). Breath is a gust: a glowing wake races away from the
   side you blow from and spray is torn off the crests; storms bring big surf breaking in sheets of
   light and lightning over the sea. Calm, the clouds open on the Milky Way and only the water's edge
   glows. A tap is a stone thrown in (a ring of light) or a glowing footprint on the sand; on a raining
   place, a downpour there.

Lightning and thunder still follow the mist storm in every mode (each draws it in its own way).
Phone taps bloom, and in modes 2-5 they also act on the picture.

