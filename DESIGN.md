# たべよっか 設計

冷蔵庫・冷凍庫・ストック（米・乾物など）の中身を夫婦で共有して記録し、早く使うべきものを知らせ、家のレシピ帳から今の在庫で作れる料理を出すアプリ。

## 構成

carnet-de-mots と同じく、単一の `index.html`（PWA）と Supabase（Postgres・Auth・Storage・Realtime・Edge Functions）で作る。AI は Edge Function から Claude API を呼び、用途は「画像の読み取り」に限る。レシピを AI に生成させることはしない。

## 在庫

全ての食材を `zone` で大きく2つに分ける。

**冷蔵・冷凍（`fresh`）** は日々使っていくもの。登録日と「使い切り目安日」（`use_by`）から残り日数を出し、ホームの「早めに使う」に残り日数の少ない順に並べる。目安日数は食材マスタの `default_days` を初期値にし、ユーザーが変えられる。

**ストック（`pantry`）** は米・乾物・缶詰・乾麺など。急かす対象にはせず、専用タブで三色ごと・登録日の古い順に並べる。ホームの隅に「ストックから」として1品だけ出し、見返すきっかけにする。レシピとの照合では家にあるものとして扱う。

分類は三色食品群を主軸にする（赤：肉・魚・卵・乳・豆、黄：主食・いも・油脂、緑：野菜・果物・きのこ・海藻）。調味料などは `other`。細分類は `category` に自由に持つ。

食材は「使った」「捨てた」で在庫から外す（行は消さず `status` を変える）。捨てた記録は、あとで食品ロスを集計するのに使う。

## 入力

1. 手入力：食材マスタから候補を出し、色・分類・目安日数を自動で埋める。
2. 口頭：Web Speech API（ja-JP）で文字にし、AI で品目の JSON に整える。
3. レシート：写真を AI で読み取り、品目の JSON にする。食品以外（袋代・洗剤など）は除く。

2と3は必ず確認画面を通し、人が直してから保存する。

## 食材マスタ

`foods` に正式名と別名（`aliases`）を持ち、在庫もレシピの材料もここにひも付ける。「鶏むね肉」「とりむね」「若鶏むね」を同じ食材として扱うため。手入力で新しい名前を保存すると自動で追加され、使うほど育つ。

## レシピ

家のレシピ帳に登録したものだけを使う。登録方法は3つあり、どれも同じ確認画面を通って保存する。

1. 手入力。
2. URL 取り込み：ページ内の schema.org/Recipe（JSON-LD）を読む。AI は使わない。
3. 画像読み取り：雑誌などの写真（複数枚可）を AI で書き起こす。書いてあることだけを書き出し、読めない箇所は空欄にして印を付ける。元画像は Storage の `recipe-images` に保存してレシピにひも付ける。家庭内の個人利用に限る。

材料は食材マスタと照合し、マスタにない材料は確認画面で「新しい食材」か「既存食材の別名」を選ぶ。

### 提案

在庫とレシピ帳を照合して点数を付ける。調味料（`is_seasoning`）は照合から外す。

- 在庫にある材料ごとに加点し、その食材の残り日数が少ないほど大きく加点する。
- 足りない材料ごとに減点する。
- お気に入りは少し加点する。

レシピ帳に合うものがないときは、急ぎの食材名を入れたクラシル・クックパッドの検索リンクを出す。「作った」で `cook_log` に記録し、使った食材を在庫から外す。

## 共有

`households`（家庭）と `household_members`（メンバー）を持ち、全てのデータに `household_id` を付ける。RLS で同じ家庭のメンバーだけが読み書きできる。家庭の作成と参加は RPC（`create_household` / `join_household`）で行い、参加は招待コード方式。Realtime で相手の変更をすぐ画面に反映する。誰が入れたか・使ったかを記録する。

## データ

`supabase/migrations/` を参照。

- `households(id, name, invite_code)`
- `household_members(household_id, user_id, display_name)`
- `foods(id, household_id, name, aliases, color, category, zone, location, default_days)`
- `items(id, household_id, food_id, name, color, category, zone, location, quantity, unit, added_at, use_by, source, status, added_by, finished_at, finished_by)`
- `recipes(id, household_id, title, servings, minutes, steps, source_type, source_url, source_images, source_note, is_favorite)`
- `recipe_ingredients(id, recipe_id, food_id, name, amount, is_seasoning, position)`
- `cook_log(id, household_id, recipe_id, cooked_at, cooked_by)`

## 進め方

1. 在庫の手入力、冷蔵・冷凍の残り日数表示、ストックのタブ、夫婦での共有。
2. レシート読み取り（Edge Function `read-receipt`）← いまここ。続いて口頭入力。
3. レシピ帳（手入力・URL 取り込み・画像読み取り）と在庫との照合。
4. 通知（毎朝のメール）と、捨てた記録の集計。

## セットアップ

1. Supabase で新しいプロジェクトを作り、`supabase/migrations/` の SQL を順に実行する。
2. Authentication でメール・パスワードのログインを有効にし、2人分のユーザーを作る。
3. `index.html` の `SUPABASE_URL` と `SUPABASE_PUBLISHABLE_KEY` を書き換える。
4. 片方が「家庭を作る」を選び、表示された招待コードをもう片方が入力して参加する。
5. Edge Functions → Secrets に `ANTHROPIC_API_KEY` を登録し、`supabase/functions/read-receipt/index.ts` を `read-receipt` という名前で登録する（ダッシュボードのエディタに貼り付けて Deploy）。
