# Desk test: a T-Echo and two phones

Before a real race, about an hour at home. What it proves: the server, the Android app with the
screen off, a Meshtastic radio over Bluetooth, and what happens when signal drops. Write down
anything that surprises you, with the time.

## You need

- The server deployed (docs/DEPLOY_CPANEL.md) and its address, e.g. `race.yourdomain`.
- **Phone A** (race office): Chrome, or the app.
- **Phone B** (skipper): the Android app from the Test build release.
- A T-Echo (or any Meshtastic radio) with GPS, charged, outdoors or by a window.
- A laptop is handy for the spectator view.

## 1. Set up (10 min)

1. On the laptop, open `https://race.yourdomain`, **Run a new regatta** (admin token), note the code
   and PINs, **Open as the race office**.
2. Setup: add a class (1-minute sequence) with three boats: `TEST 1`, `TEST 2`, `TEST 3`.
3. Setup → Course: walk out to three points a few hundred metres apart (or tap the map) for the start
   pin, committee boat and first mark. **Save course**.
4. Setup → Trackers: tick **Skippers can connect their own phone or tracker**.
5. Optional warm-up: Setup → **Add 5 practice boats**, start the Practice class, watch a whole race.
   **Remove practice boats** afterwards.

## 2. Skipper phone in a pocket (30 min)

1. Phone B: install the app, open it, enter the server and the event code with the **skipper PIN**.
2. Track → Your boat `TEST 1` → **Connect this phone** → **Start sharing my position**. Allow
   location **all the time** and notifications when asked.
3. Check the notification "Sharing your boat's position" shows.
4. Lock Phone B and put it in a pocket. Walk for 30 minutes.
5. On the laptop (Map tab and spectator view) check `TEST 1` keeps moving, with "s ago" staying small.

Note: did it ever stop? For how long? Which phone make and Android version? Battery used?

## 3. Radio over Bluetooth (15 min)

1. Phone A (race office), Map tab → Meshtastic radio → **Connect a radio** → pick the T-Echo.
   Check it says **Relaying**, the radio's ID, and how many radios it hears.
2. **Put radio on this boat** → `TEST 2`. Walk the T-Echo around (or leave it by the window).
3. Check `TEST 2` moves on the map, about every 30 s or as often as the T-Echo is set to report.
4. Turn the T-Echo off for 2 minutes, then on: the app should show **Reconnecting…**, then
   **Relaying** again.

## 4. No signal (10 min)

1. On Phone B, while sharing, turn on airplane mode for 5 minutes (GPS still works). Walk.
2. Track tab: "Waiting to send" should count up.
3. Airplane mode off: it should drop to **Nothing**, and the laptop map should fill in the gap.

## 5. A race (10 min)

1. Laptop, Start: start the class (1 minute). Walk Phone B over the start line just before the gun.
2. After the gun, the Start tab should say GPS thinks `TEST 1` was over. Raise X, mark it back.
3. Walk Phone B up the course (more than 150 m) and back over the finish line (the start line).
4. Finishes: a GPS finish should be suggested; **Record** it. Tap the others' finishes by hand.
5. End the race. Results → Export → both Sailwave files; import them into Sailwave on a computer.

Note: how far off was the GPS finish time from when you crossed? Did Sailwave map every column?

## Send back

The notes, phone make/model and Android version, and the regatta code (the server keeps the
track, so it can be looked at afterwards).
