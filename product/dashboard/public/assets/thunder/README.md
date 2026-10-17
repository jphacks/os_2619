# 電気の実行用テクスチャ

原本は `effect-assets/textures/`。このフォルダはダッシュボードから配信するためのコピーです。

- `electric-arc-v2.png`: 小・中の弾の尾に重ねる横向きの放電片。
- `electric-burst-v2.png`: 中・大の着弾に重ねる放射状の放電片。
- `spike-burst.png`・`spike-burst-2.png`: 弾のコアと着弾のギザギザの星。2枚を交互に切り替えて明滅させる。
- `star-flare.png`: 着弾の瞬間の星形フレア。
- `glow.png`: 黄白い中心光。
- `spark.png`: 飛び散る短い電気火花。

`spike-burst*.png`・`star-flare.png` は `effect-assets/procedural/make-textures.mjs` で生成しています。稲妻の経路（弾の尾、上空からの落雷、放射する稲妻、黒い芯の稲妻）は `thunder-effects.js` が3Dの折れ線として描きます。
