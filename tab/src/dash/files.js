// The dashboard page's files and the spinner page's three as wrangler
// bundles them: the [[rules]] block in wrangler.toml makes each a Text
// module, whose default export is the file's text. package.json's
// "imports" sends '#dash-files' here under the workerd condition, which
// wrangler sets; Node gets files-node.js, which reads the same files
// from disk and lists the script's parts in the same order.
import CSS from './dash.css';
import BODY from './dash.html';
import CORE from './js/core.js';
import MARKDOWN from './js/markdown.js';
import UPLOADS from './js/uploads.js';
import PREVIEW from './js/preview.js';
import SHARE from './js/share.js';
import PARTS from './js/parts.js';
import TABS from './js/tabs.js';
import SIGNIN from './js/signin.js';
import SCORES from './js/scores.js';
import RECAP from './js/recap.js';
import QUEUE from './js/queue.js';
import DESK from './js/desk.js';
import LEDGER from './js/ledger.js';
import MAP from './js/map.js';
import TRACKS from './js/tracks.js';
import QUESTS from './js/quests.js';
import QUEST_ORDER from './js/quest-order.js';
import QUEST_EDITOR from './js/quest-editor.js';
import ASKS from './js/asks.js';
import PHONE from './js/phone.js';
import TEAMS from './js/teams.js';
import MESSAGES from './js/messages.js';
import PUSH from './js/push.js';
import EMAIL from './js/email.js';
import REGO from './js/rego.js';
import DROP from './js/drop.js';
import ALBUMS from './js/albums.js';
import DISCORD from './js/discord.js';
import ROLEMENUS from './js/rolemenus.js';
import SETTINGS from './js/settings.js';
import STORAGE from './js/storage.js';
import PRIVACY from './js/privacy.js';
import SLIDES from './js/slides.js';
import ACCOUNTS from './js/accounts.js';
import LOG from './js/log.js';
import START from './js/start.js';
import SPIN_CSS from './spinner.css';
import SPIN_BODY from './spinner.html';
import SPIN_JS from './spinner.js';

// The page's script, a part to a file, in the order the parts run.
export const JS = [
  ['core', CORE], ['markdown', MARKDOWN], ['uploads', UPLOADS], ['preview', PREVIEW], ['share', SHARE],
  ['parts', PARTS], ['tabs', TABS], ['signin', SIGNIN], ['scores', SCORES], ['recap', RECAP],
  ['queue', QUEUE], ['desk', DESK], ['ledger', LEDGER], ['map', MAP], ['tracks', TRACKS], ['quests', QUESTS],
  ['quest-order', QUEST_ORDER], ['quest-editor', QUEST_EDITOR], ['asks', ASKS], ['phone', PHONE], ['teams', TEAMS],
  ['messages', MESSAGES], ['push', PUSH], ['email', EMAIL], ['rego', REGO], ['drop', DROP],
  ['albums', ALBUMS], ['discord', DISCORD], ['rolemenus', ROLEMENUS], ['settings', SETTINGS],
  ['storage', STORAGE], ['privacy', PRIVACY], ['slides', SLIDES], ['accounts', ACCOUNTS], ['log', LOG], ['start', START]
];

export { CSS, BODY, SPIN_CSS, SPIN_BODY, SPIN_JS };
