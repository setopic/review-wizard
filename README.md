# review-wizard

複数の質問をブラウザのウィザード UI（選択肢・複数選択・自由記述・進捗表示）で
まとめて提示し、回答結果を機械可読 JSON で取得するツール。AskUserQuestion の
ブラウザ版として、Claude Code から使うことを主眼に置いた単体プラグイン。

一時的にローカル HTTP サーバ（127.0.0.1、URL にワンタイムトークン）を起動して
質問を提示し、回答が送信された時点でサーバを閉じる。常駐プロセスにはならない。
外部 npm 依存はなく、Node 標準機能（`node:http`, `node:crypto`, `node:fs`,
`node:util`, `node:child_process`）のみで動く。

このツールは `20260704_requirements_tool`（ライトウェイト要求工学ツール、
SR-28/ADR-005）から切り出したもの（ADR-006）。以後の修正はこのリポジトリを正とする。

## インストール

### マーケットプレイス経由

```bash
claude plugin marketplace add /path/to/review-wizard
claude plugin install review-wizard@review-wizard-marketplace
```

GitHub に置く場合は `marketplace add` にリポジトリ URL を渡せばよい。

```bash
claude plugin marketplace add https://github.com/uehaj/review-wizard.git
claude plugin install review-wizard@review-wizard-marketplace
```

### ローカル確認（開発・検証時）

```bash
claude --plugin-dir /path/to/review-wizard
```

マニフェストの妥当性は次で検証できる。

```bash
claude plugin validate . --strict
```

## CLI 単体での使い方

```bash
node scripts/review_wizard.ts \
  --questions questions.json \
  --out answers.json \
  --timeout 1800
```

### オプション

| オプション | 既定値 | 説明 |
|---|---|---|
| `--questions <path>` | （必須） | 質問定義 JSON のパス。`-` で標準入力から読む |
| `--out <path>` | 未指定時は標準出力 | 回答 JSON の書き出し先 |
| `--timeout <秒>` | 600 | 無回答のまま経過するとタイムアウト終了（0 で無効） |
| `--no-open` | オフ | ブラウザを自動で開かない |
| `--port <port>` | 0（空きポート自動割当） | 待受ポートを固定したいとき |

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 回答受領 |
| 1 | 入力エラー（質問 JSON 不正など） |
| 2 | タイムアウトまたはサーバ起動失敗 |
| 130 | SIGINT による中断 |

## 質問 JSON のスキーマ

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
- `multiSelect: true` で複数選択可、既定は単一選択（1 つまで）。
- 各質問には「その他」自由記述欄が自動で付く（options に含める必要はない）。

## 回答 JSON のスキーマ

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

`answers` は質問と同じ順序・同じ件数で並ぶ。この質問/回答 JSON の形式は外部利用者
との互換性契約であり、今後の修正でも変更しない。

## Claude Code からの使い方

`skills/review-wizard/SKILL.md` を参照。3 問以上の質問や、比較検討が要る選択肢を
まとめて尋ねたい場面で、AskUserQuestion の代わりに使う。1〜2 問の即答で済む確認は
ターミナル内（AskUserQuestion）のままでよい。

## 開発

```bash
npm test
```

`node --test "tests/**/*.test.ts"` を実行する。入力検証・サーバフロー
（GET/トークン不一致 404/不正回答 400/正常回答 200 と回答 JSON 内容）・タイムアウトを
子プロセス＋HTTP 経由で検証する。

## ライセンス・作者

`.claude-plugin/plugin.json` を参照。
