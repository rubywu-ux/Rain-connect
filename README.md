# Connect the Rain

A rain installation for phones. Open the wall page on the projector laptop. Visitors open
the phone page by tapping an NFC sticker or scanning the QR code. Their phone shows how
much of Earth is under rain right now (live data from Open-Meteo), then catches the rain.
Put phones side by side and swipe one finger across both screens: they join into one
continuous canvas. The rain falls with simple physics: each drop starts from rest, speeds up
to its terminal velocity, streaks as a fine line of dots, slants with the wind and splashes
where it lands. Once phones are joined most drops fall into one horizontal river that flows
across all the screens. Each join draws a glowing orbit thread and plays a chime.

How to play (everything shows on every joined screen and is echoed on the wall):
- **Tap**: a fountain of fine threads leaps up from your finger, opens like a flower and rains back down (plus a note).
- **Hold a finger still**: it becomes an umbrella in your colour. Rain drums on it (you hear the pitter-patter),
  there's a dry patch underneath, and water drips off its edges, speeding up as it falls. Move it around.
- **Drag**: sweep and swirl the rain (and play notes).
- **Flick**: throw the rain: a spray of drops arcs away under gravity and splashes down.
- **Blow** into the mic (≋ button): a gust; 2+ people blowing = a storm with lightning.

- Each phone gets its own colour (status-pill dot, its blooms, swirl trails and
  join thread) and its own instrument: bell, marimba, glass, kalimba, felt piano, music
  box, soft flute, vibraphone. All phones share one clock, so every note is a tone of the
  same slowly changing chord (Dmaj9 → Bm9 → Gmaj9 → A6sus, 8 s each) and lands on a shared
  84 bpm pulse. A quiet pad holds the chord, and each phone plays softer in bigger groups,
  so everyone's touches blend into one piece of music. A tap also echoes, smaller and in
  the tapper's colour, on every other connected screen.
- Breath storm: tap ≋ on the phone to let it hear your breath (microphone, opt-in). Blowing
  sends a gust through your own rain. When 2+ people blow at the same time (any phones)
  a storm starts on every phone and on the wall: a quiet storm wind, rain slanting,
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
