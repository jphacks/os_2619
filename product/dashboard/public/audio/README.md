# 効果音の出どころ（水・風）

水と風の効果音は、次の CC0 素材と、`effect-assets/procedural/make-sfx.mjs` で合成した音を重ねて作りました。作り直すときは素材を展開したフォルダを渡して `node effect-assets/procedural/make-sfx.mjs <フォルダ>` を実行します。

| ファイル | 使う場面 | 中身 |
|---|---|---|
| water1.mp3 | 水の発射と小の着弾 | splash_06 |
| water2.mp3 | 水の中の着弾 | splash_04 と splash_13 を重ね、合成した低い「ドン」を足した音 |
| water3.mp3 | 水の大の着弾（3〜6秒で消える） | splash_08・04・07 を重ね、低い「ドン」と loop_water_02 の波音を足した音 |
| wind1.mp3 | 風の発射と小の着弾 | 合成した風切り音（左から右へ抜ける）に swish-7 を重ねた音 |
| wind2.mp3 | 風の中の着弾 | 交差する2本の風切り音と低い風に、swish-9・swish-4 を重ねた音 |
| wind3.mp3 | 風の大の着弾（3〜6秒で消える） | 吸い込む風切り音のあと、うなる竜巻（共鳴するノイズ・低いうなり・突風）を合成し、swish-9・swish-12 を重ねた音 |

## 素材とライセンス

- 「40 CC0 water / splash / slime SFX」rubberduck 作、CC0。https://opengameart.org/content/40-cc0-water-splash-slime-sfx （water-splash-slime-sfx.zip）
- 「Swishes Sound Pack」artisticdude 作、CC0。https://opengameart.org/content/swishes-sound-pack （swishes.zip）

合成した部分は、このリポジトリのコードで作った音なので、外部のライセンスはかかりません。

## 音量

`audio.js` の `LUFS` 表は、各ファイルを ffmpeg の ebur128 で測った値です。ファイルを作り直したら測り直してください。
