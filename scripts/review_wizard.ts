#!/usr/bin/env node
/**
 * review_wizard.ts — 複数の質問をブラウザのウィザード UI でまとめて提示し、
 * 回答結果を機械可読 JSON で返す CLI（AskUserQuestion のブラウザ版）。
 *
 * 出自: 20260704_requirements_tool の SR-28/ADR-005 から切り出し（ADR-006）。
 *
 * 機能:
 * - 選択肢（ラベル＋説明）・単一選択/複数選択（multiSelect）・自由記述（「その他」）
 *   を持つ質問を、進捗表示つきウィザード形式で 1 回の起動でまとめて提示する。
 * - 回答前の見直し（戻る）と送信前の確認（全回答のサマリ）ができる。
 * - 回答は機械可読 JSON（--out 指定時はファイル、未指定時は標準出力）で返る。
 *
 * 実現方式: 一時ローカル HTTP サーバ（127.0.0.1、URL にワンタイムトークン）を
 * Node 標準の http のみで起動し、回答が送信された時点で回答 JSON を書き出して
 * サーバを閉じる。常駐はしない。外部 npm 依存は追加しない（node:http, node:crypto,
 * node:fs, node:util, node:child_process のみ）。
 *
 * 終了コード: 成功=0、タイムアウト=2、SIGINT による中断=130、
 * 入力検証エラー（質問 JSON 不正など）=1。
 *
 * 質問/回答 JSON の形式は互換性契約であり変更しない（詳細は README.md）。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// 型（Node 23.6+ の型剥がし前提。enum は使わず string リテラル/union で表す）
// ---------------------------------------------------------------------------

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: QuestionOption[];
}

interface QuestionsDoc {
  title: string;
  questions: Question[];
}

interface AnswerOut {
  question: string;
  header: string;
  selected: string[];
  other: string | null;
}

interface AnswersDoc {
  title: string;
  answeredAt: string;
  answers: AnswerOut[];
}

interface CliOptions {
  outPath?: string;
  timeoutSec: number;
  noOpen: boolean;
  port: number;
}

// ---------------------------------------------------------------------------
// esc() — req_status.ts / req_view.ts の esc() と同値（HTML エスケープ）。
// サーバ側で HTML に直接埋め込むテキスト（<title> 等）に用いる。
// ---------------------------------------------------------------------------
function esc(s: unknown): string {
  if (s === null || s === undefined) return "";
  const text = String(s);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 質問定義 JSON の検証
// ---------------------------------------------------------------------------
function validateQuestionsDoc(raw: unknown): QuestionsDoc {
  if (!isRecord(raw)) {
    throw new Error("review_wizard: 質問定義 JSON はオブジェクトである必要があります。");
  }

  const titleRaw = raw["title"];
  const title = typeof titleRaw === "string" && titleRaw.trim() !== "" ? titleRaw : "レビュー";

  const questionsRaw = raw["questions"];
  if (!Array.isArray(questionsRaw) || questionsRaw.length === 0) {
    throw new Error("review_wizard: questions は1件以上の配列である必要があります。");
  }

  const questions: Question[] = questionsRaw.map((qRaw, i) => {
    if (!isRecord(qRaw)) {
      throw new Error(`review_wizard: questions[${i}] はオブジェクトである必要があります。`);
    }
    const questionText = qRaw["question"];
    if (typeof questionText !== "string" || questionText.trim() === "") {
      throw new Error(`review_wizard: questions[${i}].question は必須の文字列です。`);
    }
    const headerRaw = qRaw["header"];
    const header = typeof headerRaw === "string" && headerRaw !== "" ? headerRaw : undefined;
    const multiSelect = qRaw["multiSelect"] === true;

    const optionsRaw = qRaw["options"];
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2) {
      throw new Error(`review_wizard: questions[${i}].options は2件以上の配列である必要があります。`);
    }
    const options: QuestionOption[] = optionsRaw.map((oRaw, j) => {
      if (!isRecord(oRaw)) {
        throw new Error(`review_wizard: questions[${i}].options[${j}] はオブジェクトである必要があります。`);
      }
      const label = oRaw["label"];
      if (typeof label !== "string" || label.trim() === "") {
        throw new Error(`review_wizard: questions[${i}].options[${j}].label は必須の文字列です。`);
      }
      const descRaw = oRaw["description"];
      const description = typeof descRaw === "string" && descRaw !== "" ? descRaw : undefined;
      return description !== undefined ? { label, description } : { label };
    });

    const q: Question = { question: questionText, options };
    if (header !== undefined) q.header = header;
    if (multiSelect) q.multiSelect = true;
    return q;
  });

  return { title, questions };
}

/**
 * POST /answers のボディを検証する（SR-28 の「全質問に回答があること・options の
 * ラベルまたは『その他』テキスト・multiSelect=false なら1つまで」）。
 * 異常時は Error を投げ、呼び出し側が 400 応答としてサーバは継続する。
 */
function validateAnswersPayload(
  raw: unknown,
  doc: QuestionsDoc,
): Array<{ selected: string[]; other: string | null }> {
  if (!isRecord(raw)) {
    throw new Error("回答データはオブジェクトである必要があります。");
  }
  const answersRaw = raw["answers"];
  if (!Array.isArray(answersRaw) || answersRaw.length !== doc.questions.length) {
    throw new Error(`回答は全 ${doc.questions.length} 問分の配列である必要があります。`);
  }

  return answersRaw.map((aRaw, i) => {
    const q = doc.questions[i];
    if (!isRecord(aRaw)) {
      throw new Error(`answers[${i}] はオブジェクトである必要があります。`);
    }
    const selectedRaw = aRaw["selected"];
    let selected: string[];
    if (selectedRaw === undefined) {
      selected = [];
    } else if (Array.isArray(selectedRaw) && selectedRaw.every((v) => typeof v === "string")) {
      selected = selectedRaw as string[];
    } else {
      throw new Error(`answers[${i}].selected は文字列の配列である必要があります。`);
    }

    const validLabels = new Set(q.options.map((o) => o.label));
    for (const label of selected) {
      if (!validLabels.has(label)) {
        throw new Error(
          `answers[${i}] の選択肢「${label}」は質問「${q.question}」の options に存在しません。`,
        );
      }
    }
    if (!q.multiSelect && selected.length > 1) {
      throw new Error(`answers[${i}] は単一選択の質問です。選択は1つまでにしてください。`);
    }

    const otherRaw = aRaw["other"];
    const other = typeof otherRaw === "string" && otherRaw.trim() !== "" ? otherRaw : null;

    if (selected.length === 0 && other === null) {
      throw new Error(`answers[${i}]（質問「${q.question}」）が未回答です。選択肢またはその他の記入が必要です。`);
    }
    return { selected, other };
  });
}

// ---------------------------------------------------------------------------
// ウィザード HTML（CSS/JS 全インライン。外部リソース参照なし）
// ---------------------------------------------------------------------------

const WIZARD_CSS = `
body { font-family: "Hiragino Sans", "Yu Gothic", sans-serif; line-height: 1.7; max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem; color: #222; background: #fafafa; }
h1 { font-size: 1.25rem; margin-bottom: .3rem; }
.rv-progress { margin: 1rem 0 1.6rem; }
.rv-progress-track { background: #eee; border-radius: 999px; height: .5rem; overflow: hidden; }
.rv-progress-fill { height: 100%; background: #534AB7; width: 0%; transition: width .2s ease; }
.rv-progress-label { font-size: .82rem; color: #666; margin-top: .3rem; }
.rv-card { background: #fff; border: 1px solid #ddd; border-radius: 10px; padding: 1.4rem 1.5rem; margin-bottom: 1.2rem; }
.rv-header-chip { display: inline-block; background: #EEEDFE; color: #534AB7; font-size: .8rem; font-weight: bold; padding: .2rem .7rem; border-radius: 999px; margin-bottom: .6rem; }
.rv-question { font-size: 1.05rem; font-weight: bold; margin: 0 0 1rem; white-space: pre-wrap; }
.rv-option { display: block; border: 1px solid #ddd; border-radius: 8px; padding: .7rem .9rem; margin-bottom: .6rem; cursor: pointer; }
.rv-option:hover { border-color: #b9b3e6; background: #fbfaff; }
.rv-option.selected { border-color: #534AB7; background: #F7F6FD; }
.rv-option input { margin-right: .5rem; }
.rv-option-label { font-weight: bold; }
.rv-option-desc { color: #666; font-size: .85rem; margin-top: .2rem; margin-left: 1.4rem; }
.rv-other { margin-top: .6rem; }
.rv-other label { display: block; font-size: .85rem; color: #666; margin-bottom: .3rem; }
.rv-other input { width: 100%; box-sizing: border-box; padding: .5rem .6rem; border: 1px solid #ccc; border-radius: 6px; font: inherit; }
.rv-nav { display: flex; justify-content: space-between; gap: .6rem; }
.rv-nav button { font: inherit; padding: .55rem 1.2rem; border-radius: 6px; border: 1px solid #534AB7; background: #534AB7; color: #fff; cursor: pointer; }
.rv-nav button.secondary { background: #fff; color: #534AB7; }
.rv-nav button:disabled { opacity: .4; cursor: not-allowed; }
.rv-summary-row { border-bottom: 1px solid #eee; padding: .6rem 0; }
.rv-summary-q { font-weight: bold; }
.rv-summary-a { color: #333; margin: .2rem 0; }
.rv-summary-edit { font-size: .82rem; color: #534AB7; cursor: pointer; text-decoration: underline; background: none; border: none; font: inherit; padding: 0; }
.rv-error { color: #993C1D; background: #FBEDEA; border: 1px solid #f0c9c0; border-radius: 6px; padding: .6rem .8rem; margin-bottom: 1rem; font-size: .88rem; }
`;

// クライアント JS（外部依存なし。テンプレートリテラルの入れ子を避けるため文字列連結のみで書く。
// req_status.ts の EXPLORER_SCRIPT と同じ流儀）。
const CLIENT_SCRIPT = String.raw`(function () {
  var dataEl = document.getElementById("review-data");
  if (!dataEl) return;
  var data = JSON.parse(dataEl.textContent);
  var questions = data.questions, postUrl = data.postUrl, title = data.title;

  var state = questions.map(function () { return { selected: [], other: "" }; });
  var step = 0; // 0..questions.length-1 = 各質問、questions.length = 確認画面
  var totalSteps = questions.length + 1;

  var titleEl = document.getElementById("rv-title");
  var fillEl = document.getElementById("rv-progress-fill");
  var labelEl = document.getElementById("rv-progress-label");
  var cardEl = document.getElementById("rv-card");
  var backBtn = document.getElementById("rv-back");
  var nextBtn = document.getElementById("rv-next");

  titleEl.textContent = title;

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function answered(i) {
    var s = state[i];
    return s.selected.length > 0 || s.other.trim() !== "";
  }

  function renderProgress() {
    var shownStep = Math.min(step, questions.length) + 1;
    var pct = Math.round((shownStep / totalSteps) * 100);
    fillEl.style.width = pct + "%";
    labelEl.textContent = step < questions.length
      ? "質問 " + (step + 1) + " / " + questions.length
      : "確認（全 " + questions.length + " 問）";
  }

  function renderQuestion() {
    var q = questions[step];
    var s = state[step];
    var html = "";
    if (q.header) html += '<div class="rv-header-chip">' + esc(q.header) + "</div>";
    html += '<div class="rv-question">' + esc(q.question) + "</div>";
    var inputType = q.multiSelect ? "checkbox" : "radio";
    q.options.forEach(function (opt, i) {
      var checked = s.selected.indexOf(opt.label) !== -1;
      html += '<label class="rv-option' + (checked ? " selected" : "") + '" data-idx="' + i + '">' +
        '<input type="' + inputType + '" name="q' + step + '"' + (checked ? " checked" : "") + " readonly>" +
        '<span class="rv-option-label">' + esc(opt.label) + "</span>";
      if (opt.description) html += '<div class="rv-option-desc">' + esc(opt.description) + "</div>";
      html += "</label>";
    });
    html += '<div class="rv-other"><label>その他（自由記述）</label>' +
      '<input type="text" id="rv-other-input" value="' + esc(s.other) + '"></div>';
    cardEl.innerHTML = html;

    Array.prototype.forEach.call(cardEl.querySelectorAll(".rv-option"), function (optLabelEl) {
      optLabelEl.addEventListener("click", function (ev) {
        ev.preventDefault();
        var idx = Number(optLabelEl.getAttribute("data-idx"));
        var opt = q.options[idx];
        if (q.multiSelect) {
          var pos = s.selected.indexOf(opt.label);
          if (pos === -1) s.selected.push(opt.label); else s.selected.splice(pos, 1);
        } else {
          s.selected = [opt.label];
        }
        renderQuestion();
        updateNav();
      });
    });
    var otherInput = document.getElementById("rv-other-input");
    otherInput.addEventListener("input", function () {
      s.other = otherInput.value;
      updateNav();
    });
  }

  function renderSummary() {
    var html = "";
    questions.forEach(function (q, i) {
      var s = state[i];
      var parts = s.selected.slice();
      if (s.other.trim() !== "") parts.push("その他: " + s.other.trim());
      html += '<div class="rv-summary-row"><div class="rv-summary-q">' + esc(q.question) + "</div>" +
        '<div class="rv-summary-a">' + esc(parts.join(" / ") || "（未回答）") + "</div>" +
        '<button type="button" class="rv-summary-edit" data-i="' + i + '">修正</button></div>';
    });
    cardEl.innerHTML = html;
    Array.prototype.forEach.call(cardEl.querySelectorAll(".rv-summary-edit"), function (btn) {
      btn.addEventListener("click", function () {
        step = Number(btn.getAttribute("data-i"));
        render();
      });
    });
  }

  function updateNav() {
    backBtn.disabled = step === 0;
    if (step < questions.length) {
      nextBtn.textContent = step === questions.length - 1 ? "確認へ" : "次へ";
      nextBtn.disabled = !answered(step);
    } else {
      nextBtn.textContent = "回答を送信";
      nextBtn.disabled = false;
    }
  }

  function render() {
    renderProgress();
    if (step < questions.length) renderQuestion(); else renderSummary();
    updateNav();
  }

  function showError(msg) {
    var existing = document.getElementById("rv-error");
    if (existing) existing.parentNode.removeChild(existing);
    var div = document.createElement("div");
    div.id = "rv-error";
    div.className = "rv-error";
    div.textContent = msg;
    cardEl.parentNode.insertBefore(div, cardEl);
  }

  function submit() {
    var payload = { answers: state.map(function (s) {
      return { selected: s.selected, other: s.other.trim() === "" ? null : s.other.trim() };
    }) };
    nextBtn.disabled = true;
    fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      return res.text().then(function (text) { return { ok: res.ok, text: text }; });
    }).then(function (result) {
      if (result.ok) {
        var appEl = document.getElementById("app");
        while (appEl.firstChild) appEl.removeChild(appEl.firstChild);
        var h1 = document.createElement("h1");
        h1.textContent = "回答を送信しました";
        var p = document.createElement("p");
        p.textContent = "このタブは閉じて構いません。";
        appEl.appendChild(h1);
        appEl.appendChild(p);
      } else {
        nextBtn.disabled = false;
        var msg = "回答の送信に失敗しました。";
        try { msg = JSON.parse(result.text).error || msg; } catch (e) {}
        showError(msg);
      }
    }).catch(function (e) {
      nextBtn.disabled = false;
      showError("通信に失敗しました: " + e);
    });
  }

  backBtn.addEventListener("click", function () {
    if (step > 0) { step -= 1; render(); }
  });
  nextBtn.addEventListener("click", function () {
    if (step < questions.length) {
      if (!answered(step)) return;
      step += 1;
      render();
    } else {
      submit();
    }
  });

  render();
})();`;

/** 質問データを <script type="application/json"> に埋め込む安全な JSON 文字列化。
 * req_status.ts の explorerDataJson と同じ流儀（`<` を < にして </script> 混入を防ぐ）。
 */
function reviewDataJson(doc: QuestionsDoc, postUrl: string): string {
  const data = { title: doc.title, questions: doc.questions, postUrl };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function buildWizardHtml(doc: QuestionsDoc, answersPath: string): string {
  const dataJson = reviewDataJson(doc, answersPath);
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    `<title>${esc(doc.title)} — レビュー</title>`,
    `<style>${WIZARD_CSS}</style>`,
    "</head>",
    "<body>",
    '<div id="app">',
    '<h1 id="rv-title"></h1>',
    '<div class="rv-progress"><div class="rv-progress-track"><div class="rv-progress-fill" id="rv-progress-fill"></div></div>' +
      '<div class="rv-progress-label" id="rv-progress-label"></div></div>',
    '<div class="rv-card" id="rv-card"></div>',
    '<div class="rv-nav"><button type="button" id="rv-back" class="secondary">戻る</button>' +
      '<button type="button" id="rv-next">次へ</button></div>',
    "</div>",
    `<script type="application/json" id="review-data">${dataJson}</script>`,
    `<script>${CLIENT_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function completionHtml(): string {
  return [
    "<!doctype html>",
    '<html lang="ja"><head><meta charset="UTF-8"><title>送信完了 — レビュー</title>',
    "<style>body{font-family:\"Hiragino Sans\",\"Yu Gothic\",sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#222;text-align:center;}",
    ".card{border:1px solid #ded9f5;border-radius:10px;padding:2rem 1.5rem;background:#F7F6FD;}",
    "h1{font-size:1.1rem;color:#534AB7;}</style></head>",
    '<body><div class="card"><h1>回答を送信しました</h1><p>このタブは閉じて構いません。</p></div></body></html>',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// ブラウザ起動（失敗してもサーバは続行）
// ---------------------------------------------------------------------------
function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", (err) => {
      console.error(
        `review_wizard: ブラウザの自動起動に失敗しました。手動で開いてください: ${url}（${err.message}）`,
      );
    });
    child.unref();
  } catch (e) {
    console.error(
      `review_wizard: ブラウザの自動起動に失敗しました。手動で開いてください: ${url}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------
function writeOutput(doc: AnswersDoc, outPath: string | undefined): void {
  const json = JSON.stringify(doc, null, 2) + "\n";
  if (outPath) {
    const dir = path.dirname(outPath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, json, "utf-8");
  } else {
    process.stdout.write(json);
  }
}

// ---------------------------------------------------------------------------
// サーバ本体
// ---------------------------------------------------------------------------
function requestListener(
  doc: QuestionsDoc,
  token: string,
  opts: CliOptions,
  finish: (code: number) => void,
): http.RequestListener {
  const wizardPath = `/t/${token}/`;
  const wizardPathNoSlash = `/t/${token}`;
  const answersPath = `/t/${token}/answers`;

  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
      res.end("Bad Request");
      return;
    }

    if (req.method === "GET" && (pathname === wizardPath || pathname === wizardPathNoSlash)) {
      const html = buildWizardHtml(doc, answersPath);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
      res.end(html);
      return;
    }

    if (req.method === "POST" && pathname === answersPath) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let bodyRaw: unknown;
        try {
          const text = Buffer.concat(chunks).toString("utf-8");
          bodyRaw = text === "" ? {} : JSON.parse(text);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: `回答データの JSON 解析に失敗しました: ${e instanceof Error ? e.message : String(e)}` }));
          return;
        }

        let validated: Array<{ selected: string[]; other: string | null }>;
        try {
          validated = validateAnswersPayload(bodyRaw, doc);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          return;
        }

        const resultDoc: AnswersDoc = {
          title: doc.title,
          answeredAt: new Date().toISOString(),
          answers: doc.questions.map((q, i) => ({
            question: q.question,
            header: q.header ?? "",
            selected: validated[i].selected,
            other: validated[i].other,
          })),
        };

        try {
          writeOutput(resultDoc, opts.outPath);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
          res.end(JSON.stringify({ error: `回答の出力に失敗しました: ${e instanceof Error ? e.message : String(e)}` }));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
        res.end(completionHtml());
        finish(0);
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
    res.end("Not Found");
  };
}

function runWizardServer(doc: QuestionsDoc, opts: CliOptions): Promise<number> {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(16).toString("hex");
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const onSigint = (): void => {
      console.error("review_wizard: 中断されました（回答なしで終了します）。");
      finish(130);
    };

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      process.off("SIGINT", onSigint);
      server.closeAllConnections();
      server.close();
      resolve(code);
    };

    const server = http.createServer(requestListener(doc, token, opts, finish));

    server.on("error", (e) => {
      console.error(`review_wizard: サーバの起動に失敗しました: ${e.message}`);
      finish(2);
    });

    process.on("SIGINT", onSigint);

    server.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = addr && typeof addr === "object" ? addr.port : opts.port;
      const url = `http://127.0.0.1:${actualPort}/t/${token}/`;
      // テストがこの行から URL を取る。必ず1行だけ標準出力に印字する。
      console.log(`review_wizard: ${url}`);

      if (!opts.noOpen) tryOpenBrowser(url);

      if (opts.timeoutSec > 0) {
        timeoutHandle = setTimeout(() => {
          console.error("review_wizard: タイムアウトしました（無回答のため終了します）。");
          finish(2);
        }, opts.timeoutSec * 1000);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function readQuestionsInput(questionsArg: string): string {
  return questionsArg === "-" ? fs.readFileSync(0, "utf-8") : fs.readFileSync(questionsArg, "utf-8");
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      questions: { type: "string" },
      out: { type: "string" },
      timeout: { type: "string", default: "600" },
      "no-open": { type: "boolean", default: false },
      port: { type: "string", default: "0" },
    },
  });

  if (!values.questions) {
    console.error(
      "review_wizard: --questions は必須です（質問定義 JSON ファイルのパス、または '-' で標準入力から読みます）。",
    );
    return 1;
  }

  let raw: string;
  try {
    raw = readQuestionsInput(values.questions);
  } catch (e) {
    console.error(`review_wizard: 質問定義ファイルを読み込めません: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`review_wizard: 質問定義 JSON の解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  let doc: QuestionsDoc;
  try {
    doc = validateQuestionsDoc(parsed);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const timeoutSec = Number.parseInt(values.timeout ?? "600", 10);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) {
    console.error(`review_wizard: --timeout は 0 以上の整数で指定してください: ${values.timeout}`);
    return 1;
  }

  const port = Number.parseInt(values.port ?? "0", 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    console.error(`review_wizard: --port は 0〜65535 の整数で指定してください: ${values.port}`);
    return 1;
  }

  const opts: CliOptions = {
    outPath: values.out,
    timeoutSec,
    noOpen: Boolean(values["no-open"]),
    port,
  };

  return runWizardServer(doc, opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    });
}
