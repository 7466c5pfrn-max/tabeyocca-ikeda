# たべよっか 設計

冷蔵庫・冷凍庫・ストック（米・乾物など）の中身を夫婦で共有して記録し、早く使うべきものを知らせ、家のレシピ帳から今の在庫で作れる料理を出すアプリ。

## 構成

carnet-de-mots と同じく、単一の `index.html`（PWA）と Supabase（Postgres・Auth・Storage・Realtime・Edge Functions）で作る。AI は Edge Function から Claude API を呼び、用途は「話した内容の整理」と「レシピ画像の書き起こし」に限る。レシピを AI に生成させることはしない。

## 在庫

全ての食材を `zone` で大きく2つに分ける。

**冷蔵・冷凍（`fresh`）** は日々使っていくもの。登録日と「使い切り目安日」（`use_by`）から残り日数を出し、ホームの「早めに使う」に残り日数の少ない順に並べる。目安日数は食材マスタの `default_days` を初期値にし、ユーザーが変えられる。

**ストック（`pantry`）** は米・乾物・缶詰・乾麺など。急かす対象にはせず、専用タブで三色ごと・登録日の古い順に並べる。ホームの隅に「ストックから」として1品だけ出し、見返すきっかけにする。レシピとの照合では家にあるものとして扱う。

分類は三色食品群を主軸にする（赤：肉・魚・卵・乳・豆、黄：主食・いも・油脂、緑：野菜・果物・きのこ・海藻）。調味料などは `other`。細分類は `category` に自由に持つ。

食材は「使った」「捨てた」で在庫から外す（行は消さず `status` を変える）。捨てた記録は、あとで食品ロスを集計するのに使う。

## 入力

主な入力は口頭。買ってきたものを冷蔵庫や棚にしまいながら「卵1パック、にんじん3本、豚こまは冷凍」のように話し、まとめて登録する。

1. 「＋」で「話して追加」を開き、マイクのボタンを押して話す。Web Speech API（ja-JP）で文字にし、止めるまで聞き続ける。音声認識が使えない環境では、キーボードの音声入力で同じ欄に入れる。文字は手で直せる。
2. 「整理する」で Edge Function `parse-voice` に送り、Claude が食品ごとに名前・量・置き場所・三色・分類・使い切り目安に整理する。置き場所や「あと3日」を話していればそれに従う。
3. 確認画面で直し、要らないものはチェックを外してまとめて登録する。聞き取りに自信のない品目は色を付けて示す。

1品ずつの手入力も残す（食材マスタから候補を出し、色・分類・目安日数を自動で埋める）。

レシートの写真読み取りも試したが、精度が足りなかったためやめた。

## 食材マスタ

`foods` に正式名と別名（`aliases`）を持ち、在庫もレシピの材料もここにひも付ける。「鶏むね肉」「とりむね」「若鶏むね」を同じ食材として扱うため。手入力で新しい名前を保存すると自動で追加され、使うほど育つ。

## レシピ

家のレシピ帳に登録したものだけを使う。登録方法は3つあり、どれも同じ確認画面を通って保存する。

1. 手入力。
2. URL 取り込み（Edge Function `import-recipe-url`）：ページ内の schema.org/Recipe（JSON-LD）を読む。AI は使わない。「鶏むね肉 300g」は名前と分量に分け、「(A)」「★」などの見出し記号は外す。調味料の印は名前から推定する。
3. 画像読み取り（Edge Function `read-recipe-image`）：雑誌などの写真（4枚まで）を AI で書き起こす。書いてあることだけを書き出し、読めない材料には印を付け、手順中の読めない箇所は「［読めない］」とする。元画像は Storage の `recipe-images/{household_id}/` に保存してレシピにひも付け、確認画面と詳細画面で見比べられる。家庭内の個人利用に限る。

材料は保存時に食材マスタと照合し、見つかれば `food_id` を付ける。照合は表記ゆれを吸収した形（括弧書き・記号を外し、カタカナをひらがなにそろえる）で、名前・別名の完全一致、次に「鶏むね肉（皮なし）」→「鶏むね肉」のような前方一致を見る。「人参」と「にんじん」のような漢字とかなの違いは、食材マスタの別名で吸収する。別名を画面から登録する機能はまだ無い。

### 提案

在庫とレシピ帳を照合して点数を付ける。調味料（`is_seasoning`）は照合から外す。

- 在庫にある材料ごとに加点し、その食材の残り日数が少ないほど大きく加点する（期限切れ・今日まで 5、あと2日以内 4、あと4日以内 3、それ以上 2、冷凍 1.5、ストック 1）。
- 足りない材料ごとに 1.5 減点する。
- お気に入りは 1 加点する。

在庫にある材料が1つ以上あるレシピを点数順に、ホームの「これを使うなら」に3件、レシピタブの「今の在庫で作れそう」に5件出す。足りない材料が無ければ「そろってる」と示す。急ぎの食材があれば、その名前を入れたクラシル・クックパッドの検索リンクを出す。

「作った」で `cook_log` に記録し、チェックした食材を在庫から外す（「使った」扱い）。初期状態では、材料ごとに一番急ぐ冷蔵・冷凍の食材だけにチェックを付ける。

## 共有

`households`（家庭）と `household_members`（メンバー）を持ち、全てのデータに `household_id` を付ける。RLS で同じ家庭のメンバーだけが読み書きできる。使うのは夫婦2人だけなので招待コードは使わない。初回ログイン時に RPC `enter_household` を呼ぶと、家庭がなければ作り、あればそこに入る（2人まで）。新規登録（サインアップ）はダッシュボードで無効にしておく。Realtime で相手の変更をすぐ画面に反映する。誰が入れたか・使ったかを記録する。

## データ

`supabase/migrations/` を参照。

- `households(id, name)`（`invite_code` 列は残っているが使わない）
- `household_members(household_id, user_id, display_name)`
- `foods(id, household_id, name, aliases, color, category, zone, location, default_days)`
- `items(id, household_id, food_id, name, color, category, zone, location, quantity, unit, added_at, use_by, source, status, added_by, finished_at, finished_by)`
- `recipes(id, household_id, title, servings, minutes, steps, source_type, source_url, source_images, source_note, is_favorite)`
- `recipe_ingredients(id, recipe_id, food_id, name, amount, is_seasoning, position)`
- `cook_log(id, household_id, recipe_id, cooked_at, cooked_by)`

## 進め方

1. 在庫の手入力、冷蔵・冷凍の残り日数表示、ストックのタブ、夫婦での共有。
2. 口頭でのまとめて入力（Edge Function `parse-voice`）。
3. レシピ帳（手入力・URL 取り込み・画像読み取り）と在庫との照合 ← いまここ。続いて、食材マスタの別名を画面から登録する機能。
4. 通知（毎朝のメール）と、捨てた記録の集計。

## セットアップ

1. Supabase で新しいプロジェクトを作り、`supabase/migrations/` の SQL を順に実行する。
2. Authentication でメール・パスワードのログインを有効にし、2人分のユーザーを作る。新規登録（Allow new users to sign up）は無効にする。
3. `index.html` の `SUPABASE_URL` と `SUPABASE_PUBLISHABLE_KEY` を書き換える。
4. Edge Functions → Secrets に `ANTHROPIC_API_KEY` を登録し、`supabase/functions/` の各関数（`parse-voice`・`import-recipe-url`・`read-recipe-image`）をフォルダと同じ名前で登録する（ダッシュボードのエディタに貼り付けて Deploy。名前は作成時にしか決められない）。
5. それぞれログインして表示名を入れると、同じ家庭に入る。
