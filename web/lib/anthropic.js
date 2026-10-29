// Calls the real Anthropic Messages API when ANTHROPIC_API_KEY is set.
// Returns null on any failure so the caller can fall back to the deterministic
// analyzer — the site must work end-to-end even with no key configured.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2000;

const SYSTEM_PROMPT = `You are Pronto, an end-of-day cognitive shutdown assistant for developers who use AI coding agents.
You write a single TOMORROW.md file: a calm, honest handoff the developer reads first thing tomorrow so they can close the laptop tonight with nothing held in their head.
Rules:
- Output ONLY the raw markdown for TOMORROW.md. No preamble, no code fences around the whole thing.
- Start with "# TOMORROW.md".
- Base every claim strictly on the provided context. Never invent commits, PRs, or files.
- Sections, in order: "Where you left off", "First move tomorrow" (one concrete action), "Open loops", "Files in flight", "Reload this context".
- Be concise and warm. The goal is to give the reader their evening back, not more work.`;

export function hasAnthropicKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function generateTomorrowMd(context, label) {
  if (!hasAnthropicKey()) return null;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Write TOMORROW.md for this end-of-day shutdown.\nSource: ${label}\n\nContext:\n${context}`,
          },
        ],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}
