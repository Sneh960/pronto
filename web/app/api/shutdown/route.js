import { buildArtifacts } from "@/lib/artifacts";
import {
  buildContext,
  parseDiff,
  tomorrowFromActivity,
  tomorrowFromDiff,
} from "@/lib/analyzer";
import { generateTomorrowMd, hasAnthropicKey } from "@/lib/anthropic";
import { fetchRepoActivity, parseRepo } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body must be valid JSON." }, 400);
  }

  const repoInput = (payload?.repo || "").trim();
  const diffInput = (payload?.diff || "").trim();
  const until = (payload?.until || "09:00").trim();

  if (!repoInput && !diffInput) {
    return json(
      { error: "Provide a GitHub repo (owner/repo) or paste a git diff / log." },
      400
    );
  }

  const artifacts = buildArtifacts(until);

  try {
    // Path A: a pasted diff / terminal log takes priority — it is the most direct signal.
    if (diffInput) {
      const parsed = parseDiff(diffInput);
      const context = buildContext(null, parsed, "pasted diff");
      const ai = await generateTomorrowMd(context, "pasted diff");
      const tomorrowMd = ai || tomorrowFromDiff(parsed, "pasted diff");

      return json({
        ...artifacts,
        tomorrowMd,
        source: { type: "diff", label: "pasted diff" },
        generatedBy: ai ? "anthropic" : "deterministic-analyzer",
        anthropicKeyPresent: hasAnthropicKey(),
      });
    }

    // Path B: fetch real activity from the public GitHub API.
    const parsedRepo = parseRepo(repoInput);
    if (!parsedRepo) {
      return json(
        { error: `Could not parse "${repoInput}". Use owner/repo or a GitHub URL.` },
        400
      );
    }

    const activity = await fetchRepoActivity(parsedRepo.owner, parsedRepo.repo);
    const context = buildContext(activity, null, activity.repo);
    const ai = await generateTomorrowMd(context, activity.repo);
    const tomorrowMd = ai || tomorrowFromActivity(activity);

    return json({
      ...artifacts,
      tomorrowMd,
      source: {
        type: "github",
        label: activity.repo,
        commits: activity.commits.length,
        openPrs: activity.openPrs.length,
      },
      generatedBy: ai ? "anthropic" : "deterministic-analyzer",
      anthropicKeyPresent: hasAnthropicKey(),
    });
  } catch (err) {
    const status = err?.status === 404 ? 404 : err?.status === 403 ? 429 : 502;
    const message =
      status === 404
        ? "Repository not found. Check owner/repo, or paste a diff instead."
        : status === 429
          ? "GitHub rate limit hit (unauthenticated). Try again shortly or paste a diff."
          : "Could not reach GitHub. Paste a diff to run fully offline.";
    return json({ error: message, detail: String(err?.message || err) }, status);
  }
}

export async function GET() {
  return json({
    ok: true,
    service: "pronto/api/shutdown",
    anthropicKeyPresent: hasAnthropicKey(),
    usage: "POST { repo?: 'owner/repo', diff?: string, until?: 'HH:MM' }",
  });
}
