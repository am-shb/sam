# Self-deploy: agent-authored PRs → merge → safe auto-restart

This lets the assistant improve her own source code through a reviewed GitHub
flow, and lets the host redeploy itself automatically when you merge — with an
automatic rollback floor so a bad change can never take her down permanently.

```
Sam edits a clone of her code ─▶ opens a PR ─▶ CI runs tests ─▶ you review + merge
        │                                                              │
        └──────────────────────────────────────────────────────┐     ▼
                                                       GitHub webhook (via Cloudflare tunnel)
                                                                 │
                                                                 ▼
                                            scripts/self-deploy.sh (detached)
                                snapshot DB → fast-forward → install → build →
                                (rebuild image if container/ changed) → restart →
                                health-check ──pass──▶ done, Sam reports "deployed"
                                                └──fail──▶ rollback to last-good
                                                          (code + DB) → Sam reports
                                                          "rolled back, here's why"
```

## How it works

**The PR side (container).** The `self-pr` container skill teaches the assistant
to `git clone` her source from GitHub over HTTPS, branch, edit, push, and
`gh pr create`. She never gets a mount of the live install (it holds `.env` and
other groups' session data) — `origin/main` on GitHub is the running code, so
it's the correct PR base. `git`/`gh` auth comes from the OneCLI gateway.

**The deploy side (host).** When enabled, the host exposes
`/webhook/github-deploy` on the existing webhook server (port 3000). A merge to
`SELF_DEPLOY_BRANCH` (default `main`) — verified by `X-Hub-Signature-256` HMAC —
launches the **detached** orchestrator `scripts/self-deploy.sh`. It's detached
(`setsid`) so it survives the host restart it triggers.

**Safety floor.** Before touching anything the orchestrator snapshots
`data/v2.db` and records the current commit. On any failure (install, build,
image rebuild, or the new process not coming up healthy within the timeout) it
rolls back the working tree **and** restores the DB snapshot, rebuilds the old
code, and restarts. systemd `Restart=always` plus the restored tree/DB is the
last-resort floor. The new boot is confirmed via a readiness marker
(`data/.host-ready`) the host writes only at the end of a successful startup.

**Reporting.** The orchestrator writes `data/.deploy-result.json`; the running
(or rolled-back) host drains it on its 60s sweep and has the assistant tell you
whether the deploy succeeded or rolled back (with the reason).

## One-time setup

### 1. OneCLI GitHub credential

Add a **fine-grained PAT** scoped to your fork (`am-shb/sam`) with
**Contents: write** and **Pull requests: write** to the OneCLI vault, with a
host pattern covering `github.com` / `api.github.com`. Make sure the assistant's
agent is `secretMode=all` (or assign the secret):

```bash
onecli agents list
onecli agents set-secret-mode --id <agent-id> --mode all
```

Verify from inside a container session that `git push` / `gh` work without a
prompt. If they error on auth, the gateway has no matching `github.com` secret —
see the `onecli-gateway` skill.

### 2. Rebuild the agent image (adds `gh`)

```bash
./container/build.sh
```

### 3. Cloudflare tunnel ingress

Route a hostname/path to the webhook server. In `~/.cloudflared/config.yml`:

```yaml
ingress:
  - hostname: sam-deploy.<your-domain>
    path: /webhook/github-deploy
    service: http://localhost:3000
  - service: http_status:404
```

```bash
cloudflared tunnel route dns <tunnel> sam-deploy.<your-domain>
# restart cloudflared
```

### 4. GitHub webhook

Repo → Settings → Webhooks → Add webhook:

- **Payload URL:** `https://sam-deploy.<your-domain>/webhook/github-deploy`
- **Content type:** `application/json`
- **Secret:** a strong random string (you'll reuse it below)
- **Events:** *Just the push event* (a PR merge produces a push to `main`).
  (`pull_request` closed+merged is also supported if you prefer.)

### 5. Enable on the host

Add to `.env`:

```
SELF_DEPLOY_ENABLED=true
GITHUB_WEBHOOK_SECRET=<the same secret as step 4>
# optional overrides:
# SELF_DEPLOY_BRANCH=main
# SELF_DEPLOY_HEALTH_TIMEOUT_MS=120000
# WEBHOOK_PORT=3000
```

Restart the service. On boot you'll see `Self-deploy webhook ready` in
`logs/nanoclaw.log`. GitHub's "Recent Deliveries" `ping` should get a 200.

## Verifying

- **PR:** ask Sam to make a trivial change and open a PR; confirm she returns a
  URL and CI starts.
- **Deploy:** merge it; watch `logs/self-deploy.log` (fetch → build → restart →
  healthy) and confirm `git rev-parse HEAD` matches the merge and Sam reports
  success.
- **Rollback:** merge a change that compiles in CI but fails to boot locally;
  confirm the orchestrator times out, resets to last-good (code + DB), comes
  back healthy, and Sam reports the rollback.
- **Security:** a POST with a bad/missing signature returns 401 and does
  nothing.

## Operational notes

- **Service unit** is slug-derived (`nanoclaw-v2-<slug>`); the orchestrator
  resolves it via `setup/lib/install-slug.sh` and auto-detects
  `systemctl --user` vs `systemctl` vs a `nohup` fallback.
- **Dependency bumps in a PR** can fail the deploy: pnpm's `minimumReleaseAge`
  gate blocks package versions younger than 3 days, even after merge. The deploy
  rolls back and says so; re-merge after the window. The orchestrator never
  edits the supply-chain policy.
- **Container changes** trigger `docker buildx prune -f` + `./container/build.sh`
  (slow on a Pi) to defeat the buildkit COPY-cache staleness.
- **Mid-conversation deploys** restart the host and can drop one in-flight agent
  turn (same exposure as any restart). Orphaned containers are reaped on the
  next boot.
- **Backups** live in `data/backups/<ts>/v2.db`; the 5 newest are kept.
