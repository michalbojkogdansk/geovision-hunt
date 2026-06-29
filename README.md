# GeoVision Hunt — Gdańsk 2025

Field geocaching event for 500 R&D engineers across Gdańsk.  
Vision statement decoded, letter by letter, 55 wooden board artifacts hidden across the city.

---

## Quick Start (30 minutes to production)

### 1. Create the GitHub repo

```bash
gh repo create geovision-hunt --public
git clone https://github.com/michalbojkogdansk/geovision-hunt
# copy all files from this project into it
```

### 2. Create a Fine-Grained Personal Access Token

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained**

Permissions required (on `geovision-hunt` repo only):
- `Contents` → **Read and Write**  (photo upload + scores.json)
- `Issues`   → **Read and Write**  (create submissions)

Copy the token.

### 3. Configure `index.html`

Open `index.html` and update the `CFG` block at the top of the script:

```js
const CFG = {
  OWNER:    'michalbojkogdansk',
  REPO:     'geovision-hunt',
  TOKEN:    'github_pat_XXXX...',   // ← paste your PAT here
  ADMIN_PW: 'hunt2025gdansk',       // ← change this
  ...
};
```

### 4. Create the `submission` label in your repo

```bash
gh label create submission --color "C8960C" --description "Hunt submission"
```

### 5. Enable GitHub Pages

Repo → Settings → Pages → Source: **Deploy from branch** → `main` / `/ (root)`

Your event URL: `https://michalbojkogdansk.github.io/geovision-hunt/`

### 6. Push everything

```bash
git add .
git commit -m "init: GeoVision Hunt"
git push
```

---

## Configure Rare Artifacts

Default rare artifact IDs: `7, 13, 19, 25, 31, 37, 43, 49, 52, 55`

To change: open the app → Admin tab → toggle artifacts → Save Config → merge the downloaded JSON into `data/config.json`.

Or edit `data/config.json` directly:

```json
{
  "rare_artifacts": [7, 13, 19, 25, 31, 37, 43, 49, 52, 55]
}
```

Also update `CFG.RARE_IDS` in `index.html` to match.

---

## Scoring

| Scenario                   | Points              |
|----------------------------|---------------------|
| Standard artifact, 1st find | 10 × 3.0 = **30**  |
| Standard artifact, 2nd find | 10 × 2.0 = **20**  |
| Standard artifact, 3rd–5th  | 10 × 1.5 = **15**  |
| Standard artifact, 6th+     | 10 × 1.0 = **10**  |
| Rare artifact, 1st find     | 50 × 3.0 = **150** |
| Rare artifact, 2nd find     | 50 × 2.0 = **100** |
| Completion bonus (all 55)   | **+500**            |

---

## Artifact List — 55 Boards

"**Innovate with Passion, Engage with Purpose, and Win with Integrity**"

| # | Letter | # | Letter | # | Letter | # | Letter | # | Letter |
|---|--------|---|--------|---|--------|---|--------|---|--------|
| 1 | I | 12 | H | 23 | A | 34 | O | 45 | T |
| 2 | N | 13 | P★ | 24 | G | 35 | S | 46 | H |
| 3 | N | 14 | A | 25 | E★ | 36 | E | 47 | I |
| 4 | O | 15 | S | 26 | W | 37 | A★ | 48 | N |
| 5 | V | 16 | S | 27 | I | 38 | N | 49 | T★ |
| 6 | A | 17 | I | 28 | T | 39 | D | 50 | E |
| 7 | T★| 18 | O | 29 | H | 40 | W | 51 | G |
| 8 | E | 19 | N★ | 30 | P | 41 | I | 52 | R★ |
| 9 | W | 20 | E | 31 | U★ | 42 | N | 53 | I |
| 10 | I | 21 | N | 32 | R | 43 | W★ | 54 | T |
| 11 | T | 22 | G | 33 | P | 44 | I | 55 | Y★ |

★ = Rare artifact (+50 pts base, 1st find = 150 pts)

---

## How Submissions Work

1. Participant opens the app on their phone
2. Enters team name + artifact number (from board) + photo
3. App uploads photo to `/photos/` in this repo, creates a GitHub Issue
4. GitHub Action fires, validates, updates `data/scores.json`
5. Leaderboard refreshes every 60 seconds

---

## Promo A3 Poster Brief

Suggested visual concept: **"Field Orders"** — classified mission briefing aesthetic
- Background: dark olive green (matching app)
- Hero: giant stencil-style letters spelling "HUNT"
- Subtext: the full vision statement in typewriter mono
- CTA: URL + QR code to the GitHub Pages URL
- Visual: map of Gdańsk with scattered letter markers
- Accent colour: amber/brass (#C8960C)
- Landmark: Żuraw crane silhouette or Długi Targ arcade
- Feel: adventure, urgency, classified intel

---

## Security Note

The GitHub PAT is visible in the frontend JavaScript. For an internal event with an honor system this is acceptable. Worst-case abuse: spam submissions to a single repo's issues.

Mitigation: fine-grained PAT scoped to this repo only, `contents:write` + `issues:write` only.
After the event: revoke the PAT.
