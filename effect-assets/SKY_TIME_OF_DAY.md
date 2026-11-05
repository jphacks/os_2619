# ゲーム画面の時刻（空と光）

ゲーム画面の操作欄にある「時刻」で、中庭と岩場の空と光を 0〜24 時の間で変えられます。朝・昼・夕焼け・夜・星空のボタンで、決まった時刻にも飛べます。値は `cfg.timeOfDay` に保存されます。初期値の 14 時は、時刻を入れる前の見た目とまったく同じです。無地の背景では時刻は効きません。

## 仕組み

`product/dashboard/public/sky.js` の `timeOfDay(h, anchor)` は、時刻から次の値を求める純粋な関数です。

- 太陽と月の向き、地面を照らす光の向き
- 空の色（地平線・中ほど・天頂）、太陽のまわりの光、雲の色、遠くのかすみの色
- 直射光と空からの光の色。どちらも各背景の昼の色に掛ける倍率で、昼は 1 です
- 星の量、窓の明かりの量

色は時刻ごとの表（キーフレーム）を直線でつないで求めます。9〜15.4 時は各背景がもともと持つ昼の空をそのまま使い、朝夕と夜だけを表の色に切り替えます。中庭と岩場は同じ表を使います。

## 照明で決めたこと

- 太陽の高さ: 空に描く太陽は実際の高さで沈みます。地面を照らす光は 28° より低くしません。これより低いと、中庭の建物や岩場の高い崖がフィールドに影を落とします（`test-sky.mjs` で毎時確かめています）
- 太陽の向き: 中庭では左手前に沈み、岩場では右に沈みます。岩場の左には高い崖があるためです
- 直射光と空の光の比: 昼は直射光が強く影がはっきりします。夕方は直射光を暖色にして弱め、夜は青い空の光を主にします（参考: Inigo Quilez の屋外照明の記事）
- 夜の見やすさ: 月は画面の奥に描きます。一方で、光は昼の太陽と同じ向き（カメラの後ろ）から当てています。プレイヤーの正面が暗くならないようにするためで、意図してずらしています。アバターには青い縁取りの光を強めに当て、直射光は昼の 6 割より暗くしません
- 星: 方向を格子に分けて、1 マスに 1 個の点を置きます。点の大きさは画面で 1 ピクセル以上にしているので、カメラが動いてもちらつきません。天の川に沿った帯では星を増やしています
- 中庭の夜: 窓の多くと回廊に暖色の明かりをともします

## 影の付け直し

影は太陽の向きから 1 枚の画像に焼いています（`backdrop.js` の `sunBaker`）。

- スライダーを動かしている間は、256² の小さい画像で焼き直します（約 11 ms）
- 動きが 300 ms 止まったら、1024² で焼き直します。中庭は約 120〜200 ms、岩場は約 260〜350 ms かかり、このとき 1 回だけ画面が止まります
- 夜は光の向きが昼と同じなので、焼き直しません

計測（Playwright、ヘッドレスの Chromium、Apple GPU）では、止まっているときの 1 フレームの描画時間は時刻を入れる前と変わらず、2〜3 ms でした。スライダーを動かしている間は、フレームの間隔が中央値で約 15 ms になります。

## Three.js の Sky を使わなかった理由

Three.js の例（Preetham モデルの `Sky`）は、物理的に正しい明るさの空を出力し、トーンマッピングと露出で整える前提です。この画面のシェーダーは表示用の色を直接書いているので、Sky を入れると、昼の見た目を前と同じに保てません。そのため、空は芸術的な色の表で作り、太陽の色と高さの関係は物理モデルを目安にしました。

## 参考

- Three.js Sky の例: https://threejs.org/examples/webgl_shaders_sky.html
- Preetham, Shirley, Smits「A Practical Analytic Model for Daylight」(1999): https://www2.cs.utah.edu/~shirley/papers/sunsky/sunsky.pdf
- Hosek, Wilkie「An Analytic Model for Full Spectral Sky-Dome Radiance」(2012): https://cgg.mff.cuni.cz/projects/SkylightModelling/
- Hillaire「A Scalable and Production Ready Sky and Atmosphere Rendering Technique」(2020): https://sebh.github.io/publications/egsr2020.pdf
- Inigo Quilez「outdoors lighting」（太陽・空・照り返しの 3 つの光）: https://iquilezles.org/articles/outdoorslighting/
- 色温度から RGB への変換（Tanner Helland）: https://tannerhelland.com/2012/09/18/convert-temperature-rgb-algorithm-code.html
- Unreal Engine の Sky Atmosphere: https://dev.epicgames.com/documentation/en-us/unreal-engine/sky-atmosphere-component-in-unreal-engine
