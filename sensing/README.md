# SensorLink

Two Android phones, each with its own WitMotion WT9011DCL IMU over Bluetooth, stream sensor and vision data over the LAN to a PC dashboard.

```
 WT9011DCL ─BLE─► Phone A ─┐  WiFi / WebSocket
 WT9011DCL ─BLE─► Phone B ─┴──────────────────► PC: node server.mjs ──► browser dashboard (http://localhost:8000)
```

| Folder | What |
|---|---|
| `android/` | Phone app (Kotlin, ARCore + OpenCV + MediaPipe + OkHttp) |
| `dashboard/server.mjs` | Accepts up to 2 phones (slots A, B), relays to dashboards, answers clock-sync pings |
| `dashboard/index.html` | Dashboard: space map, video with overlays, IMU charts + orientation, AR state + top-down track, tags, hands, pose, colour, rates and latency |
| `dashboard/map.js` | Space map estimator (shared by the dashboard and the test) |
| `dashboard/sim.mjs` | Synthetic two-person scene with known geometry |
| `dashboard/fake-phone.mjs` | Synthetic phones streaming the sim scene, to try the dashboard without hardware |
| `dashboard/test.mjs`, `test-map.mjs` | Server self-check; space map accuracy against the sim scene |

## Space map

The top card fuses both phones into one room. Setup it expects: A and B wear the phones on the chest, each chest mount carries an AprilTag, the floor corners carry AprilTags, each person swings a stick of known length with a coloured tip, and each phone has the **opponent's** tip colour picked. Tag sizes are fixed in the app: 50 mm for the worn tags (ids 8-11), 200 mm for every other tag.

- Tags whose face points up are floor tags; any other tag a phone sees is the opponent's chest mount. No tag IDs to configure.
- B's ARCore world is fitted onto A's (yaw + shift, both gravity-aligned) from chest sightings paired with the other phone's own AR position at the same instant, plus any floor tag both phones have seen. Walk around a little at the start so the fit has spread.
- Room frame: origin at the centre of the floor tags, floor at height 0, +x from the lowest tag ID towards its nearest tag. It shifts as more floor tags are found.
- Opponent pose is lifted to 3D from the chest tag's depth plus MediaPipe's relative depth; the stick tip is the point on the viewing ray that lies one stick length from the nearer wrist (ambiguity resolved by the last tip, then the forearm direction).
- Panel: positions, distance A–B, tip height and its distance to the target's chest, fit residual, and "tag check" (AR position vs. where the other phone sees the chest tag: about the phone-to-tag offset when all is well).
- Sim accuracy (`npm test`, tag noise ~1 %): people < 1 cm, tips ~2 cm median, worst ~17 cm.

## PC

```
cd dashboard
npm install
npm start            # prints the IP + port to type into the phones
# open http://localhost:8000
npm run fake         # optional: two fake phones
npm test             # server self-check
```

Allow Node through the Windows firewall (private network) the first time, or phones can't connect.

## Phone app

Build: open `android/` in Android Studio, or `cd android && ./gradlew assembleDebug` (JDK 17+). The first build downloads the MediaPipe models into `app/src/main/assets`.
Install: `adb install -r app/build/outputs/apk/debug/app-debug.apk`. Needs an ARCore-supported phone, Android 8+.

On the phone:
- **LAN**: PC IP, port (8000). *Connect / reconnect* saves and reconnects; it also retries every second on its own. Status line shows slot (A/B) and RTT.
- **IMU**: scans BLE, WitMotion devices (`WT…`) listed first; tap to pair. The phone remembers it and reconnects automatically. Sets the sensor to 100 Hz.
- **Calibrate**: current IMU orientation becomes identity (`q`), current AR pose becomes the origin. Hold still in the start pose.
- **Tap the picture** to pick the colour to track (average of a 7×7 patch). Saturated colours work best.

The screen shows the camera picture with tags (green), hands (cyan), opponent pose (magenta) and the colour blob (yellow) drawn on top, plus link/IMU/AR status and per-detector rates.

## Protocol (JSON over `ws://PC:8000/ws`)

Each phone opens two sockets: one for sensor JSON, one for JPEG video (so a frame never delays sensor data). Both start with `{"type":"hello","role":"phone"|"video","id","name"}`.
Times `t` are seconds on the PC clock (phones sync via `ping`/`pong`, lowest RTT wins). Image coordinates are normalised 0..1 in the upright portrait image, the same image the video shows.
The server adds `slot` (`A`/`B`) to everything it relays. Video reaches the dashboard as binary: first byte = slot, then the JPEG.

| type | rate | fields |
|---|---|---|
| `imu` | 100 Hz | `euler` [roll, pitch, yaw] deg (sensor raw), `acc` m/s², `gyro` deg/s, `q` [w,x,y,z] relative to calibration |
| `ar` | camera rate (30) | `tracking`, `reason`, `p` [x,y,z] m, `q` [x,y,z,w] (ARCore camera pose, relative to calibration), `wp`/`wq` same pose in the raw gravity-aligned ARCore world, `planes` |
| `tags` | as fast as detection runs | `tags[]`: `id`, `c` 4 corners, `p` [x,y,z] m and `r` Rodrigues rotation in the OpenCV camera frame (x right, y down, z forward); `k` intrinsics [fx/W, fy/H, cx/W, cy/H] of the upright image |
| `hands` | 〃 | `hands[]`: `side`, `score`, `lm` 21 × [x,y,z] |
| `pose` | 〃 | `found`, `lm` 33 × [x,y,z,visibility] |
| `color` | 〃 | `side` (`me` / `opp`; two targets, picked with the Pick button + tap), `target` HSV (OpenCV scale), `found`, `x`,`y` centroid of the largest blob, `area` fraction, `box` [x,y,w,h] |
| `calib` | on button | — |

Every detector runs on its own thread and always takes the newest frame (busy → frame skipped), so a slow one never delays the others. Video is ~15 fps JPEG and is dropped when the socket is backed up.

## Not done / to check on hardware

- Not run on a phone yet: the APK builds, but ARCore, BLE parsing, detectors and the overlay are untested on a device.
- Assumes the back camera sensor is mounted at 90° (true for nearly all phones). If the picture is sideways, that's the line marked `shortcut:` in `MainActivity.kt`.
- AprilTag uses OpenCV's aruco detector (tag36h11), not the reference AprilTag library: a bit less robust at small sizes.
- Space map: only checked against the sim. The WitMotion IMUs are not used in it (their mounting isn't defined). Wall-mounted tags would be mistaken for a chest mount. Hip depth assumes the hips sit 0.4 m below the chest tag.
- Calibration is a tare (orientation + AR origin). It does not run the WitMotion accelerometer/magnetometer calibration; do that once with WitMotion's app.
