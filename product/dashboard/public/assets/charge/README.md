# チャージ実行用テクスチャ

原本は `effect-assets/textures/`。このフォルダはダッシュボードから配信するためのコピーです。

- `aura-wisp.png`: 炎属性で脚の周りを上がる揺らぎ。
- `electric-filament.png`: 電気属性で脚の周りを走る放電。
- `smoke-puff.png`: 足元から広がる白い土煙。
- `spark-corona.png`: 杖先球の外周のギザギザ。
- `star-flare.png`: 杖先球の中の星、全身の周りの瞬き。
- `spike-burst.png`: 杖先球の中心。
- `shock-ring.png`: 足元の輪、満タン時に広がる輪。
- `glow.png`・`spark.png`: 中心光と周回する火花。

`spark-corona.png`・`star-flare.png`・`spike-burst.png`・`shock-ring.png` は `effect-assets/procedural/make-textures.mjs` で生成しています。光の柱、杖先球の球体と稲妻は `charge-effects.js` が3D形状として描きます。
