# Pronto 🌙

**One command that saves your open work, writes tomorrow's list, and pauses your coding agents until morning.**

Pronto is an end-of-day *cognitive shutdown* command for developers. You run it once when you stop for the day. It captures where you left off, generates a `TOMORROW.md` handoff you'll read in the morning, and locks your AI coding agents (like Claude Code) until 9:00 AM — so your brain, and your evening, can actually close the tab.

> 🔴 **Live web app:** https://pronto.atlanticlow.com (mirror: https://pronto.yashdub3.workers.dev). Paste a git diff or a public `owner/repo` and watch the real pipeline run. No login.
> 💻 **CLI, one command, nothing to install:** run `npx github:Sneh960/pronto` inside any git repo.

---

## 1. What Pronto Is & Who It's For

**Who it's for:** developers who work with AI coding agents (Claude Code, Cursor, Copilot agents) and end the day with ten half-finished threads still spinning in their head.

**The problem — compression burnout.** AI agents compress a week of work into an afternoon. That feels great until you realize the *thinking* never compressed with it. You still hold every open loop — the half-written migration, the PR waiting on a decision, the TODO you left mid-function — in your own head, because the agent's context resets but yours doesn't. So you keep working. You "just check one more thing." The agent is always ready, so you never stop. The compression didn't give you time back; it stole your evenings. That accumulated, unrelievable mental load is **compression burnout**.

**Pronto is "a shutdown command."** Operating systems have a shutdown command — a single, deliberate action that saves state and powers down cleanly. Developers never got one. Pronto is that command for your workday:

1. **Saves your open work** — reads your real git diffs and recent commits, then backs them up without touching your working tree: a `git stash` checkpoint plus `.pronto/wip-backup.patch` (`src/git-saver.mjs`).
2. **Writes tomorrow's list** — generates a `TOMORROW.md` cognitive handoff so you can *offload* every open loop instead of carrying it (`src/handoff.mjs`).
3. **Pauses your agents until morning** — installs a real Claude Code hook that blocks agent tool calls until your chosen wake time (`src/agent-pause.mjs` + `hooks/claude-guard.mjs`).

You close the laptop knowing nothing is lost and nothing will nag you. That's the whole product.

---

## 2. The One Rule: How Pronto Gives Time Back

> **Pronto exists to give you time back — never to help you do more work.**

Most "productivity" tools fail the person they claim to help: they add notifications, streaks, dashboards, and a backlog that guilt-trips you at 11pm. Pronto is built on the opposite rule, and it holds the line deliberately:

- **ZERO notifications.** Pronto never pings you. The guard is silent until *you* try to start an agent during your off-hours — and even then it only tells you it's resting.
- **ZERO interactive prompts.** No "are you sure?", no daily check-in, no forms. One command in, a clean shutdown out.
- **ZERO "do more" metrics.** No productivity score, no commit streak, no leaderboard. Nothing that turns rest into another number to optimize.

The only thing Pronto measures is whether your open loops are *closed* — written down in `TOMORROW.md` and out of your head — and whether your agents are *locked* so there's nothing left to tinker with. The time it saves doesn't get reinvested into more work. **It goes back to you.**

---

## 3. 30-Second Quickstart (Get Started Tonight)

### Option A — the CLI (shut down from your terminal)

Zero install. Run it inside any git repo:

```bash
npx github:Sneh960/pronto            # save work, write TOMORROW.md, lock agents until 09:00
npx github:Sneh960/pronto resume     # morning: unlock agents, show your first 10 minutes
```

Or from a clone:

```bash
# 1. Clone and enter
git clone https://github.com/Sneh960/pronto.git
cd pronto

# 2. Prove nothing is mocked — run the end-to-end tests
npm test

# 3. End your day: save work, write TOMORROW.md, lock agents until 9am
node bin/pronto.mjs off --until 09:00

# 4. Check what's locked (silent, no prompts)
node bin/pronto.mjs status

# 5. Changed your mind? Wake your agents early
node bin/pronto.mjs resume
```

That's it. After `off`, a `TOMORROW.md` sits in your repo and your Claude Code agents are paused until 9:00 AM.

### Option B — the live web app (try it with zero install)

Open **https://pronto.atlanticlow.com**, then either:

- paste any public repo (e.g. `vercel/next.js`) and click **Run my shutdown**, or
- hit **⚡ 1-Click Live Test with a Real Repo** to watch the full real pipeline — GitHub fetch → analysis → generated `TOMORROW.md` + Claude Code hook config + CLI one-liner — execute in one click.

No login, no OAuth, nothing to sign up for.

---

## 4. How It Works End-to-End (Nothing Mocked)

Everything is real: real git data, the real public GitHub REST API, a real Anthropic API call (with a real deterministic analyzer fallback when no key is set), and a real Claude Code hook that actually blocks agents. Here's exactly where to look in this repo:

| File | What it really does |
| --- | --- |
| `bin/pronto.mjs` | The CLI entrypoint. Zero-build Node.js ESM — runs directly with `node bin/pronto.mjs`. Dispatches `off`, `status`, `resume`. |
| `src/git-saver.mjs` | Saves your open work by reading real `git` diffs, staged/unstaged changes, recent commits, and branch state. |
| `src/handoff.mjs` | Generates the `TOMORROW.md` cognitive handoff. Calls the Anthropic API (`claude-sonnet-5-5`) when `ANTHROPIC_API_KEY` is set, and falls back to a real deterministic diff-analyzer otherwise. Redacts secrets before sending or writing. |
| `src/agent-pause.mjs` | Writes the lock (`.pronto/lock.json` in your repo) and installs the hook into `.claude/settings.json` so Claude Code agents are paused until your wake time. |
| `hooks/claude-guard.mjs` | The guard the hook runs. On every Claude Code `PreToolUse` it checks the lock and exits non-zero (blocking the tool call) while you're in off-hours. Fails open if there's no lock. |
| `src/storage.mjs` | Archives every shutdown (note, patch, state) to `.pronto/history/<date>/` and prunes entries older than 14 days. |
| `src/display.mjs` | Renders `TOMORROW.md` in the terminal for `pronto status` and `pronto resume`. |
| `tests/*.test.mjs` | Automated end-to-end tests that drive the real commands and assert on real outputs — proof nothing is faked or mocked. |
| `web/` | The live Next.js web app. `web/app/api/shutdown/route.js` is the real API route that fetches live GitHub data, calls Anthropic (with the deterministic fallback), and returns the downloadable `TOMORROW.md`, the `.claude/settings.json` hook config, the guard script, the lock file, and the CLI one-liner. |

### The shutdown flow, step by step

```
node bin/pronto.mjs off --until 09:00
        │
        ├─ src/git-saver.mjs   → reads real diffs + commits, backs them up (stash + patch)
        ├─ src/handoff.mjs     → writes TOMORROW.md (Anthropic or deterministic analyzer)
        ├─ src/agent-pause.mjs → writes .pronto/lock.json + wires .claude/settings.json
        └─ src/storage.mjs     → archives tonight to .pronto/history/
                                      │
                                      ▼
   Next time an agent runs → hooks/claude-guard.mjs blocks it until 09:00 🌙
```

### Web app: run it locally

```bash
cd web
npm install
npm run dev       # http://localhost:3000
npm run deploy    # build + deploy to Cloudflare Workers (OpenNext adapter, see web/wrangler.jsonc)
```

Optional secrets: `npx wrangler secret put ANTHROPIC_API_KEY` (Claude-written handoffs) and `GITHUB_TOKEN` (GitHub rate limits are shared on Cloudflare's IPs, so set this for the repo input). Without them, the pasted-diff path still works fully with the deterministic analyzer.

---

## Configuration

| Env var | Where | Required? | Effect |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | CLI + web | No | Uses `claude-sonnet-5-5` to write `TOMORROW.md`. Without it, the deterministic analyzer runs. |
| `PRONTO_MODEL` | CLI + web | No | Overrides the model. |
| `GITHUB_TOKEN` | web | No | Raises the GitHub REST rate limit. Without it, unauthenticated access is used. |

---

## License

MIT — close the laptop.
