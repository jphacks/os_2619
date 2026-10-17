# 炎の実行用テクスチャ

原本は `effect-assets/textures/`。このフォルダは `product/dashboard/server.mjs` から配信するためのコピーです。

- fire-lobe-v2.png: reference/ファイガ.png・爆炎.pngの色と密度を参考に内蔵画像生成ツールで新規作成した局所的な炎。
- flame-tongue.png: 白い炎の一房。シェーダーで赤橙〜白黄へ着色。
- short-flame.png: 以前生成した短炎の代替案。現在の描画では未使用。
- smoke-puff.png: 煙の密度。
- glow.png・spark.png: 数式で作った共通の光・火花。

火球の中心、黄色いジグザグ弾、球状爆炎、金色の輪と閃光は `fire-effects.js` が3D形状として描きます。元ゲームの画像をテクスチャとして配信していません。
