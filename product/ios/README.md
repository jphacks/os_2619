# SensorLink for iOS（Swift）

`product/android/` と同じ役割の iPhone 版。スマホ A・B として胸に付け、棒の IMU（WitMotion WT9011DCL、Bluetooth）と、自分の位置・向き（ARKit）、床のタグ（AprilTag / RuneTag）を、PC の `dashboard` に WebSocket で送る。**PC 側は変更なし**：送る JSON（`hello`・`ping`・`imu`・`ar`・`tags`・`calib`）の形、単位、頻度は Android 版と同じ。

| Android | iOS | 備考 |
|---|---|---|
| `Link.kt`（OkHttp） | `Link.swift`（URLSessionWebSocketTask） | 時計合わせ・再接続・古いパケットの破棄まで同じ |
| `Imu.kt`（BLE GATT） | `Imu.swift`（CoreBluetooth） | iOS は MAC アドレスを見せないので、保存するのは `peripheral.identifier`（UUID） |
| `MainActivity.kt`（ARCore） | `Model.swift`（ARKit）、`ContentView.swift`（SwiftUI） | `ARFrame.camera.transform` は ARCore の `Camera.pose` と同じ軸なので、`wp`/`wq` はそのまま出す |
| `Vision.kt`（OpenCV） | `TagBridge.mm`（OpenCV、Obj-C++）、`TagDetector.swift` | 検出は同じ OpenCV の aruco（tag36h11）と `solvePnP`（IPPE_SQUARE）。画像は輝度面だけを時計回りに 90° 回す（Android と同じ縦向きの画像、同じ内部パラメータの変換） |
| `Rune.kt` | `Rune.swift` | 行単位の移植 |

## ビルド（Mac が要る）

```
brew install xcodegen
cd <this repo>
./scripts/fetch-opencv.sh          # 公式の OpenCV iOS framework（4.10.0）を Frameworks/ に置く
DEVELOPMENT_TEAM=XXXXXXXXXX xcodegen generate     # SensorLink.xcodeproj ができる（git には入れない）
open SensorLink.xcodeproj          # 実機（iPhone）を選んで Run
```

- `DEVELOPMENT_TEAM` は Apple Developer の Team ID。後から Xcode の Signing & Capabilities で選んでもよい
- シミュレーターでは ARKit のカメラも Bluetooth も動かないので、実機で試す
- 初回起動で、カメラ・Bluetooth・ローカルネットワークの許可を聞かれる。**ローカルネットワークを拒否すると PC につながらない**（設定 → SensorLink で直せる）
- 使い方は Android 版と同じ：下の `LAN` に PC の IP とポート（8000）を入れて接続、`IMU` で棒のセンサーを選び、棒を水平に構えて `Calibrate`

## 未確認のこと（Windows で書いたのでまだ 1 回もビルドしていない）

- **コンパイルが通るか**。書いたのは Mac のない環境なので、最初のビルドで小さな型エラーが出るかもしれない
- OpenCV の framework が静的かどうか（`project.yml` は `embed: false`）。動的だった場合は `embed: true` にする
- ARKit の軸・内部パラメータが Android と一致するか。接続画面の「ARCore の状態」「カメラの向き補正」（4 通りの残差）で、選ばれた向きの残差だけが小さければ合っている。大きくずれるときは `Model.swift` の `session(_:didUpdate:)` の `wp`/`wq` と、画像の回転の向きを見る
- RuneTag は Android 版でも実物を撮っていないので、まず AprilTag で通すこと
- IMU の遅延・時刻：IMU の時刻は受信時刻（Android と同じ）。AR フレームは `ARFrame.timestamp`（端末の起動時刻基準）から撮影時刻を求めている
