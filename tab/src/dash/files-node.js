// The dashboard's and the spinner's files under Node, where the suites run:
// Node has no Text modules, so they are read from disk once, when the
// worker is imported. files.js is the same thing for the deployed worker,
// and lists the script's parts in this order too.
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

export const CSS = read('./dash.css');
export const BODY = read('./dash.html');
// The page's script, a part to a file, in the order the parts run.
export const JS = [
  'core', 'markdown', 'uploads', 'preview', 'share', 'parts', 'tabs', 'signin', 'scores', 'recap',
  'queue', 'desk', 'ledger', 'map', 'tracks', 'quests', 'quest-order', 'quest-editor', 'asks', 'phone', 'teams',
  'messages', 'push', 'email', 'rego', 'drop', 'albums', 'discord', 'rolemenus', 'settings',
  'storage', 'privacy', 'slides', 'accounts', 'log', 'start'
].map((name) => [name, read('./js/' + name + '.js')]);
export const SPIN_CSS = read('./spinner.css');
export const SPIN_BODY = read('./spinner.html');
export const SPIN_JS = read('./spinner.js');
