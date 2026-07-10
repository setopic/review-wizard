/**
 * review_wizard.ts のテスト（入力検証・サーバフロー・タイムアウト）。
 * fixture は tests/fixtures を汚さず、一時ディレクトリに書き出して使う。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REVIEW_SCRIPT = path.join(REPO_ROOT, "scripts", "review_wizard.ts");

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "review_wizard_test-"));
}

function writeQuestionsFixture(tmp: string, data: unknown): string {
  const p = path.join(tmp, "questions.json");
  fs.writeFileSync(p, JSON.stringify(data), "utf-8");
  return p;
}

const VALID_QUESTIONS = {
  title: "設計裁定テスト",
  questions: [
    {
      question: "この設計を採用しますか？",
      header: "設計裁定",
      multiSelect: false,
      options: [
        { label: "採用する", description: "この方式で進める" },
        { label: "採用しない", description: "別案を検討する" },
      ],
    },
    {
      question: "追加で確認したい点はありますか？",
      header: "確認事項",
      multiSelect: true,
      options: [
        { label: "特になし" },
        { label: "ドキュメントも欲しい" },
        { label: "テストも欲しい" },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. 入力検証
// ---------------------------------------------------------------------------

test("exits 1 with Japanese stderr when questions is empty", () => {
  const tmp = mkTmpDir();
  const qpath = writeQuestionsFixture(tmp, { title: "t", questions: [] });
  const out = path.join(tmp, "out.json");
  const proc = spawnSync(
    process.execPath,
    [REVIEW_SCRIPT, "--no-open", "--questions", qpath, "--out", out],
    { encoding: "utf-8" },
  );
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /questions/);
  assert.ok(/[぀-ヿ一-鿿]/.test(proc.stderr), "stderr should contain Japanese message");
});

test("exits 1 with Japanese stderr when a question has fewer than 2 options", () => {
  const tmp = mkTmpDir();
  const qpath = writeQuestionsFixture(tmp, {
    title: "t",
    questions: [{ question: "選べますか？", options: [{ label: "はい" }] }],
  });
  const out = path.join(tmp, "out.json");
  const proc = spawnSync(
    process.execPath,
    [REVIEW_SCRIPT, "--no-open", "--questions", qpath, "--out", out],
    { encoding: "utf-8" },
  );
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /options/);
});

test("exits 1 with Japanese stderr on malformed JSON", () => {
  const tmp = mkTmpDir();
  const qpath = path.join(tmp, "questions.json");
  fs.writeFileSync(qpath, "{ this is not json", "utf-8");
  const out = path.join(tmp, "out.json");
  const proc = spawnSync(
    process.execPath,
    [REVIEW_SCRIPT, "--no-open", "--questions", qpath, "--out", out],
    { encoding: "utf-8" },
  );
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /解析/);
});

// ---------------------------------------------------------------------------
// 2. サーバフロー
// ---------------------------------------------------------------------------

/** 子プロセスを起動し、標準出力の "review_wizard: <URL>" 行から URL を取り出す。 */
function startReview(args: string[]): Promise<{ proc: ReturnType<typeof spawn>; url: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [REVIEW_SCRIPT, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let resolved = false;
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const m = /review_wizard: (\S+)/.exec(buf);
      if (m && !resolved) {
        resolved = true;
        proc.stdout?.off("data", onData);
        resolve({ proc, url: m[1] });
      }
    };
    proc.stdout?.on("data", onData);
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (!resolved) reject(new Error(`process exited before printing URL (code=${code})`));
    });
  });
}

function waitForExit(proc: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });
}

test("server flow: GET serves the wizard, wrong token 404s, invalid POST 400s, valid POST 200s and exits 0", async () => {
  const tmp = mkTmpDir();
  const qpath = writeQuestionsFixture(tmp, VALID_QUESTIONS);
  const outPath = path.join(tmp, "answers.json");

  const { proc, url } = await startReview([
    "--no-open",
    "--questions",
    qpath,
    "--out",
    outPath,
    "--port",
    "0",
  ]);

  try {
    // (a) GET の質問文が含まれる
    const getRes = await fetch(url);
    assert.equal(getRes.status, 200);
    const html = await getRes.text();
    assert.ok(html.includes("この設計を採用しますか？"), "wizard HTML should include question 1 text");
    assert.ok(html.includes("追加で確認したい点はありますか？"), "wizard HTML should include question 2 text");

    // (b) 誤ったトークンパスは 404
    const wrongUrl = new URL(url);
    wrongUrl.pathname = "/t/not-the-real-token/";
    const wrongRes = await fetch(wrongUrl);
    assert.equal(wrongRes.status, 404);

    // (c) 不正な回答 POST（第2問が未回答）は 400
    const answersUrl = new URL(url);
    answersUrl.pathname = answersUrl.pathname.replace(/\/$/, "") + "/answers";
    const badRes = await fetch(answersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: [{ selected: ["採用する"], other: null }, { selected: [], other: null }],
      }),
    });
    assert.equal(badRes.status, 400);

    // (d) 正しい回答 POST は 200、プロセスは exit 0
    const goodRes = await fetch(answersUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers: [
          { selected: ["採用する"], other: null },
          { selected: ["ドキュメントも欲しい", "テストも欲しい"], other: "移行手順も見てほしい" },
        ],
      }),
    });
    assert.equal(goodRes.status, 200);

    const exitCode = await waitForExit(proc);
    assert.equal(exitCode, 0);

    const written = JSON.parse(fs.readFileSync(outPath, "utf-8"));
    assert.equal(written.title, "設計裁定テスト");
    assert.ok(typeof written.answeredAt === "string" && written.answeredAt.length > 0);
    assert.equal(written.answers.length, 2);
    assert.deepEqual(written.answers[0].selected, ["採用する"]);
    assert.equal(written.answers[0].other, null);
    assert.deepEqual(written.answers[1].selected, ["ドキュメントも欲しい", "テストも欲しい"]);
    assert.equal(written.answers[1].other, "移行手順も見てほしい");
    assert.equal(written.answers[0].question, "この設計を採用しますか？");
    assert.equal(written.answers[1].header, "確認事項");
  } finally {
    if (proc.exitCode === null && !proc.killed) proc.kill();
  }
});

// ---------------------------------------------------------------------------
// 3. タイムアウト
// ---------------------------------------------------------------------------

test("exits 2 on timeout when no answer is submitted", async () => {
  const tmp = mkTmpDir();
  const qpath = writeQuestionsFixture(tmp, VALID_QUESTIONS);
  const outPath = path.join(tmp, "answers.json");

  const { proc } = await startReview([
    "--no-open",
    "--questions",
    qpath,
    "--out",
    outPath,
    "--timeout",
    "1",
  ]);

  const exitCode = await waitForExit(proc);
  assert.equal(exitCode, 2);
  assert.ok(!fs.existsSync(outPath), "no answer file should be written on timeout");
});
