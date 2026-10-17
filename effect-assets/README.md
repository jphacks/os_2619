# 3D魔法エフェクト用素材

素材の原本はこのフォルダ内にあります。炎と電気の小・中・大、チャージ中の全身オーラと杖先球は `product/dashboard` のゲーム画面・最終映像へ組み込み済みです。操作と範囲は [FIRE_IMPLEMENTATION.md](FIRE_IMPLEMENTATION.md)、[THUNDER_IMPLEMENTATION.md](THUNDER_IMPLEMENTATION.md)、[CHARGE_IMPLEMENTATION.md](CHARGE_IMPLEMENTATION.md) を参照してください。

## 完成素材

`textures/` の20枚が素材です。12枚をCodex内蔵の画像生成ツールで生成し、共通の光・火花2枚は数式で作成しました。残り6枚（星形フレア、ギザギザの閃光2種、PKの◆、スパーク球の歯状コロナ、衝撃の輪）は `procedural/make-textures.mjs` が手続き的に生成します。全て透過RGBA PNGです。`fire-lobe-v2.png` は炎の色付き、それ以外は主にグレーの濃淡と透明度を持ち、描画側で着色します。

| PNG | 用途 |
|---|---|
| `flame-density.png` | ファイガの尾を流れる炎 |
| `explosion-density.png` | ファイガ着弾・爆炎破裂で飛ぶ炎の塊 |
| `smoke-puff.png` | PKファイアの暗赤色の煙、爆炎の黒煙、チャージの土煙 |
| `electric-filament.png` | 電気チャージで脚の周りを走る放電 |
| `aura-wisp.png` | 炎チャージで脚の周りを上がる揺らぎ |
| `plasma-flow.png` | 旧チャージ球の表面素材。現在の実装では未使用 |
| `glow.png` | 中心光、柔らかな発光 |
| `spark.png` | 短い火花、飛び散る光の筋 |
| `flame-tongue.png` | PKファイアの火柱、爆炎の球から立つ炎、ファイガ着弾後に残る炎 |
| `short-flame.png` | 炎小向けに生成した短炎の代替案。現在の実装では未使用 |
| `electric-spike.png` | 初期候補の枝分かれ放電。現在の実装では未使用 |
| `fire-lobe-v2.png` | 色付きの炎の塊。ファイガの火球・尾、爆炎の破裂 |
| `electric-arc-v2.png` | 電気小・中の弾の尾に重ねる放電片 |
| `electric-burst-v2.png` | 電気中・大の着弾に重ねる放射状放電 |
| `star-flare.png` | 爆炎中心の大きな星、着弾の瞬間の閃光、杖先球の中の星（手続き生成） |
| `spike-burst.png`・`spike-burst-2.png` | 電気の弾のコア・着弾のギザギザの星、炎の着弾の閃光（手続き生成） |
| `pk-diamond.png` | PKファイアの火柱の周りを漂う◆（手続き生成） |
| `spark-corona.png` | 杖先スパーク球の外周の歯（手続き生成） |
| `shock-ring.png` | ファイガ着弾の輪、爆炎の輪郭、チャージの足元の輪（手続き生成） |

生成画像は元のPNGをそのまま保存しています。サイズ・透過の実測結果は `validation.json`、生成指示は `generation.json`、`fire-generation.json`、`thunder-generation.json` にあります（手続き生成の6枚は含みません）。指示TXTを入力する仕組みはありません。手続き生成の6枚は次で再生成でき、同じバイト列を `textures/` と `product/dashboard/public/assets/` の各フォルダへ書き込みます。

```powershell
node effect-assets/procedural/make-textures.mjs
```

`preview.html` をブラウザで開くと初期の14枚を背景・色付きで比較できます。`preview-dark.png` と `preview-light.png` は一覧確認用で、ゲーム用素材ではありません。

## 各技への割り当て

| 演出の参考 | PNGで用意した部分 | JS / 3D側で作る部分 |
|---|---|---|
| 炎小：PKファイア | flame-tongue / smoke / pk-diamond / star / spike | 黄色いジグザグ弾（押し出し形状）と残像。着弾点から背丈を超える深紅の火柱、白い芯、上部の暗赤色の煙、漂う◆ |
| 炎中：ファイガ | fire-lobe / flame-density / flame-tongue / explosion / star / spike / shock-ring | ノイズシェーダーの火球と後方へ流れる炎の尾。着弾は星形の閃光と炎の塊の飛散、相手に残る炎 |
| 炎大：爆炎 | star / shock-ring / flame-tongue / explosion / fire-lobe / smoke | 明るい輪郭と暗い渦の内部を持つ炎の球、外周の炎の殻、中心の大きな星。保持後に破裂して炎の塊と黒煙 |
| 電気小：サンダー | spike / electric-arc-v2 / star | ギザギザの星のコア、黄色い光の尾と絡む稲妻。着弾は小さなギザギザの星 |
| 電気中：エルサンダー | spike / electric-arc-v2 / electric-burst-v2 / star | 大きいコアと太い光の尾。着弾は黒い縁取り付きの大きなギザギザの星と放射する稲妻 |
| 電気大：かみなり | spike / electric-burst-v2 / star | 上空の光、太い落雷の柱、相手を包む巨大なギザギザの爆発、黒い芯の稲妻、残る稲妻 |
| 体のチャージ：リミットチャージ | smoke / aura-wisp / electric-filament / star / shock-ring / glow | 体の周りを上る細い光の柱（黄＋属性色）、脚の周りの揺らぎ、足元の土煙と輪。満タンで脈動 |
| 杖先のチャージ：スパーク風 | spark-corona / star / spike / glow / spark | 透ける球体（明るい輪郭）、歯状のコロナ、外へ伸びるギザギザの稲妻。炎は橙＋黄、電気は水色＋黄緑 |

上表の略称はPNG名の先頭部分です。参考技の画像そのものを複製したものではありません。PNG一枚で技全体を完成させず、小・中・大は形・大きさ・時間構成で作り分けます。稲妻・光の柱・弾の尾はカメラを向く帯（`product/dashboard/public/effect-kit.js` の ribbon）を3Dの折れ線に沿って並べて描きます。

## 3D・リプレイで使う際の条件

- 球、稲妻の経路、爆発の広がりは3Dで持ち、PNGは局所的な質感に使います。平面一枚を拡大しただけでは裏側・横側の見え方は成立しません。
- 炎や煙の粒子は3D位置に分散させます。ビルボードを使う場合も、粒子を一平面に並べないでください。
- 色は炎を橙〜黄、電気を青白〜黄などに着色します。明るい中心を出すにはHDR発光量とブルームを調整します。煙は通常のアルファ合成、光・放電は加算または適切なプリマルチプライド合成を使い分けます。
- PNGは通常のRGBAとして扱います。既存の `kawashima/effects.js` はプリマルチプライド出力なので、RGBにアルファを掛ける箇所を一度に統一してください。
- 生成画像の外周にごく低いアルファの残留画素があります。必要ならシェーダーで `alpha < 0.01` を除去し、サンプラーのラップは `ClampToEdgeWrapping` にします。ハードな高閾値で細い炎を切り落とさないでください。
- 一時停止後の自由視点には、粒子ごとの発生時刻・初期位置・速度・乱数シードを記録し、リプレイ時刻から同じ状態を再現する仕組みが必要です。毎フレームの非固定乱数や、カメラ方向で変わる発生位置は避けます。
- `product/dashboard/public/effects.js` は炎を `fire-effects.js`、電気を `thunder-effects.js` に渡して映像へ合成します。深度テストは既存レイヤー同様に無効なので、実写人物や背景による遮蔽は未対応です。試合全体のリプレイ機能も未実装です。

最新のゲーム仕様（60秒・HP100・小中大の溜め・実移動で回避・ガードなし）は、画像に焼き込んでいません。

## 移動した生成環境

```
effect-assets/
  .env                   # APIキー。Git管理対象外
  .gitignore
  package.json
  imagegen/
    generate.mjs         # 以前のNano Banana用CLI
    output/              # 以前の生成結果。今回は不採用、Git管理対象外
  procedural/
    make-textures.mjs    # 手続き生成素材6枚のスクリプト
  textures/              # 素材20枚
  generation.json        # 生成方法・指示の記録
  fire-generation.json   # 炎追加素材の生成指示
  thunder-generation.json # 電気追加素材の生成指示
  validation.json        # PNGの検査結果
  preview.html
  preview-dark.png
  preview-light.png
```

今回は内蔵生成ツールを使っており、Nano Banana APIは追加実行していません。以前の結果は `imagegen/output/` に保管しました。旧環境を使う場合のみ、Node.js 22以上でこのフォルダに移動して実行します（依存パッケージのインストール不要）。

```powershell
cd effect-assets
npm run images -- --prompt "生成したい画像の指示" --name sample --dry-run
# --dry-runを外すとAPIを呼び出し、利用料金が発生します。
```

CLIはこのフォルダの `.env` を読み、結果を `imagegen/output/` に保存します。外側のREADMEやpackage.jsonには依存しません。
