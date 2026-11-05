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
| moving frantically | gusts of wind, dark, the rain leans; louder the harder the mist moves |

Setup, once (TouchDesigner, with ConnectTheRain open): paste this into the Textport
(Dialogs > Textport and DATs) and press Return:

    import urllib.request as u; exec(u.urlopen('https://rubywu-ux.github.io/Rain-connect/td/add_mist.py').read().decode('utf-8'))

It adds `cam -> cam_small -> cam_diff -> bright_chop / motion_chop -> mist_weather` inside
`/project1/connect_rain`, a **Mist** page of settings on the container (Mist on/off, Camera,
thresholds, Calibrate), and saves `ConnectTheRain.6.toe`.

Using it: point the webcam at the mist against a dark background (a black cloth), with a lamp
lighting the mist from the side. On the Mist page: pick the **Camera**, press **Calibrate** with
the mist off (the room's baseline), then start the generator. `cam_diff` shows what it sees as
motion. If "calm" never comes, raise **Presence**; if "storm" comes too easily, raise
**Motion: frantic**. The wall shows `mist · calm / rain / storm` bottom-left; **Mist** on the
container (or the W key / that button on the wall page) switches the whole feature off.

