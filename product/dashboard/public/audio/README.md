# 効果音の出どころ（水・風）

水と風の効果音は、次の CC0 素材と、`effect-assets/procedural/make-sfx.mjs` で合成した音を重ねて作りました。作り直すときは素材を展開したフォルダを渡して `node effect-assets/procedural/make-sfx.mjs <フォルダ>` を実行します。

| ファイル | 使う場面 | 中身 |
|---|---|---|
| water1.mp3 | 水の発射と小の着弾 | splash_06 |
| water2.mp3 | 水の中の着弾 | splash_04 と splash_13 が同時に鳴り、低い「ドン」が重なる。的の足元から水柱が噴き上がる瞬間に合わせた |
| water3.mp3 | 水の大の着弾（3〜6秒で消える） | splash_06 で玉が魔法陣に飛び込む。0.35 秒から滝の流れ落ちる音（loop_water_02）が強まり、床下でふくらむ低い音が 0.9 秒まで続く。0.9 秒に滝が床を打つ（splash_08・04 と低い「ドン」）。1.25 秒と 1.6 秒に飛沫（splash_07・13）が続き、1.8 秒から雨（loop_rain）と波音が残る |
| wind1.mp3 | 風の発射と小の着弾 | 合成した風切り音（左から右へ抜ける）に swish-7 を重ねた音 |
| wind2.mp3 | 風の中の着弾 | 2枚の刃が迫る風切り音が 0.14 秒で交わり、swish-9 と低い空気の「ドン」が鳴る。続く追い斬りは swish-4・swish-7 |
| wind3.mp3 | 風の大の着弾（3〜6秒で消える） | 竜巻が的に着いてふくらむ瞬間に、風切り音・swish-9・低い「ドン」が鳴る。竜巻のうなり（共鳴するノイズ・低いうなり・突風）が続き、1.45 秒に外へ吹き抜ける突風と swish-12 で終わる |

## 素材とライセンス

- 「40 CC0 water / splash / slime SFX」rubberduck 作、CC0。https://opengameart.org/content/40-cc0-water-splash-slime-sfx （water-splash-slime-sfx.zip）
- 「Swishes Sound Pack」artisticdude 作、CC0。https://opengameart.org/content/swishes-sound-pack （swishes.zip）

合成した部分は、このリポジトリのコードで作った音なので、外部のライセンスはかかりません。

## 音量

`audio.js` の `LUFS` 表は、各ファイルを ffmpeg の ebur128 で測った値です。ファイルを作り直したら測り直してください。
