#!/usr/bin/env python3
"""
GeoVision Hunt — Submission Processor
Runs inside GitHub Actions. Reads issue data from env, updates data/scores.json.
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]
SCORES_FILE = ROOT / "data" / "scores.json"
CONFIG_FILE  = ROOT / "data" / "config.json"

# ── Phrase → artifact map ──────────────────────────────────────────────────
PHRASE = "Innovate with Passion, Engage with Purpose, and Win with Integrity"
ARTIFACTS = {}
idx = 1
for ch in PHRASE:
    if ch.isalpha():
        ARTIFACTS[idx] = ch.upper()
        idx += 1
TOTAL_ARTIFACTS = len(ARTIFACTS)  # 55

# ── Load config ────────────────────────────────────────────────────────────
with open(CONFIG_FILE) as f:
    cfg = json.load(f)

STANDARD_PTS   = cfg["points"]["standard"]
RARE_PTS       = cfg["points"]["rare"]
COMPLETION_BONUS = cfg["points"]["completion_bonus"]
RARE_IDS       = set(cfg.get("rare_artifacts", []))  # also set in Cloudflare KV art-cfg
SPEED_MULTS    = cfg["speed_multipliers"]


def get_speed_mult(rank: int) -> float:
    key = str(rank)
    return float(SPEED_MULTS.get(key, SPEED_MULTS["default"]))


def load_scores() -> dict:
    if SCORES_FILE.exists():
        with open(SCORES_FILE) as f:
            return json.load(f)
    return {"teams": [], "artifacts": {}, "submissions": [], "last_updated": None}


def save_scores(data: dict):
    data["last_updated"] = datetime.now(timezone.utc).isoformat()
    with open(SCORES_FILE, "w") as f:
        json.dump(data, f, indent=2)


TITLE_RE = re.compile(r'\[HUNT\]\s*#(\d+)\s+\w+\s*\|\s*(.+)')


def parse_issue(title: str, body: str) -> tuple[str, int] | None:
    """Parse '[HUNT] #23 E | Team Name' → (team_name, artifact_id)"""
    m = TITLE_RE.match(title.strip())
    if not m:
        return None
    artifact_id = int(m.group(1))
    team = m.group(2).strip()
    return team, artifact_id


def normalize_team(name: str) -> str:
    return name.strip().lower()


def find_team(teams: list, name: str) -> dict | None:
    norm = normalize_team(name)
    for t in teams:
        if normalize_team(t["name"]) == norm:
            return t
    return None


def recalculate_leaderboard(data: dict):
    """Sort teams by points descending (tiebreak: last_submission ascending)."""
    data["teams"].sort(
        key=lambda t: (-t["total_points"], t.get("last_submission", "9999"))
    )


def fetch_fresh_issue(number: str, token: str, repo_full: str) -> dict | None:
    """Re-fetch the issue directly from the API instead of trusting the
    webhook-delivered event payload. Two false 'title format not recognised'
    skips were traced to titles that parsed correctly in isolation — the
    payload GitHub dispatches to the workflow appears to occasionally be
    stale under rapid successive issue creation, upstream of anything our
    own concurrency control can affect. A direct API read is always current.
    """
    if not number or not token or not repo_full:
        return None
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo_full}/issues/{number}",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"[WARN] fresh issue fetch failed, falling back to webhook payload: {e}")
        return None


def read_event_payload() -> dict | None:
    """Read the original webhook payload straight from GITHUB_EVENT_PATH —
    a JSON file GitHub writes to the runner's disk at job start. Evidence
    from issue #210 showed BOTH ISSUE_TITLE and ISSUE_NUMBER arriving empty
    from the ${{ github.event.issue.* }} expression substitution — meaning
    that mechanism itself is not reliable here (likely doesn't survive the
    concurrency-queue wait). This file read is independent of that."""
    path = os.environ.get("GITHUB_EVENT_PATH")
    if not path:
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"[WARN] could not read GITHUB_EVENT_PATH: {e}")
        return None


def main():
    title      = os.environ.get("ISSUE_TITLE", "")
    body       = os.environ.get("ISSUE_BODY", "")
    created_at = os.environ.get("ISSUE_CREATED_AT", datetime.now(timezone.utc).isoformat())

    webhook_title = title  # preserved for diagnostics regardless of what happens next
    fetch_number = os.environ.get("ISSUE_NUMBER", "")

    # Primary source: the raw event payload file, immune to the expression-
    # substitution issue that caused #210's ISSUE_TITLE/ISSUE_NUMBER to be empty.
    event_payload = read_event_payload()
    payload_issue = (event_payload or {}).get("issue") or {}
    if payload_issue.get("title"):
        title = payload_issue["title"]
    if payload_issue.get("body") is not None:
        body = payload_issue["body"] or body
    if payload_issue.get("number") and not fetch_number:
        fetch_number = str(payload_issue["number"])

    fetch_error = None
    fresh = fetch_fresh_issue(
        fetch_number,
        os.environ.get("GITHUB_TOKEN", ""),
        os.environ.get("REPO_FULL", ""),
    )
    if fresh:
        title = fresh.get("title", title)
        body = fresh.get("body", body) or body
    else:
        fetch_error = "fetch_fresh_issue returned None"

    parsed = parse_issue(title, body)
    if not parsed:
        # Self-diagnosing skip: two prior fixes (concurrency lock, fresh-API
        # refetch) both failed to stop this recurring, unexplained bug, and
        # direct Action log access is blocked from where this gets debugged.
        # Publish the actual evidence on the issue itself instead of just
        # announcing a skip, so the next occurrence is diagnosable from the
        # issue thread alone.
        diag_lines = [
            f"- ISSUE_NUMBER env var: `{os.environ.get('ISSUE_NUMBER','')!r}`",
            f"- ISSUE_TITLE env var (webhook expression): `{webhook_title!r}`",
            f"- GITHUB_EVENT_PATH read succeeded: `{event_payload is not None}`",
            f"- title from event payload file: `{payload_issue.get('title')!r}`",
            f"- number resolved for API fetch: `{fetch_number!r}`",
            f"- fresh-fetch title: `{(fresh.get('title') if fresh else None)!r}`",
            f"- fresh-fetch succeeded: `{fresh is not None}`",
            f"- fresh-fetch error: `{fetch_error!r}`",
            f"- final title used for parsing: `{title!r}`",
            f"- regex re-tested against that title: `{bool(TITLE_RE.match(title.strip()))}`",
        ]
        diag = "\n\n<details><summary>Diagnostics</summary>\n\n" + "\n".join(diag_lines) + "\n\n</details>"
        msg = "⚠️ Submission skipped — title format not recognised.\nExpected: `[HUNT] #NN L | Team Name`" + diag
        write_outputs(msg, "skip")
        sys.exit(0)

    team_display, artifact_id = parsed

    if artifact_id < 1 or artifact_id > TOTAL_ARTIFACTS:
        msg = f"⚠️ Artifact #{artifact_id} is out of range (1–{TOTAL_ARTIFACTS})."
        write_outputs(msg, "error")
        sys.exit(0)

    letter = ARTIFACTS[artifact_id]
    data   = load_scores()

    # ── Duplicate check ────────────────────────────────────────────────────
    norm_team = normalize_team(team_display)
    already = any(
        normalize_team(s["team"]) == norm_team and s["artifact_id"] == artifact_id
        for s in data["submissions"]
    )
    if already:
        msg = f"⚠️ **{team_display}** already submitted artifact **#{artifact_id} [{letter}]**. Duplicate ignored."
        write_outputs(msg, "duplicate")
        sys.exit(0)

    # ── Scoring ────────────────────────────────────────────────────────────
    art_key  = str(artifact_id)
    art_data = data["artifacts"].setdefault(art_key, {
        "id": artifact_id,
        "letter": letter,
        "rare": artifact_id in RARE_IDS,
        "found_count": 0,
        "first_finder": None,
        "finders": []
    })

    rank_for_artifact = art_data["found_count"] + 1  # 1-based
    base_pts = RARE_PTS if artifact_id in RARE_IDS else STANDARD_PTS
    mult     = get_speed_mult(rank_for_artifact)
    pts      = round(base_pts * mult)

    # ── Update artifact record ─────────────────────────────────────────────
    art_data["found_count"] += 1
    art_data["finders"].append({"team": team_display, "timestamp": created_at, "rank": rank_for_artifact})
    if art_data["first_finder"] is None:
        art_data["first_finder"] = team_display

    # ── Update team record ─────────────────────────────────────────────────
    team_rec = find_team(data["teams"], team_display)
    if team_rec is None:
        team_rec = {
            "name": team_display,
            "type": "team",
            "total_points": 0,
            "artifacts_found": [],
            "last_submission": None,
            "completion_bonus_awarded": False
        }
        data["teams"].append(team_rec)

    team_rec["total_points"]    += pts
    team_rec["artifacts_found"].append(artifact_id)
    team_rec["last_submission"]  = created_at

    # ── Completion bonus ───────────────────────────────────────────────────
    completion_awarded = False
    if (len(team_rec["artifacts_found"]) == TOTAL_ARTIFACTS
            and not team_rec["completion_bonus_awarded"]):
        team_rec["total_points"] += COMPLETION_BONUS
        team_rec["completion_bonus_awarded"] = True
        completion_awarded = True

    # ── Append to submissions log ──────────────────────────────────────────
    data["submissions"].append({
        "team":        team_display,
        "artifact_id": artifact_id,
        "letter":      letter,
        "rare":        artifact_id in RARE_IDS,
        "timestamp":   created_at,
        "base_points": base_pts,
        "multiplier":  mult,
        "points":      pts,
        "rank_at_time": rank_for_artifact
    })

    recalculate_leaderboard(data)
    save_scores(data)

    # ── Find team's current rank ───────────────────────────────────────────
    team_rank = next(
        (i + 1 for i, t in enumerate(data["teams"])
         if normalize_team(t["name"]) == norm_team),
        "?"
    )

    # ── Build outputs ──────────────────────────────────────────────────────
    rare_tag = " 🌟 **RARE ARTIFACT**" if artifact_id in RARE_IDS else ""
    bonus_tag = f"\n\n🏆 **COMPLETION BONUS +{COMPLETION_BONUS} pts — All 55 artifacts found!**" if completion_awarded else ""

    comment = f"""## ✅ Find Registered!

| Field | Value |
|---|---|
| **Team** | {team_display} |
| **Artifact** | #{artifact_id} — Letter **{letter}**{rare_tag} |
| **Base points** | {base_pts} |
| **Speed rank** | #{rank_for_artifact} → ×{mult} |
| **Points awarded** | **+{pts}** |
| **Team total** | {team_rec['total_points']} pts |
| **Current rank** | #{team_rank} |
| **Artifacts found** | {len(team_rec['artifacts_found'])} / {TOTAL_ARTIFACTS} |
{bonus_tag}

*Leaderboard updates within 60 seconds.*"""

    commit_msg = f"{team_display} found #{artifact_id} [{letter}] +{pts}pts"
    write_outputs(comment, "success", commit_msg)


def write_outputs(comment: str, status: str, commit_msg: str = "score update"):
    Path("/tmp/issue_comment.txt").write_text(comment)
    Path("/tmp/commit_msg.txt").write_text(commit_msg[:72])
    print(f"[{status.upper()}] {commit_msg}")


if __name__ == "__main__":
    main()
