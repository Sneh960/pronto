"use client";

import { useState } from "react";

import { CopyButton, ResultBlock } from "./components";

const DEMO_REPO = "vercel/next.js";
// Real diff from Pronto's own history. Used only when GitHub's anonymous rate
// limit (shared across Cloudflare IPs) blocks the 1-click repo demo.
const SAMPLE_DIFF = `diff --git a/src/handoff.mjs b/src/handoff.mjs
--- a/src/handoff.mjs
+++ b/src/handoff.mjs
@@ -112,6 +112,8 @@ export function analyze(snapshot) {
   const todos = [];
   for (const [file, d] of diffs) {
     for (const a of d.added) {
+      // TODO: only count TODOs that sit in a comment, not in strings
       const m = a.text.match(TODO_RE);
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -8,7 +8,7 @@
     "start": "node bin/pronto.mjs",
-    "test": "node --test tests/"
+    "test": "node --test"
   },`;

export default function Home() {
  const [repo, setRepo] = useState("");
  const [diff, setDiff] = useState("");
  const [until, setUntil] = useState("09:00");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState(null);

  async function runShutdown(overrides) {
    const body = {
      repo: overrides?.repo ?? repo,
      diff: overrides?.diff ?? diff,
      until,
    };
    setLoading(true);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const res = await fetch("/api/shutdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong.");
        return res.status;
      }
      setResult(data);
      return res.status;
    } catch {
      setError("Network error — could not reach the shutdown API.");
    } finally {
      setLoading(false);
    }
  }

  async function runDemo() {
    setRepo(DEMO_REPO);
    setDiff("");
    const status = await runShutdown({ repo: DEMO_REPO, diff: "" });
    if (status === 429) {
      await runShutdown({ repo: "", diff: SAMPLE_DIFF });
      setNotice("GitHub's anonymous rate limit was hit, so this demo ran on a real diff from Pronto's own repo instead.");
    }
  }

  return (
    <main className="wrap">
      <div className="brand">
        <span className="dot" />
        Pronto
      </div>

      <h1>
        End your day with <span className="accent">one command.</span>
      </h1>
      <p className="lede">
        Pronto saves your open work, writes tomorrow&apos;s list, and pauses your
        coding agents until morning — so your evening belongs to you.
      </p>
      <p className="tagline">
        A cure for compression burnout for developers working with AI agents like
        Claude Code. No notifications. No new to-dos. Just a clean shutdown.
      </p>

      <div className="card">
        <label className="field-label" htmlFor="repo">
          Public GitHub repo{" "}
          <span className="hint">— owner/repo or full URL</span>
        </label>
        <input
          id="repo"
          type="text"
          placeholder="vercel/next.js"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />

        <div className="divider">or paste a real diff / log</div>

        <label className="field-label" htmlFor="diff">
          git diff or terminal log{" "}
          <span className="hint">— runs fully offline, nothing leaves your tab</span>
        </label>
        <textarea
          id="diff"
          placeholder={"diff --git a/src/app.js b/src/app.js\n@@ ...\n+ // TODO: handle the retry case before shipping"}
          value={diff}
          onChange={(e) => setDiff(e.target.value)}
          spellCheck={false}
        />

        <div className="row" style={{ marginTop: 18 }}>
          <div>
            <label className="field-label" htmlFor="until">
              Lock agents until
            </label>
            <input
              id="until"
              type="text"
              className="until"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              placeholder="09:00"
            />
          </div>
        </div>

        <div className="row" style={{ marginTop: 20 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => runShutdown()}
            disabled={loading || (!repo.trim() && !diff.trim())}
          >
            {loading ? <span className="spin" /> : null}
            {loading ? "Shutting down…" : "Run my shutdown"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={runDemo}
            disabled={loading}
          >
            ⚡ 1-Click Live Test with a Real Repo
          </button>
        </div>

        {error ? <div className="error">{error}</div> : null}
        {notice ? <div className="notice">{notice}</div> : null}
      </div>

      {result ? <Results result={result} /> : null}

      <footer>
        <span>Pronto — the developer shutdown command. Tonight is over.</span>
        <a href="https://github.com/Sneh960/pronto" target="_blank" rel="noreferrer">
          github.com/Sneh960/pronto
        </a>
      </footer>
    </main>
  );
}

function Results({ result }) {
  const isAi = result.generatedBy === "anthropic";
  const badge = (
    <span className={`badge ${isAi ? "badge-ai" : "badge-det"}`}>
      {isAi ? "✦ Claude Sonnet 4" : "✦ deterministic analyzer"}
    </span>
  );

  const sourceLabel =
    result.source?.type === "github"
      ? `${result.source.label} · ${result.source.commits} commits · ${result.source.openPrs} open PRs`
      : "pasted diff / log";

  return (
    <>
      <div className="meta-strip">
        <span>Source: <strong>{sourceLabel}</strong></span>
        <span>Locked until <strong>{result.until}</strong></span>
        <span>
          {result.anthropicKeyPresent
            ? "Anthropic key detected"
            : "No key — real offline analyzer"}
        </span>
      </div>

      <div className="results">
        <ResultBlock
          title="1 · TOMORROW.md"
          subtitle="Your cognitive handoff — read it first thing, then delete it."
          filename="TOMORROW.md"
          content={result.tomorrowMd}
          badge={badge}
        />
        <ResultBlock
          title="2 · .claude/settings.json"
          subtitle="Drop into your repo to pause Claude Code agents until morning."
          filename="settings.json"
          content={result.settingsJson}
        />
        <ResultBlock
          title="2b · hooks/claude-guard.mjs"
          subtitle="The guard the hook runs — blocks tool calls while the lock is active."
          filename="claude-guard.mjs"
          content={result.guardScript}
        />
        <ResultBlock
          title="2c · ~/.pronto/lock.json"
          subtitle="The lock file Pronto writes. Delete it (or run resume) to wake early."
          filename="lock.json"
          content={result.lockFile}
        />

        <section className="result-card">
          <div className="result-head">
            <div>
              <h3>3 · Run it locally</h3>
              <div className="sub">One line to shut down from your terminal.</div>
            </div>
            <div className="actions">
              <CopyButton text={result.cliCommand} />
            </div>
          </div>
          <pre style={{ background: "transparent", padding: 20 }}>
            <span className="cli-line">
              <span>
                <span className="prompt">$</span>
                {result.cliCommand}
              </span>
            </span>
          </pre>
        </section>
      </div>
    </>
  );
}
