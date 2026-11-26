# ak-status

Status page for the Arknights tools: ak-events, ak-chars, ric, the ak-account API and login, plus their data jobs and deploys.

**Page:** https://darkwebdev.github.io/ak-status/

## How it works

- `.github/workflows/check.yml` runs every 5 minutes (GitHub's cron is best-effort, so expect some delay).
- `scripts/check.mjs` runs the checks in `config.json` and writes `status.json`, `history.json` (7 days of samples) and `daily.json` (90 days of daily counts) to the `data` branch. That branch is force-pushed as a single commit, so `main` stays clean and Pages doesn't redeploy every 5 minutes.
- `index.html` is served by GitHub Pages from `main` and reads the results from the `data` branch via raw.githubusercontent.com.
- A check failing twice in a row opens an issue labelled `outage` (GitHub emails you about it). The issue closes by itself when the check recovers.

## Check types

| type | passes when |
|---|---|
| `page` | URL returns 200, contains `contains`, and its `<script src>` bundles load (catches half-broken deploys) |
| `http` | `method` + JSON `body` returns `expectStatus` (or anything below `expectStatusBelow`) |
| `graphql` | query returns no errors and `expect.path` equals `expect.equals` |
| `json` | GET returns JSON where `expect.path` is present (or equals `expect.equals`) |
| `yostarplat` | signed POST to Yostar's account SDK, like the game client; passes if Yostar answers with a JSON `Code` |
| `cors` | an `OPTIONS` preflight from `origin` is allowed |
| `workflow` | the latest completed run of a GitHub Actions workflow succeeded, and (with `maxAgeHours`) the last success is recent enough |

Optional per check: `slowMs` (slower = degraded), `everyMinutes` (run less often than every 5 min).

### Why login isn't checked with a real account every 5 minutes

Any authenticated Yostar request kicks the account out of the game (one live session per account). So the frequent checks stay away from real credentials:

- **Login endpoint**: the API validates input on `/auth/game-code`.
- **Yostar game servers**: `searchPlayers` goes through the API to Yostar using a guest session.
- **Full email-code login**: reads the result of ak-account's daily Integration Tests, which already do the real email-code login once a day.

## Setup

1. Settings → Pages → Deploy from a branch → `main` / root.
2. Optional, to read ak-account's (private) workflow runs: create a fine-grained token with **Actions: read** on `darkwebdev/ak-account` and save it as the `STATUS_GH_TOKEN` repository secret.
3. Actions → Check services → Run workflow, for the first results.

## Local run

```bash
DRY_RUN=1 FORCE=1 node scripts/check.mjs ./data   # no issues are touched
python3 -m http.server   # then open http://localhost:8000/?data=http://localhost:8000/data/
```
