# 3D魔法エフェクト用素材

素材の原本はこのフォルダ内にあります。炎と電気の小・中・大、チャージ中の全身オーラと杖先球は `product/dashboard` のゲーム画面・最終映像へ組み込み済みです。操作と範囲は [FIRE_IMPLEMENTATION.md](FIRE_IMPLEMENTATION.md)、[THUNDER_IMPLEMENTATION.md](THUNDER_IMPLEMENTATION.md)、[CHARGE_IMPLEMENTATION.md](CHARGE_IMPLEMENTATION.md) を参照してください。

## 完成素材

`textures/` の14枚が素材です。12枚をCodex内蔵の画像生成ツールで生成し、共通の光・火花2枚は数式で作成しました。全て透過RGBA PNGです。`fire-lobe-v2.png` は炎の色付き、それ以外は主にグレーの濃淡と透明度を持ち、描画側で着色します。

| PNG | 用途 |
|---|---|
| `flame-density.png` | 炎の一房。火弾の尾、着弾の火柱 |
| `explosion-density.png` | 爆炎を構成する膨らんだ一塊 |
| `smoke-puff.png` | 爆発後の煙、炎の外側の薄い煙 |
| `electric-filament.png` | 局所的な稲妻、放電の補助粒子 |
| `aura-wisp.png` | 体の周囲を上昇するチャージの筋 |
| `plasma-flow.png` | チャージ球・電気弾の周囲を流れるエネルギーの断片 |
| `glow.png` | 中心光、柔らかな発光 |
| `spark.png` | 短い火花、飛び散る光の筋 |
| `flame-tongue.png` | 中心が明るい炎の一房。小の火柱に使用 |
| `short-flame.png` | 炎小向けに生成した短炎の代替案。現在の実装では未使用 |
| `electric-spike.png` | 初期候補の枝分かれ放電。現在の電気攻撃ではv2素材を採用 |
| `fire-lobe-v2.png` | 色付きの密度のある炎。火球の尾と球状爆炎の表面に使用 |
| `electric-arc-v2.png` | 電気小・中の飛翔中に使う鋭い横向き放電 |
| `electric-burst-v2.png` | 電気の着弾と大の落雷地点に使う放射状放電 |

元の生成PNGをそのまま保存しています。サイズ・透過の実測結果は `validation.json`、生成指示は `generation.json`、`fire-generation.json`、`thunder-generation.json` にあります。指示TXTを入力する仕組みはありません。

`preview.html` をブラウザで開くと14枚を背景・色付きで比較できます。`preview-dark.png` と `preview-light.png` は一覧確認用で、ゲーム用素材ではありません。

## 各技への割り当て

| 演出の参考 | PNGで用意した部分 | JS / 3D側で作る部分 |
|---|---|---|
| 炎小：PKファイア | flame-tongue / spark / glow | 元素材の縦横比を保った低い炎、着弾点からの燃焼 |
| 炎中：ファイガ | flame / plasma / glow | 球状の中心、追従する尾、弾の軌道 |
| 炎大：爆炎 | explosion / flame / smoke / spark | 着弾地点から複数の塊が球状に膨張、時間差で消失 |
| 電気小：サンダー | electric-arc-v2 / electric-burst-v2 / glow | 細い直進弾、短い3D放電、着弾光 |
| 電気中：エルサンダー | electric-arc-v2 / electric-burst-v2 / glow / spark | 黄白い球状コア、放電尾、球状の着弾放電 |
| 電気大：かみなり | electric-burst-v2 / spark / glow | 上空から着弾点を結ぶ太い3Dの稲妻、中心閃光 |
| 体のチャージ：リミットチャージ | aura-wisp / glow | 胸の周囲への3D配置、上昇、溜めによる密度変化 |
| 杖先のチャージ：スパーク風 | plasma-flow / electric-filament / spark / glow | 球メッシュ、球面上を流れる属性別粒子、3Dリング、溜めによる拡大 |

上表の略称はPNG名の先頭部分です。参考技の画像そのものを複製したものではありません。PNG一枚で技全体を完成させず、小・中・大は粒子数、空間的な大きさ、速度、寿命と発生タイミングで作り分けます。

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
  textures/              # 素材14枚
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
