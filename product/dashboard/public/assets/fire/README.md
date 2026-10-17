# 炎の実行用テクスチャ

原本は `effect-assets/textures/`。このフォルダは `product/dashboard/server.mjs` から配信するためのコピーです。

- fire-lobe-v2.png: 色付きの炎の塊。ファイガの火球・尾、爆炎の破裂。
- flame-tongue.png: 白い炎の一房。PKファイアの火柱、ファイガ着弾後に残る炎、爆炎の球から立つ炎。
- flame-density.png: ファイガの尾を流れる炎。
- explosion-density.png: ファイガの着弾、爆炎の破裂で飛ぶ炎の塊。
- smoke-puff.png: PKファイアの暗赤色の煙、爆炎の黒煙。
- glow.png・spark.png: 数式で作った共通の光・火花。
- star-flare.png・spike-burst.png・pk-diamond.png・shock-ring.png: `effect-assets/procedural/make-textures.mjs` で生成した星形フレア、ギザギザの閃光、PKの◆、衝撃の輪。
- short-flame.png: 以前生成した短炎の代替案。現在の描画では未使用。

ジグザグ弾、火球・爆炎の球体（ノイズシェーダー）は `fire-effects.js` が3D形状として描きます。元ゲームの画像をテクスチャとして配信していません。
