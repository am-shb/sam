/**
 * scripts/backup-db.ts — race-free snapshot of a SQLite DB.
 *
 * Usage:
 *   pnpm exec tsx scripts/backup-db.ts <src-db> <dest-db>
 *
 * Uses better-sqlite3's online backup API so it copes with the host process
 * writing v2.db concurrently — a plain `cp` could capture a torn write. Used
 * by scripts/self-deploy.sh to snapshot data/v2.db before a deploy so a
 * rollback can restore the exact pre-deploy schema + state.
 */
import Database from 'better-sqlite3';

const [, , src, dest] = process.argv;

if (!src || !dest) {
  console.error('Usage: pnpm exec tsx scripts/backup-db.ts <src-db> <dest-db>');
  process.exit(2);
}

const db = new Database(src, { readonly: true });
db.backup(dest)
  .then(() => {
    db.close();
    console.log(`Backed up ${src} → ${dest}`);
  })
  .catch((err: unknown) => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
