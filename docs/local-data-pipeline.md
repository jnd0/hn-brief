# Local HN Brief Data Pipeline

The local pipeline runs once a day in a Podman container, fetches the top Hacker News stories from the last 24 hours, summarizes each with a local OpenAI-compatible model, and writes durable JSON, Markdown, and inference traces to a host directory. It is separate from the upstream Cloudflare Worker, which remains supported.

## Background and design

The hosted service (a Cloudflare Worker committing summaries to GitHub) stopped publishing after 2026-07-16. This pipeline replaces it with a private, local setup:

- **One-shot container, host scheduling:** each run fetches, summarizes, publishes, and exits. cron/systemd or `launchd` owns the schedule, so there is no long-running process to babysit.
- **Data, not a website:** output is plain JSON and Markdown in one directory, for other agents to read and republish.
- **Keep the evidence:** every run keeps its HN inputs and each model request, raw response, parsed result, timing, and token count under `runs/`, so model problems can be debugged and cheaper models compared on the same inputs. API keys and request headers are never written.
- **Protect the last good briefing:** a lock prevents overlapping runs, a run that fails before publishing exits nonzero and changes nothing, and `latest.json` is written last. Publishing itself is not all-or-nothing; see section 5.
- **Explicit cleanup:** run evidence is deleted only by `prune`, by date or age; published briefings are never pruned.
- **Out of scope:** fetching article bodies (summaries use the HN title, post text, and comments, as before) and backfilling missed days.

Data directory layout:

```text
<data>/
├── latest.json            # newest briefing: {date, runId, path}
├── archive.json           # every published day, newest first
├── daily/YYYY/MM/
│   ├── DD.json            # the briefing as structured data
│   ├── DD.md              # story summaries as Markdown
│   └── DD-digest.md       # the digest as Markdown
└── runs/<run-id>/         # retained evidence: manifest.json, hn/, llm/
```

Run IDs are the local start time plus UTC offset in `TZ`, for example `2026-09-08T070000-0400`.

## 1. Prerequisites

- Podman 5.x. Verify with `podman --version`.
- On macOS, a running Podman machine: `podman machine start`.
- Network access to Lunar Beacon, the LLM host at `http://llm-host.example:11434`.
- A host data directory for the output. It must be an absolute path.
  - **macOS:** put it under `$HOME`, for example `$HOME/hn-brief-data`. The Podman VM shares only your home directory with the host, so paths under `/tmp` or other locations outside `$HOME` cannot be bind-mounted.

## 2. Setup

Run these from the repository root.

```bash
cp .env.pipeline.example .env.pipeline
# Edit .env.pipeline: set LLM_API_URL and LLM_MODEL to your own model server and model.
mkdir -p "$HOME/hn-brief-data"
chmod 700 "$HOME/hn-brief-data"  # traces contain full prompts and responses

podman compose --project-directory "$PWD" build
```

- `.env.pipeline` holds the LLM settings. Compose loads it into the container as an optional `env_file`. It is git-ignored.
- The data directory is **not** set in `.env.pipeline`. Compose reads `HN_BRIEF_DATA_DIR` from the shell environment or from a Compose `.env` file next to `compose.yaml`. If you set it in neither, data goes to `./data` in the repository, which is git-ignored.
- Always pass `--project-directory` so relative paths resolve against the repository. Do not pass `--env-file .env.pipeline`; it is not needed and not used for the data directory.
- The image is `localhost/hn-brief-pipeline:local`. If `compose build` fails with `docker-credential-desktop: executable file not found`, the Docker credential helper in `~/.docker/config.json` is missing. Build with Podman directly instead: `podman build -f Containerfile -t localhost/hn-brief-pipeline:local .`

## 3. Manual run

```bash
HN_BRIEF_DATA_DIR="$HOME/hn-brief-data" podman compose --project-directory "$PWD" run --rm hn-brief generate
```

Replace `$HOME/hn-brief-data` with your absolute data directory and `$PWD` with the absolute repository path if you run it from elsewhere. A successful run prints `Generated <date> (run <run-id>, <n> stories).`

A full run calls the LLM for every story plus the digest. Expect it to take 30 to 90 minutes on `qwen3.8`. Only one generation may run at a time; a second run fails with `Generation already running`.

## 4. Agent handoff: reading the latest briefing

Downstream agents should read only the published files:

1. Read `<data>/latest.json`. It contains `date`, `runId`, and `path`.
2. Resolve `path` relative to `<data>`. For example, `daily/2026/09/08.json`.
3. Parse that file. It contains `schemaVersion`, `date`, `generatedAt`, `runId`, `source`, `model`, `digest`, `stories`, and `quality`.

Other published files, all under `<data>`:

- `daily/YYYY/MM/DD.json`: the daily record above.
- `daily/YYYY/MM/DD.md`: the article summaries as Markdown.
- `daily/YYYY/MM/DD-digest.md`: the digest as Markdown.
- `archive.json`: an array of `{ date, path, runId, storyCount }` entries, newest date first, one per date.

Ignore `runs/*` unless you are diagnosing a failure. Those directories are retained evidence, not the product.

## 5. Diagnosing failed runs

Each run writes to `<data>/runs/<run-id>/` as it progresses. Start with the newest one:

```bash
ls -1d "$HOME/hn-brief-data"/runs/* | tail -1
cat "$HOME/hn-brief-data/runs/<run-id>/manifest.json"
```

`manifest.json` contains:

- `status`: `running`, `complete`, or `failed`.
- `error`: the failure name and message, when failed.
- `stages`: timing for `fetch`, `summarize`, `digest`, and `publish`. The last stage recorded shows where the run stopped.
- `inference`: request count, elapsed time, and token usage.

Then inspect the evidence:

- `hn/top-stories.json`: the Algolia story list the run started from.
- `hn/stories/<id>.json`: the details fetched for each story.
- `llm/stories/<id>/` and `llm/digest/`: one directory per story (and one for the digest) holding `request.json`, `response.json`, `error.json`, and `parsed.json`. Retries for that story share the directory and are numbered, for example `attempt-02-request.json`.

A run that fails before publishing changes nothing: `latest.json`, `archive.json`, and the daily files stay as they were. Publishing itself is not all-or-nothing: it replaces the daily files one at a time, then `archive.json`, then `latest.json`. A failure partway through can leave that day's files partly written or mixed with an earlier run's, or leave `archive.json` ahead of `latest.json`. If the final manifest write fails after publishing finishes, the manifest may say `failed` or still say `running`, even though the files were published. In any of these cases, run `generate` again on the same calendar day (in `TZ`) to repair it. `generate` always publishes the current day and has no date override, so a damaged earlier day cannot be regenerated after midnight. A failed run also releases the lock, so the next run can start. A run that is killed instead (for example, the Mac sleeps or the container is stopped) leaves `.generate.lock` behind. Later runs report `Generation already running` until the lock is 12 hours old and is reclaimed automatically. If no run is active, you can delete `.generate.lock` in the data directory to recover sooner.

## 6. Pruning

Only intermediate run directories (`runs/<run-id>`) older than a cutoff can be removed. **Daily data (`daily/`, `archive.json`, `latest.json`) is never removed by pruning.**

Preview the candidates. Nothing is deleted:

```bash
HN_BRIEF_DATA_DIR="$HOME/hn-brief-data" podman compose --project-directory "$PWD" run --rm hn-brief prune --before 2026-08-01
```

Delete them only after reviewing the list. Add `--confirm`:

```bash
HN_BRIEF_DATA_DIR="$HOME/hn-brief-data" podman compose --project-directory "$PWD" run --rm hn-brief prune --before 2026-08-01 --confirm
```

### Automatic retention

To delete run evidence by age, use `--older-than-days` instead of a fixed date. The cutoff is that many days before today in `TZ`, and runs dated before the cutoff are deleted; runs on the cutoff day itself are kept:

```bash
HN_BRIEF_DATA_DIR="$HOME/hn-brief-data" podman compose --project-directory "$PWD" run --rm hn-brief prune --older-than-days 90 --confirm
```

Schedule it like the daily run (for example weekly). It takes the same data lock as `generate`, so it never deletes a run that is in progress, and it never touches `daily/`, `archive.json`, or `latest.json`.

## 7. Linux scheduling (rootless systemd user service and timer)

Create `~/.config/systemd/user/hn-brief-pipeline.service`. Replace the absolute paths with your own. Run `command -v podman` to find the Podman path.

```ini
[Unit]
Description=HN Brief local data pipeline

[Service]
Type=oneshot
Environment=HN_BRIEF_DATA_DIR=/absolute/path/to/hn-brief-data
ExecStart=/usr/bin/podman compose --project-directory /absolute/path/to/hn-brief run --rm hn-brief generate
```

Create `~/.config/systemd/user/hn-brief-pipeline.timer`:

```ini
[Unit]
Description=Run HN Brief local data pipeline daily

[Timer]
OnCalendar=*-*-* 07:00:00 America/New_York
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now hn-brief-pipeline.timer
loginctl enable-linger "$USER"   # keep user timers running when you are logged out
systemctl --user list-timers hn-brief-pipeline.timer
journalctl --user -u hn-brief-pipeline.service -e
```

`Persistent=true` runs a missed timer once after the machine wakes or boots.

## 8. macOS scheduling (launchd)

`launchd` runs the job at 07:00 local time, but the Mac must be awake at that time and the Podman machine must be running. A sleeping host does not reliably perform a long model run. Keep the Mac awake during the run window, or accept that a run may be skipped.

Create an executable wrapper, for example `$HOME/bin/hn-brief-generate.sh`. Replace the paths with absolute paths:

```bash
#!/bin/bash
set -euo pipefail
export PATH="/opt/podman/bin:/opt/homebrew/bin:/usr/bin:/bin"
export HN_BRIEF_DATA_DIR="/Users/you/hn-brief-data"
cd /Users/you/dev/src/mkai/hn-brief
exec podman compose --project-directory /Users/you/dev/src/mkai/hn-brief run --rm hn-brief generate
```

Make it executable with `chmod +x "$HOME/bin/hn-brief-generate.sh"`.

Create `~/Library/LaunchAgents/com.hn-brief.pipeline.plist`. Replace `/Users/you` with your home directory:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.hn-brief.pipeline</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/bin/hn-brief-generate.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/hn-brief-pipeline.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/hn-brief-pipeline.log</string>
</dict>
</plist>
```

Load and test it:

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hn-brief.pipeline.plist"
launchctl print "gui/$(id -u)/com.hn-brief.pipeline"
launchctl kickstart "gui/$(id -u)/com.hn-brief.pipeline"   # starts a run now; only do this deliberately
```

Unload with `launchctl bootout "gui/$(id -u)/com.hn-brief.pipeline"`.

## 9. Security

Lunar Beacon serves the LLM without authentication. Keep it on a trusted LAN or VPN only, or put authentication and a firewall rule in front of it before exposing it beyond that network. Do not commit `.env.pipeline`.
