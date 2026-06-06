/**
 * GitHub webhook → safe self-deploy.
 *
 * When SELF_DEPLOY_ENABLED is set, the host exposes a custom webhook route at
 * `/webhook/github-deploy` (delivered through the operator's Cloudflare tunnel).
 * On a merge to SELF_DEPLOY_BRANCH this launches the DETACHED orchestrator
 * `scripts/self-deploy.sh`, which pulls, builds, restarts the host, and rolls
 * back automatically on failure. The handler itself does no deploy work — it
 * verifies the request and returns fast (202), because restarting the host
 * would kill any in-process deploy.
 *
 * Security: every request must carry a valid `X-Hub-Signature-256` HMAC over
 * the RAW body bytes, keyed by GITHUB_WEBHOOK_SECRET (read here, never exported
 * globally). Signature is compared in constant time.
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { SELF_DEPLOY_BRANCH } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { notifyOwners } from './lifecycle.js';
import { registerWebhookRoute, startWebhookServer, type CustomRouteHandler } from '../webhook-server.js';

const ROUTE_PATH = '/webhook/github-deploy';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Constant-time compare of the GitHub signature header against our HMAC. */
function verifySignature(secret: string, body: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — guard first (length is not secret).
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Decide whether a verified payload is a merge to our deploy branch.
 * - push  → ref === refs/heads/<branch>  (a PR merge produces a push to main)
 * - pull_request → action closed && merged && base.ref === <branch>
 */
function isDeployEvent(event: string, payload: Record<string, unknown>): boolean {
  if (event === 'push') {
    return payload.ref === `refs/heads/${SELF_DEPLOY_BRANCH}`;
  }
  if (event === 'pull_request') {
    if (payload.action !== 'closed') return false;
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    if (!pr || pr.merged !== true) return false;
    const base = pr.base as Record<string, unknown> | undefined;
    return base?.ref === SELF_DEPLOY_BRANCH;
  }
  return false;
}

/** The commit being deployed, from the verified payload (push or merged PR). */
function deployCommit(event: string, payload: Record<string, unknown>): string | undefined {
  if (event === 'push') {
    const head = payload.head_commit as Record<string, unknown> | undefined;
    return (payload.after as string) || (head?.id as string) || undefined;
  }
  if (event === 'pull_request') {
    const pr = payload.pull_request as Record<string, unknown> | undefined;
    return (pr?.merge_commit_sha as string) || undefined;
  }
  return undefined;
}

/** Launch the detached deploy orchestrator. Survives the host restart it triggers. */
function launchOrchestrator(projectRoot: string): void {
  const script = path.join(projectRoot, 'scripts', 'self-deploy.sh');
  const logFile = path.join(projectRoot, 'logs', 'self-deploy.log');
  let out: number;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, 'a');
  } catch (err) {
    log.error('Self-deploy: cannot open log file', { logFile, err });
    return;
  }
  // detached:true → new session/process group (setsid equivalent), so
  // `systemctl restart` killing the host's group can't take this down.
  const child = spawn('bash', [script, projectRoot], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.on('error', (err) => log.error('Self-deploy: failed to launch orchestrator', { err }));
  child.unref();
  fs.closeSync(out);
  log.info('Self-deploy orchestrator launched', { script });
}

function buildHandler(secret: string, projectRoot: string): CustomRouteHandler {
  return async (body, headers, method) => {
    if (method !== 'POST') return json(405, { error: 'method not allowed' });

    const event = headers['x-github-event'] || '';
    if (event === 'ping') return json(200, { ok: true, pong: true });

    if (!verifySignature(secret, body, headers['x-hub-signature-256'])) {
      log.warn('Self-deploy: bad webhook signature', { event });
      return json(401, { error: 'bad signature' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf-8'));
    } catch {
      return json(400, { error: 'invalid json' });
    }

    if (!isDeployEvent(event, payload)) {
      return json(200, { ok: true, ignored: true, event });
    }

    const commit = deployCommit(event, payload);
    const short = commit ? commit.slice(0, 7) : '?';
    log.info('Self-deploy: merge event accepted, launching deploy', {
      event,
      branch: SELF_DEPLOY_BRANCH,
      commit: short,
    });
    // Tell the owner the deploy is starting (this runs on the OLD host, before
    // the orchestrator restarts it). The success/rollback result is reported
    // from the new host's boot via drainDeployResult().
    try {
      notifyOwners(
        `🚀 Self-deploy started: deploying \`${short}\` to ${SELF_DEPLOY_BRANCH}. I'll let you know once it's live (or if it rolled back). Briefly tell the user a deploy is in progress.`,
      );
    } catch (err) {
      log.warn('Self-deploy: failed to send deploy-started notification', { err });
    }
    launchOrchestrator(projectRoot);
    return json(202, { accepted: true });
  };
}

/**
 * Register the self-deploy webhook route and force-start the webhook server.
 * Called from src/index.ts when SELF_DEPLOY_ENABLED. No-op (with a loud
 * warning) if GITHUB_WEBHOOK_SECRET is unset, since an unauthenticated deploy
 * endpoint must never be exposed.
 */
export function registerSelfDeployWebhook(): void {
  const secret = process.env.GITHUB_WEBHOOK_SECRET || readEnvFile(['GITHUB_WEBHOOK_SECRET']).GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    log.error('SELF_DEPLOY_ENABLED but GITHUB_WEBHOOK_SECRET is unset — refusing to expose the deploy webhook.');
    return;
  }
  const projectRoot = process.cwd();
  registerWebhookRoute(ROUTE_PATH, buildHandler(secret, projectRoot));
  startWebhookServer();
  log.info('Self-deploy webhook ready', { path: ROUTE_PATH, branch: SELF_DEPLOY_BRANCH });
}
