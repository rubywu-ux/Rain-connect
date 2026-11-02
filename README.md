# Connect the Rain

A rain installation for phones. Open the wall page on the projector laptop. Visitors open
the phone page by tapping an NFC sticker or scanning the QR code. Their phone shows how
much of Earth is under rain right now (live data from Open-Meteo), then catches the rain.
Put phones side by side and swipe one finger across both screens: they join into one
continuous canvas. Organic black-and-white ink strands fall like rain; once phones are joined
the strands converge into one horizontal river that flows across all the screens. Each join
draws a glowing orbit thread and plays a chime; taps bloom like ink in water and drags swirl
the strands, on every connected screen, echoed on the wall.

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
