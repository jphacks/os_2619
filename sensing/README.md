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
| `dashboard/index.html` | Dashboard: video with overlays, IMU charts + orientation, AR state + top-down track, tags, hands, pose, colour, rates and latency |
| `dashboard/fake-phone.mjs` | Synthetic phones, to try the dashboard without hardware |
| `dashboard/test.mjs` | Server self-check |

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
- **LAN**: PC IP, port (8000), AprilTag size. *Connect / reconnect* saves and reconnects; it also retries every second on its own. Status line shows slot (A/B) and RTT.
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
| `ar` | camera rate (30) | `tracking`, `reason`, `p` [x,y,z] m, `q` [x,y,z,w] (ARCore camera pose, relative to calibration), `planes` |
| `tags` | as fast as detection runs | `tags[]`: `id`, `c` 4 corners, `p` [x,y,z] m and `r` Rodrigues rotation in the OpenCV camera frame (x right, y down, z forward) |
| `hands` | 〃 | `hands[]`: `side`, `score`, `lm` 21 × [x,y,z] |
| `pose` | 〃 | `found`, `lm` 33 × [x,y,z,visibility] |
| `color` | 〃 | `target` HSV (OpenCV scale), `found`, `x`,`y` centroid of the largest blob, `area` fraction, `box` [x,y,w,h] |
| `calib` | on button | — |

Every detector runs on its own thread and always takes the newest frame (busy → frame skipped), so a slow one never delays the others. Video is ~15 fps JPEG and is dropped when the socket is backed up.

## Not done / to check on hardware

- Not run on a phone yet: the APK builds, but ARCore, BLE parsing, detectors and the overlay are untested on a device.
- Assumes the back camera sensor is mounted at 90° (true for nearly all phones). If the picture is sideways, that's the line marked `shortcut:` in `MainActivity.kt`.
- AprilTag uses OpenCV's aruco detector (tag36h11), not the reference AprilTag library: a bit less robust at small sizes.
- Calibration is a tare (orientation + AR origin). It does not run the WitMotion accelerometer/magnetometer calibration; do that once with WitMotion's app.
