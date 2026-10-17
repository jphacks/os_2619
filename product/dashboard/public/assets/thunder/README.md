# 電気の実行用テクスチャ

原本は `effect-assets/textures/`。このフォルダはダッシュボードから配信するためのコピーです。

- `electric-arc-v2.png`: 小・中の飛翔中に使う、横向きの鋭い放電片。
- `electric-burst-v2.png`: 小・中の着弾と大の落雷地点に使う、放射状の放電片。
- `glow.png`: 黄白い中心光。
- `spark.png`: 飛び散る短い電気火花。

主放電の経路、球状コア、上空から落ちる雷は `thunder-effects.js` が3D形状として描きます。
