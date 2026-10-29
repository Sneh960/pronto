// Fetches real data from the public GitHub REST API. No mocks.
// Optional GITHUB_TOKEN raises the rate limit but is never required.

const API_ROOT = "https://api.github.com";
const MAX_COMMITS = 8;
const MAX_PRS = 8;
const MAX_PATCH_CHARS = 2000;

// Accepts "owner/repo", a full https URL, or a git@ URL and returns {owner, repo}.
export function parseRepo(input) {
  const raw = (input || "").trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/^git@github\.com:/i, "")
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

function headers() {
  const base = {
    Accept: "application/vnd.github+json",
    "User-Agent": "pronto-shutdown",
  };
  if (process.env.GITHUB_TOKEN) {
    base.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return base;
}

async function getJson(url) {
  const res = await fetch(url, { headers: headers(), cache: "no-store" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `GitHub ${res.status} for ${url}: ${body.slice(0, 160)}`
    );
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Pulls recent commits, open PRs, and the file list of the latest commit.
export async function fetchRepoActivity(owner, repo) {
  const base = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  const commits = await getJson(`${base}/commits?per_page=${MAX_COMMITS}`);

  // Open PRs and latest-commit detail are best-effort — a missing one must not
  // sink the whole request.
  const [pulls, latestDetail] = await Promise.all([
    getJson(`${base}/pulls?state=open&per_page=${MAX_PRS}`).catch(() => []),
    commits[0]?.sha
      ? getJson(`${base}/commits/${commits[0].sha}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    repo: `${owner}/${repo}`,
    commits: commits.map((c) => ({
      sha: (c.sha || "").slice(0, 7),
      message: (c.commit?.message || "").split("\n")[0],
      author: c.commit?.author?.name || c.author?.login || "unknown",
      date: c.commit?.author?.date || null,
    })),
    openPrs: (pulls || []).map((p) => ({
      number: p.number,
      title: p.title,
      author: p.user?.login || "unknown",
      draft: !!p.draft,
    })),
    latestCommit: latestDetail
      ? {
          sha: (latestDetail.sha || "").slice(0, 7),
          message: (latestDetail.commit?.message || "").split("\n")[0],
          files: (latestDetail.files || []).slice(0, 12).map((f) => ({
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            patch: (f.patch || "").slice(0, MAX_PATCH_CHARS),
          })),
        }
      : null,
  };
}
