# Connect the Rain

A rain installation for phones. Open the wall page on the projector laptop. Visitors open
the phone page by tapping an NFC sticker or scanning the QR code. Their phone shows how
much of Earth is under rain right now (live data from Open-Meteo), then catches the rain.
Put phones side by side and swipe one finger across both screens: they join into one
continuous canvas. Organic black-and-white ink strands fall like rain; once phones are joined
the strands converge into one horizontal river that flows across all the screens. Each join
draws a glowing orbit thread and plays a chime; taps bloom like ink in water and drags swirl
the strands, on every connected screen, echoed on the wall.

- Each phone gets its own colour (status-pill dot, its blooms, swirl trails and
  join thread) and its own instrument: bell, marimba, glass, kalimba, felt piano, music
  box, soft flute, vibraphone. All phones share one clock, so every note is a tone of the
  same slowly changing chord (Dmaj9 → Bm9 → Gmaj9 → A6sus, 8 s each) and lands on a shared
  84 bpm pulse. A quiet pad holds the chord, and each phone plays softer in bigger groups,
  so everyone's touches blend into one piece of music. A tap also echoes, smaller and in
  the tapper's colour, on every other connected screen.
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
