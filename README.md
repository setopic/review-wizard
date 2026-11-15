# review-wizard

複数の質問をブラウザのウィザード UI（選択肢・複数選択・自由記述・進捗表示）で
まとめて提示し、回答結果を機械可読 JSON で取得するツール。AskUserQuestion の
ブラウザ版として、Claude Code から使うことを主眼に置いた単体プラグイン。

一時的にローカル HTTP サーバ（既定は 127.0.0.1、URL にワンタイムトークン）を起動して
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
| `--host <address>` | 127.0.0.1 | 待ち受けるアドレス。同じ LAN の別の端末（スマートフォンなど）から回答するときは `0.0.0.0` にする（後述） |
| `--no-rich` | オフ | 既定で描画される `question.detail`（信頼 HTML）を取り除き、プレーン表示にする |

（`--rich` は旧仕様との後方互換のために引き続き受け付けるが、既定と同じ挙動になる no-op。エラーにはならない。）

### 終了コード

| コード | 意味 |
|---|---|
| 0 | 回答受領 |
| 1 | 入力エラー（質問 JSON 不正など） |
| 2 | タイムアウトまたはサーバ起動失敗 |
| 130 | SIGINT による中断 |

### 同じ LAN の別の端末から回答する（`--host`）

既定では、この PC のブラウザからしか開けない（127.0.0.1 だけで待ち受ける）。
スマートフォンなど、同じ LAN の別の端末から回答したいときは `--host 0.0.0.0` を付ける。

```bash
node scripts/review_wizard.ts --questions questions.json --out answers.json --timeout 1800 --host 0.0.0.0
```

標準出力に、この PC で開く URL と、LAN の端末で開く URL が出る。トークンはどちらも同じ。

```text
review_wizard: http://127.0.0.1:54085/t/<token>/
review_wizard(LAN): http://192.168.1.23:54085/t/<token>/
```

- `review_wizard: ` の行は今までどおり必ず1行だけで、この PC のブラウザで自動的に開く。
- `review_wizard(LAN): ` の行が LAN の端末用。LAN のアドレスが複数あると複数行出る。
  端末と同じネットワーク（たいてい `192.168.` や `10.` で始まるもの）の URL を使う。
- 特定のアドレスだけで待ち受けたいときは `--host 192.168.1.23` のように書く。このときは
  そのアドレスの URL が `review_wizard: ` の行に出て、そのまま自動で開く。

#### LAN に開くときの守り

同じネットワークの誰でもサーバに届くようになるので、次の守りを置いている。

- URL のワンタイムトークン（128 ビットの乱数）が合わないと、ページも回答の送信も 404 になる。
- 回答の受け付けは1回だけ。受け付けたあとの送信は 409 で断り、そのままサーバを閉じる。
- 回答の本文は 1 MiB まで（超えると 413）。
- 応答に `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を付け、トークン入りの
  ページを端末に残さず、`detail` のリンクから外へトークンを渡さない。
- `--timeout`（既定 600 秒）で、無回答のまま開きっぱなしにならない。`--timeout 0` で
  LAN に開くと、標準エラーに注意が出る。

通信は HTTP で暗号化されない。カフェなどの共用の Wi-Fi では使わず、自宅など信頼できる
LAN だけで使う。URL は回答する人にだけ伝える。

#### Windows のファイアウォール

LAN の端末から開けない（読み込みが終わらない）ときは、Windows Defender ファイアウォールが
受信を止めていることが多い。

- 初めて `--host 0.0.0.0` で起動したときに「Windows セキュリティの重要な警告」が出たら、
  使っているネットワークの種類（自宅なら「プライベート ネットワーク」）にチェックを入れて
  「アクセスを許可する」を押す。
- 警告を閉じてしまったとき、または許可したのに開けないときは、次を確かめる。
  1. 「設定」→「ネットワークとインターネット」で、今のネットワークが「プライベート」か
     「パブリック」かを見る。自宅の LAN なら「プライベート」にするのがよい。
  2. 「Windows セキュリティ」→「ファイアウォールとネットワーク保護」→「ファイアウォールによる
     アプリケーションの許可」→「設定の変更」で、「Node.js JavaScript Runtime」の、1 で見た
     種類の列にチェックが入っているかを見る。無ければ入れる（一覧に無ければ「別のアプリの
     許可」から `node.exe` を足す）。
- ポートを決めて許したいときは、`--port 8765` のように固定し、管理者の PowerShell で
  そのポートだけを許す規則を足す。

  ```powershell
  New-NetFirewallRule -DisplayName "review-wizard (LAN)" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow -Profile Private
  ```

  使い終わったら `Remove-NetFirewallRule -DisplayName "review-wizard (LAN)"` で消す。
- macOS では、初回に「受信接続を許可しますか？」と出たら「許可」を押す。

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
      ],
      "detail": "リッチ説明の HTML（省略可、既定で描画。--no-rich で無効化）"
    }
  ]
}
```

- `questions` は 1 件以上、各質問の `options` は 2 件以上必須。
- `multiSelect: true` で複数選択可、既定は単一選択（1 つまで）。
- 各質問には「その他」自由記述欄が自動で付く（options に含める必要はない）。
- `detail`（省略可）は **既定で** 質問文の下に **信頼 HTML** として描画される。
  表（`<table>`）・図（インライン `<svg>`）・画像（`data:` URI）を埋め込める。外部 URL は使わず
  自己完結させる（オフライン維持）。`--no-rich` を付けると描画されずプレーン表示になる。
  detail は信頼できる作者が書く前提の HTML をそのまま `innerHTML` するため、未検証の外部文字列
  を入れないこと。既定で描画される仕様のため、この前提はより重要になる。

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
との互換性契約であり、既存フィールドの意味や回答形式は今後の修正でも変更しない
（`detail` のような**任意フィールドの追加**は後方互換のため、この限りではない）。

## Claude Code からの使い方

`skills/review-wizard/SKILL.md` を参照。3 問以上の質問や、比較検討が要る選択肢を
まとめて尋ねたい場面で、AskUserQuestion の代わりに使う。1〜2 問の即答で済む確認は
ターミナル内（AskUserQuestion）のままでよい。

## 開発

```bash
npm test
```

`node --test "tests/**/*.test.ts"` を実行する。入力検証・サーバフロー
（GET/トークン不一致 404/不正回答 400/正常回答 200 と回答 JSON 内容、回答の受け付けが1回だけ、
本文の上限、守りのヘッダ）・タイムアウト・`--host` と LAN の URL の組み立てを
子プロセス＋HTTP 経由で検証する。

## ライセンス・作者

`.claude-plugin/plugin.json` を参照。
