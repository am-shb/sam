/**
 * Host-side lifecycle hooks for self-deploy.
 *
 * - writeReadyMarker(): touched at the end of a successful boot. The detached
 *   orchestrator polls this (mtime newer than the restart + commit === target)
 *   to confirm the new code came up healthy; a boot crash never reaches here,
 *   so the orchestrator times out and rolls back.
 * - drainDeployResult(): if the orchestrator left a result file, the (new or
 *   rolled-back) host reports it to the owner so the assistant tells the user.
 *   This is how a result survives the restart that the deploy caused.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { wakeContainer } from '../container-runner.js';
import { getActiveSessions, getSession } from '../db/sessions.js';
import { getOwners } from '../modules/permissions/db/user-roles.js';
import { getUserDmsForUser } from '../modules/permissions/db/user-dms.js';
import { log } from '../log.js';
import { writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';

const READY_MARKER = path.join(DATA_DIR, '.host-ready');
const DEPLOY_RESULT = path.join(DATA_DIR, '.deploy-result.json');

interface DeployResult {
  status: 'success' | 'rollback' | 'failed';
  from?: string;
  to?: string;
  error?: string;
  ts?: string;
}

/** Best-effort current commit; empty string if git is unavailable. */
function currentCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() }).toString().trim();
  } catch {
    return '';
  }
}

/** Write the readiness marker atomically at the end of a healthy boot. */
export function writeReadyMarker(): void {
  try {
    const payload = JSON.stringify({ commit: currentCommit(), bootedAt: new Date().toISOString() });
    const tmp = READY_MARKER + '.tmp';
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, READY_MARKER);
  } catch (err) {
    log.warn('Failed to write host-ready marker', { err });
  }
}

/** Active sessions the owner converses in (via their DM messaging groups). */
function ownerSessions(): Session[] {
  const owners = getOwners();
  if (owners.length === 0) return [];
  const dmGroupIds = new Set<string>();
  for (const o of owners) {
    for (const dm of getUserDmsForUser(o.user_id)) dmGroupIds.add(dm.messaging_group_id);
  }
  if (dmGroupIds.size === 0) return [];
  return getActiveSessions().filter((s) => s.messaging_group_id && dmGroupIds.has(s.messaging_group_id));
}

/** Most-recently-active session, as a fallback target. */
function mostRecentSession(): Session | undefined {
  const active = getActiveSessions();
  if (active.length === 0) return undefined;
  return active.sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''))[0];
}

function resultMessage(r: DeployResult): string {
  const to = r.to ? r.to.slice(0, 7) : '?';
  const from = r.from ? r.from.slice(0, 7) : '?';
  if (r.status === 'success') {
    return `✅ Self-deploy succeeded: now running ${to} (was ${from}). Briefly let the user know the update is live.`;
  }
  if (r.status === 'rollback') {
    return `↩️ Self-deploy of ${to} FAILED and was rolled back to ${from} — I'm running the previous known-good version. Reason: ${r.error || 'unknown'}. Tell the user the update didn't apply and why, so they can fix the PR and re-merge.`;
  }
  return `⚠️ Self-deploy did not complete: ${r.error || 'unknown error'}. Tell the user to check logs/self-deploy.log.`;
}

/**
 * Deliver a system message to the owner (falling back to the most-recent
 * session) as an on_wake message so the assistant relays it to the user, then
 * wakes the container. Shared by the deploy-started webhook notification and
 * the deploy-result drain. Returns the number of sessions notified.
 */
export function notifyOwners(text: string): number {
  let targets = ownerSessions();
  if (targets.length === 0) {
    const fallback = mostRecentSession();
    if (fallback) targets = [fallback];
  }

  let delivered = 0;
  for (const session of targets) {
    try {
      writeSessionMessage(session.agent_group_id, session.id, {
        id: `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: session.agent_group_id,
        channelType: 'agent',
        threadId: null,
        content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        onWake: 1,
      });
      const fresh = getSession(session.id);
      if (fresh) wakeContainer(fresh);
      delivered++;
    } catch (err) {
      log.error('Failed to deliver owner notification', { sessionId: session.id, err });
    }
  }
  return delivered;
}

/**
 * If the orchestrator left a deploy result, deliver it to the owner as an
 * on_wake system message so the assistant reports it, then delete the file.
 * Called once during startup.
 */
export function drainDeployResult(): void {
  let raw: string;
  try {
    raw = fs.readFileSync(DEPLOY_RESULT, 'utf-8');
  } catch {
    return; // no result pending
  }

  let result: DeployResult;
  try {
    result = JSON.parse(raw);
  } catch (err) {
    log.warn('Unparseable deploy result file, discarding', { err });
    fs.rmSync(DEPLOY_RESULT, { force: true });
    return;
  }

  const delivered = notifyOwners(resultMessage(result));

  log.info('Deploy result drained', { status: result.status, targets: delivered });
  fs.rmSync(DEPLOY_RESULT, { force: true });
}
