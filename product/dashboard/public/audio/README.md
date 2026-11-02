# 効果音の出どころ（水・風）

水と風の効果音は、次の CC0 素材と、`effect-assets/procedural/make-sfx.mjs` で合成した音を重ねて作りました。作り直すときは素材を展開したフォルダを渡して `node effect-assets/procedural/make-sfx.mjs <フォルダ>` を実行します。

| ファイル | 使う場面 | 中身 |
|---|---|---|
| water1.mp3 | 水の発射と小の着弾 | splash_06 |
| water2.mp3 | 水の中の着弾 | splash_04 で槍が当たり、0.18 秒後に渦から柱が噴き上がる（splash_13 と合成した低い「ドン」） |
| water3.mp3 | 水の大の着弾（3〜6秒で消える） | 0.45 秒までは渦潮の泡（loop_bubbles_1）と床下でふくらむ低い音が鳴る。0.45 秒で間欠泉が噴き上がり（splash_08・04 と低い「ドン」）、0.62 秒と 0.8 秒に横の水柱（splash_07・13）が続く。1.3 秒から崩れた水が雨（loop_rain）になり、loop_water_02 の波音が残る |
| wind1.mp3 | 風の発射と小の着弾 | 合成した風切り音（左から右へ抜ける）に swish-7 を重ねた音 |
| wind2.mp3 | 風の中の着弾 | 左右から迫る2本の風切り音が 0.14 秒で交わり、swish-9 と低い空気の「ドン」が鳴る。続く追い斬りは swish-4・swish-7 |
| wind3.mp3 | 風の大の着弾（3〜6秒で消える） | 0.65 秒までに左右交互から10本の刃の風切り音が迫り、交わる瞬間に swish-9 と低い「ドン」が鳴る。続いて竜巻がうなり（共鳴するノイズ・低いうなり・突風）、2.05 秒に外へ吹き抜ける突風と swish-12 で終わる |

## 素材とライセンス

- 「40 CC0 water / splash / slime SFX」rubberduck 作、CC0。https://opengameart.org/content/40-cc0-water-splash-slime-sfx （water-splash-slime-sfx.zip）
- 「Swishes Sound Pack」artisticdude 作、CC0。https://opengameart.org/content/swishes-sound-pack （swishes.zip）

合成した部分は、このリポジトリのコードで作った音なので、外部のライセンスはかかりません。

## 音量

`audio.js` の `LUFS` 表は、各ファイルを ffmpeg の ebur128 で測った値です。ファイルを作り直したら測り直してください。
