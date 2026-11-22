// Runs a .sql file against the remote database.
//
//   node scripts/d1-run.mjs schema.sql
//
// This exists so npm run db:schema and npm run db:seed go through
// writeConfig() like everything else. They used to call wrangler
// directly:
//
//   wrangler d1 execute scs-scores --remote --file=schema.sql
//
// which reads the committed wrangler.toml, finds `database_id =
// "PASTE-FILLED-IN-BY-NPM-RUN-DEPLOY"`, and refuses it. npm run deploy
// and npm run db:migrate both fill that in first, into the gitignored
// wrangler.deploy.toml; these two were simply never moved across.
import { fileURLToPath } from 'node:url';
import { wrangler, writeConfig, dbName } from './deploy.mjs';

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Which file? e.g. node scripts/d1-run.mjs schema.sql');
    return 1;
  }
  try { writeConfig(); } catch (err) {
    console.error(err.message);
    return 1;
  }
  // relative, and resolved by the spawn against ROOT: an absolute path
  // under a folder with a space in it goes through a Windows shell badly
  const res = wrangler(
    ['d1', 'execute', dbName(), '--remote', '--config', 'wrangler.deploy.toml', '--file=' + file, '-y']
  );
  return res.status === 0 ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) process.exit(main());
