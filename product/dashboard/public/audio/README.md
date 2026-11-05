# 効果音の出どころ（水・風・溜め）

水と風の効果音、4属性の溜めの音、溜めが大になった瞬間の音は、下の素材を `effect-assets/procedural/make-sfx.mjs` で重ね、合成した音も足して作りました。素材をそのまま置いてはいません。作り直すときは、素材を下の配置で置いたフォルダを渡して `node effect-assets/procedural/make-sfx.mjs <フォルダ>` を実行します。

```
<フォルダ>/cc0/wa/*.ogg           water-splash-slime-sfx.zip を展開したもの
<フォルダ>/cc0/sw/swishes/*.wav   swishes.zip を展開したもの
<フォルダ>/fs/<番号>.mp3          Freesound の音の HQ プレビュー（https://freesound.org/s/<番号>/）
<フォルダ>/oga/leohpaz/*.wav      8_rpg_battle_magic_sfx_free_samples.zip を展開したもの
<フォルダ>/oga/magical_3.ogg      Magic Spell SFX の1本
```

## 作り方

市販のアクションゲームの魔法の音と同じく、1つの音を4つの層に分けて重ねています。

- 頭の一撃（トランジェント）: 本物の水しぶきの頭や、風切り音（swish）
- 胴（ボディ）: 水や空気のかたまりと、合成した低い「ドン」
- 魔法の層: leohpaz さんがゲーム用に作った水・風の魔法の音
- 尾（テール）: 落ちる滴、雨、波、吹き抜ける風

層ごとに帯域を分けて、互いに埋もれないようにしました。各層の音量は ebur128 で測った値から決め、ファイル全体は目標の音量にそろえたあと、-1.5 dBFS のリミッターをかけています。

| ファイル | 使う場面 | 中身 |
|---|---|---|
| water1.mp3 | 水の発射と小の着弾 | 大きな水しぶき（442773）の頭と splash_06 に、leohpaz の水の魔法と短い低音を重ねた |
| water2.mp3 | 水の中の着弾 | 的の足元から水柱が噴き上がる瞬間に、2つの大きな水しぶき（442773・316744）、splash_04・13、水の魔法、深い「ドン」が同時に鳴る。0.55 秒に滴（splash_07）が落ちる |
| water3.mp3 | 水の大の着弾（3〜6秒で消える） | splash_06 と水の魔法で玉が魔法陣に飛び込む。0.35 秒から滝の流れ（loop_water_02 と激流 193755）が強まり、床下の低音がふくらむ。0.6 秒から逆再生の水しぶきが吸い込むように高まり、0.9 秒に滝が床を打つ（442773・316744・splash_08 と深い「ドン」）。1.25 秒と 1.6 秒に飛沫が続き、1.8 秒から雨（loop_rain）と波（426075）が残る |
| wind1.mp3 | 風の発射と小の着弾 | 合成した風切り音（左から右へ抜ける）に、音程のある風切り音（60013）、swish-7、leohpaz の風の魔法を重ねた |
| wind2.mp3 | 風の中の着弾 | 2枚の刃が迫る風切り音が 0.14 秒で交わる。そこで速い風切り音（683101）の山、swish-9、低い空気の「ドン」が鳴る。追い斬りは swish-4・7、そのあと風の魔法と吹き荒れる風（361487）が残る |
| wind3.mp3 | 風の大の着弾（3〜6秒で消える） | 竜巻が的に着く瞬間に、風切り音・swish-9・低い「ドン」・風の魔法が鳴る。竜巻のうなり（合成した共鳴ノイズ、強風 344887、うなる風 638434）が続く。1.45 秒に外へ吹き抜ける突風（683096・swish-12・「ドン」）で終わる |
| charge_fire.mp3 | 火の溜め（ループ） | 炎のうなり（581078）、火炎放射のシュー音（563138）、薪のはぜる音（249418）、合成した低いうなり。低い帯域が中心 |
| charge_thunder.mp3 | 雷の溜め（ループ） | 放電のジー音（531421）、はじける電気（187363・238597）、ヤコブのはしご（449013）、合成した 100 Hz のうなり。高い帯域が中心 |
| charge_water.mp3 | 水の溜め（ループ） | 水と風のオーラ（197266）にフェイザーをかけて渦を巻かせ、激流（193755）、泡（loop_bubbles_02）、低いうなりを重ねた。中域が中心 |
| charge_wind.mp3 | 風の溜め（ループ） | うなる風（638434）、強風（344887）、魔法めいた上昇する風（403003）、合成した突風を左右に揺らした音 |
| full_fire.mp3 ほか4本 | 溜めが大になった瞬間 | 合成した鈴の音と Magic Spell SFX の輝きに、その属性の一撃（火: leohpaz の火の爆発と「ドン」、雷: leohpaz の雷とはじける電気、水: leohpaz の水と水しぶき 469608、風: leohpaz の風と 60013）を重ねた |

溜めのループは `audio.js` の `LOOPS` で 0.25〜4.75 秒を使い、終わりの 0.4 秒を頭に重ねてつなぎ目を消しています。段ごとの音程は今までどおり `CHARGE_PITCH` で上げます。

## 素材とライセンス

公開リポジトリのゲームに入れてよい素材だけを使いました。

- 「40 CC0 water / splash / slime SFX」rubberduck 作、CC0。https://opengameart.org/content/40-cc0-water-splash-slime-sfx
- 「Swishes Sound Pack」artisticdude 作、CC0。https://opengameart.org/content/swishes-sound-pack
- 「Magic Spell SFX」JaggedStone 作、CC0。https://opengameart.org/content/magic-spell-sfx （magical_3.ogg）
- 「8 Magic Attacks」leohpaz 作、CC-BY 4.0。https://opengameart.org/content/8-magic-attacks （22_Water_02、25_Wind_01、18_Thunder_02、04_Fire_explosion_04_medium）。**クレジットが必要です**（下の「クレジット」）
- Freesound の CC0 の音。どれも各ページで CC0（https://creativecommons.org/publicdomain/zero/1.0/）であることを確かめ、ログインなしで取れる HQ プレビューを使いました。

| 番号 | 作者 | 題 | 使った所 |
|---|---|---|---|
| [442773](https://freesound.org/s/442773/) | qubodup | Big Water Splash | water1・2・3 |
| [316744](https://freesound.org/s/316744/) | Bird_man | Big Splash | water2・3 |
| [469608](https://freesound.org/s/469608/) | Sheyvan | Watersplash | water3、full_water |
| [193755](https://freesound.org/s/193755/) | Jaturo | swirling torrent | water3、charge_water |
| [426075](https://freesound.org/s/426075/) | chris_dagorne | Big waves breaking and splashing against groyne | water3 |
| [197266](https://freesound.org/s/197266/) | qubodup | Wind & Water Aura | charge_water |
| [60013](https://freesound.org/s/60013/) | qubodup | Whoosh | wind1、full_wind |
| [683101](https://freesound.org/s/683101/) | florianreichelt | quick woosh | wind2 |
| [683096](https://freesound.org/s/683096/) | florianreichelt | Woosh | wind3 |
| [344887](https://freesound.org/s/344887/) | lextrack | Strong wind | wind3、charge_wind |
| [638434](https://freesound.org/s/638434/) | The_Isot_is_Back | Cold Howling Wind/Breeze (Loopable) | wind3、charge_wind |
| [361487](https://freesound.org/s/361487/) | FunWithSound | Wind Whipping By | wind2・3 |
| [403003](https://freesound.org/s/403003/) | martian | magical rising wind or sea | charge_wind |
| [581078](https://freesound.org/s/581078/) | magnuswaker | Flame Loop | charge_fire |
| [563138](https://freesound.org/s/563138/) | Nox_Sound | Foley_Object_Flame_Thrower_Loop_Stereo | charge_fire |
| [249418](https://freesound.org/s/249418/) | midimagician | Fire Burning Loop | charge_fire |
| [531421](https://freesound.org/s/531421/) | Resaural | Electric Zap Loop | charge_thunder |
| [187363](https://freesound.org/s/187363/) | ihitokage | Electricity crackling | charge_thunder、full_thunder |
| [238597](https://freesound.org/s/238597/) | ihitokage | Light Electricity crackling | charge_thunder |
| [449013](https://freesound.org/s/449013/) | parabolix | jacobs ladder from side | charge_thunder |

合成した部分は、このリポジトリのコードで作った音なので、外部のライセンスはかかりません。

効果音ラボ、魔王魂、OtoLogic は使っていません。効果音ラボは加工した音も再配布を禁じていて、公開リポジトリに音のファイルを置くと再配布にあたるおそれがあるためです。魔王魂も、曲を単体で配ることを禁じています。OtoLogic は規約のページを開けず、条件を確かめられませんでした。

## クレジット

CC-BY 4.0 の素材を含むので、ゲームのクレジットや配布ページに次を書きます。

> 効果音の一部: "8 Magic Attacks" by leohpaz (https://opengameart.org/content/8-magic-attacks), CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/). 切り出して、ほかの音と重ねて使っています。

## 音量

`audio.js` の `LUFS` 表は、各ファイルを ffmpeg の ebur128 で測った値です。ファイルを作り直したら測り直してください。溜めのループは、使う範囲（0.25〜4.75 秒）だけを測っています。水と風の大（`BIG_LUFS`）は、0〜6 秒を 3 秒から消していった音で測っています。
