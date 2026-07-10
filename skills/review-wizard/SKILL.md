---
name: review-wizard
description: ユーザーへの質問が3問以上あるとき、選択肢の説明が長く比較検討が要るとき、まとめてレビュー/裁定を求めるときに、AskUserQuestion の代わりに使う。ブラウザのウィザードUIで進捗表示つきの複数質問（選択肢・複数選択・自由記述）を提示し、回答結果をJSONで受け取る。1〜2問の即答で済む確認はターミナル内のAskUserQuestionのままでよく、本ツールは使わない。
---

# review-wizard — ブラウザ・ウィザードでの複数質問

AskUserQuestion のブラウザ版。複数の質問（選択肢・複数選択・自由記述・進捗表示）を
1 回の起動でまとめて提示し、回答結果を機械可読 JSON で受け取る。

## 使い分け

- **本ツールを使う**: 質問が 3 問以上ある／選択肢の説明が長く比較検討が要る／設計や
  裁定をまとめてレビューしてもらう場面。
- **ターミナル内（AskUserQuestion）のままでよい**: 1〜2 問の即答で済む確認。

## 手順

### 1. 質問 JSON を一時ファイルに書く

スキーマ:

```json
{
  "title": "全体のタイトル（省略可、既定値「レビュー」）",
  "questions": [
    {
      "question": "質問文（必須）",
      "header": "見出しチップ（省略可）",
      "multiSelect": false,
      "options": [
        { "label": "選択肢A", "description": "補足説明（省略可）" },
        { "label": "選択肢B", "description": "補足説明（省略可）" }
      ]
    }
  ]
}
```

- `questions` は 1 件以上、各質問の `options` は 2 件以上必須。
- `multiSelect: true` で複数選択可、既定は単一選択。
- 各質問には「その他」自由記述欄が自動で付く（options に含める必要はない）。

### 2. バックグラウンドで実行する

回答が送信されるまでプロセスは終了しないため、バックグラウンドで実行し完了を待つ。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/review_wizard.ts" \
  --questions <in.json> --out <out.json> --timeout 1800
```

### 3. ブラウザが自動的に開く

標準出力に印字される `review_wizard: <URL>` の URL がブラウザで自動的に開かれる
（`--no-open` 指定時は開かず、URL を手動で開く運用に切り替わる）。

### 4. プロセス終了後に回答 JSON を読む

プロセスの終了コードで結果を判別する。

| 終了コード | 意味 |
|---|---|
| 0 | 回答受領（`--out` のパスに回答 JSON が書かれる） |
| 1 | 入力エラー（質問 JSON 不正など） |
| 2 | タイムアウト（`--timeout` 秒、無回答） |
| 130 | SIGINT による中断 |

回答 JSON のスキーマ:

```json
{
  "title": "質問JSONのtitle",
  "answeredAt": "ISO 8601 タイムスタンプ",
  "answers": [
    {
      "question": "質問文",
      "header": "見出し（未指定なら空文字）",
      "selected": ["選ばれたoptionsのlabel", "..."],
      "other": "自由記述テキスト、なければ null"
    }
  ]
}
```

`answers` は質問と同じ順序・同じ件数で並ぶ。
