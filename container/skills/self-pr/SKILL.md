---
name: self-pr
description: Propose a durable change to your own source code via a reviewed GitHub pull request. Use when the user asks you to change how you work at the code level (your source, Dockerfile, skills) in a way that should persist and be reviewed. You edit a clone of your code, push a branch, and open a PR; the operator reviews, CI runs tests, and on merge the host auto-deploys with rollback.
---

# Self-PR — change your own code, safely

You can improve your own source code, but never by editing the live install. Instead you open a **pull request** the operator reviews and merges. After merge, GitHub notifies the host, which pulls, builds, and restarts on the new code — and **automatically rolls back** if anything fails to build or boot. So a bad change can never take you down permanently.

## What you have

- **`git`** and **`gh`** (GitHub CLI) are installed.
- **GitHub auth** is provided by the OneCLI gateway at request time. Never ask the user for a token, and never paste one. If a `git push` or `gh` call fails with an auth error, see the onecli-gateway skill — do not work around it by hardcoding credentials.

You get your source by cloning it fresh from GitHub (over HTTPS, so OneCLI injects auth). You do **not** get a mount of the live install — that directory holds `.env` secrets and every group's private session data, so it's deliberately not exposed. `origin/main` on GitHub is exactly the code currently running (the deploy keeps them in lockstep), so it's the correct base for your PR.

## Workflow

1. **Understand the change.** Clone and read the relevant files (next step). Form a concrete, minimal plan: which files, what behavior, how it's tested.

2. **Clone your source and branch:**
   ```bash
   rm -rf /workspace/group/self-work
   git clone https://github.com/am-shb/sam.git /workspace/group/self-work
   cd /workspace/group/self-work
   git config user.name  "Sam"
   git config user.email "sam@users.noreply.github.com"
   git checkout -b sam/<short-topic>
   ```

3. **Edit, keeping the change small and focused.** Match surrounding code style. Don't refactor unrelated code. Follow the repo's rules in `CONTRIBUTING.md` and `CLAUDE.md`.

4. **Validate locally what you can** before pushing — at minimum a typecheck/build of the area you touched (`pnpm install --frozen-lockfile` then `pnpm run build`, or the container typecheck for `container/` changes). CI will run the full suite, but catching obvious breakage first is polite.

5. **Commit and push:**
   ```bash
   git add -A
   git commit -m "<clear, scoped message>"
   git push -u origin sam/<short-topic>
   ```

6. **Open the PR and hand back the link:**
   ```bash
   gh pr create --base main --head sam/<short-topic> \
     --title "<title>" \
     --body "<what changed and why; how you tested; anything the operator should check>"
   ```
   Send the operator the PR URL and a one-line summary. Tell them CI will run on the PR and that **you'll restart on the new code automatically once they merge** (with rollback if it fails).

## After the operator merges

You don't do anything. The host receives a webhook, deploys, and restarts. When the new (or rolled-back) version comes up, you'll get a system message telling you whether the deploy **succeeded** or was **rolled back** (with the reason) — relay that to the operator. If it rolled back, the PR needs another revision; iterate.

## Scope & safety

- **Small, reviewable diffs.** If a change is large, split it across multiple PRs.
- **Never** edit `/workspace/extra/sam-src` directly, commit secrets/`.env`, or modify the supply-chain policy (`minimumReleaseAge*`, `onlyBuiltDependencies`) — those need explicit human sign-off (see CLAUDE.md).
- **A note on dependencies:** if your PR bumps or adds an npm dep, the deploy can fail on the host because new package versions are blocked for 3 days by the release-age gate. That's expected — the deploy will roll back and tell you why; re-merge after the window, or avoid the dep.
- If you're unsure whether a change is wanted, ask the operator before opening the PR.
