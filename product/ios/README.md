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

2026-11-02 に Mac（Xcode 27.1）でビルドを確かめた。コードは直さずに通った。

```
brew install xcodegen
cd product/ios
./scripts/fetch-opencv.sh     # 公式の OpenCV iOS framework（4.10.0）を Frameworks/ に置く
xcodegen generate             # SensorLink.xcodeproj ができる（git には入れない）
```

- OpenCV の framework は静的ライブラリなので、`project.yml` は `embed: false` のままでよい
- 署名なしのビルド（`CODE_SIGNING_ALLOWED=NO`）は通る
- 個人のチームで署名したビルドも通る（Bundle ID は自分用に変えた）

## 自分の iPhone に入れる（個人のチーム）

無料の Apple ID で入れられる。App Store には出さない。

1. Xcode を開く。設定 → Accounts で Apple ID を足す
2. 上のコマンドで `SensorLink.xcodeproj` を作る
3. `open SensorLink.xcodeproj` で開く
4. iPhone を USB でつなぐ。iPhone で「このコンピュータを信頼」を押す
5. 初めてなら iPhone でデベロッパモードをオンにする（設定 → プライバシーとセキュリティ → デベロッパモード、再起動）
6. 左のツリーで SensorLink を選ぶ。Signing & Capabilities を開く
7. Team に自分の名前（Personal Team）を選ぶ
8. Bundle Identifier を自分用に変える（例 `jp.jphacks.fullstick.wataru`）。元の `com.kousu.fullstick` は他の人のもので、登録できない
9. 上の実行先で自分の iPhone を選び、Run（▶）を押す
10. 初回は iPhone で開けない。設定 → 一般 → VPN とデバイス管理で、自分の Apple ID を信頼する
11. もう一度 Run する

- 無料のチームで入れたアプリは 7 日で開けなくなる。そのときは Run し直す
- `xcodegen generate` をやり直すと、Bundle ID と Team は元に戻る。戻したくないときは次のようにコマンドで渡す

```
DEVELOPMENT_TEAM=<Team ID> xcodegen generate
xcodebuild -project SensorLink.xcodeproj -scheme SensorLink -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM=<Team ID> SENSORLINK_BUNDLE_ID=jp.jphacks.fullstick.<名前> -allowProvisioningUpdates build
```

- Team ID は証明書の OU の値で、名前の後ろの括弧の中の値とは違う。次のコマンドで分かる

```
security find-certificate -c "Apple Development" -p | openssl x509 -noout -subject
```

## 使い方

- 初回起動で、カメラ・Bluetooth・ローカルネットワークの許可を聞かれる。**ローカルネットワークを拒否すると PC につながらない**（設定 → SensorLink で直せる）
- 使い方は Android 版と同じ。下の `LAN` に PC の IP とポート（8000）を入れて接続する。`IMU` で棒のセンサーを選ぶ。棒を水平に構えて `Calibrate` を押す

## シミュレーター

公式の OpenCV には、Apple Silicon のシミュレーター用の部分（arm64-simulator）がない。そのため、そのままではシミュレーター向けにリンクできない。

起動だけは確かめた。`TagBridge.mm` を空の実装に差し替えた別のコピーで、iOS 26.5 のシミュレーターで起動した。画面は出て、`AR failed: Unsupported configuration.`（シミュレーターに ARKit がないため）と出た。ARKit のカメラも Bluetooth も、シミュレーターでは動かない。試すのは実機で行う。

## まだ確かめていないこと（実機が要る）

- 実機での起動と、カメラ・Bluetooth・ローカルネットワークの許可
- ARKit の軸・内部パラメータが Android と一致するか。接続画面の「ARCore の状態」「カメラの向き補正」（4 通りの残差）を見る。選ばれた向きの残差だけが小さければ合っている。大きくずれるときは `Model.swift` の `session(_:didUpdate:)` の `wp`/`wq` と、画像の回転の向きを見る
- RuneTag は Android 版でも実物を撮っていない。まず AprilTag で通すこと
- IMU の遅延・時刻。IMU の時刻は受信時刻（Android と同じ）。AR フレームは `ARFrame.timestamp`（端末の起動時刻基準）から撮影時刻を求めている
- PC へ送る JSON のキーは、コードを読んで Android と同じことを確かめた。実際に `dashboard` へつないでは試していない
