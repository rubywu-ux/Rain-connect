# Connect the Rain

A rain installation for phones. Open the wall page on the projector laptop. Visitors open
the phone page by tapping an NFC sticker or scanning the QR code. Their phone shows how
much of Earth is under rain right now (live data from Open-Meteo), then catches the rain.
Soft plumes of fine, flowing filaments bloom, breathe and slowly dissolve, their rims falling as
rain; taps bloom like ink in water, drags swirl the strands and a tilt of the phone leans the
whole picture, echoed on the wall.

- Each phone gets its own colour (status-pill dot, its blooms and swirl trails) and its own instrument: bell, marimba, glass, kalimba, felt piano, music
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

## Art mode (wall): Umbrellas

One art mode beside the rain map, drawn in the map's own language (soft points and fine strands).
**Z** switches between the rain map and Umbrellas; **1** picks Umbrellas, **0**, **X** or **Esc**
the map. **S** switches the theme: *fog* (grey ink on a pale ground, the default) or *night* (light on
black); the choice is kept on that screen, and a phone that scans the QR opens in the wall's theme, with
its own fog/night switch (top-right of the start screen, ◐ in the rain view). The buttons bottom-left of
the wall do the same. In TouchDesigner use the projector window (same keys), or Mist page > Art mode.

A plaza in the rain seen from a high window: the 28 heaviest raining places on Earth are people crossing
it under umbrellas (where they walk = longitude and latitude, size and brightness = how hard it rains
there, the arcs inside = the kind of rain: drizzle none, rain a few, showers more, thunderstorm all).
It never stops raining: a settled mist is a gentle rain; a disturbed mist is a storm that leans the
umbrellas, blows the weak ones inside out and tears some away. One line of words stays on the wall
(the share of Earth under rain right now), and a quiet caption names a place when its umbrella is
lost or when someone finds shelter.

The phones (js/lab.js) join the plaza while the wall shows Umbrellas, with the only colour on the wall:
- **drag** carries your umbrella (it stays where you leave it; up to twelve phones walk at once);
- **hold still** makes it rain hard on that spot;
- **flick** sends a gust across the plaza that way.
Someone whose umbrella the wind takes runs in under the nearest phone's umbrella (up to four each),
which opens wider for them; the wall plays a soft note in that phone's colour and names their place.
A plain tap still rings your note, and edge swipes still join phones.

