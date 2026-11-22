// The dashboard page, served by the worker at /dash. One page,
// tabs for scores, teams, quests, review, registrations, discord, push
// and the log. It holds a session token and nothing else — the
// password and every check live server-side, and all data lands in
// the DOM via textContent.
//
// The page is files in src/dash/: dash.css, dash.html (what goes inside
// <body>) and the script, a part to a file in src/dash/js/. consolePage()
// puts them into one document, so the browser gets the styles and the
// script inline in one response: the parts joined into one script in the
// order JS lists them, each a function of its own sharing window.dash.
// '#dash-files' is package.json's "imports" entry: when wrangler bundles
// the worker it is src/dash/files.js, which imports them as Text modules
// (the [[rules]] block in wrangler.toml); under Node, where the suites
// run, it is src/dash/files-node.js, which reads them from disk.
import { CSS, BODY, JS, SPIN_CSS, SPIN_BODY, SPIN_JS } from '#dash-files';

const SCRIPT = JS.map(function (part) { return part[1]; }).join('\n');

// The Turnstile site key is public by definition — it is what the
// widget is rendered with — so it rides in the document rather than
// costing an unauthenticated endpoint of its own. On an attribute
// rather than written into the script, so the script is served as the
// files are: these two attributes are all the worker fills in.
export function consolePage(turnstileSiteKey, publicApi) {
  var key = String(turnstileSiteKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  // where the public reads files, for the links the preview copies
  var files = /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(String(publicApi || '').replace(/\/+$/, '')) ? String(publicApi).replace(/\/+$/, '') : '';
  return '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<meta name="robots" content="noindex" />\n' +
    '<title>SCS.2 dashboard</title>\n' +
    // loaded without blocking: the console must open even when the font host is slow or unreachable
    '<link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@500;700&display=swap" onload="this.onload=null;this.rel=\'stylesheet\'" />\n' +
    '<style>\n' + CSS + '</style>\n' +
    '</head>\n<body data-turnstile="' + key + '" data-files="' + files + '">\n\n' + BODY + '\n' +
    '<script>\n\n' + SCRIPT + '\n</script>\n' +
    '</body>\n</html>\n';
}

// The spinner page at /dash/spinner: a wheel for drawing a team at
// random, each team's chance its share of the points. It is the
// dashboard's stylesheet with its own parts on top, and the dashboard's
// sign-in, read from the same place in the browser; it asks the worker
// for the board's team names and points and for nothing else, so it can
// go on a screen in front of everyone.
export function spinnerPage() {
  return '<!doctype html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<meta name="robots" content="noindex" />\n' +
    '<title>SCS.2 spinner</title>\n' +
    '<style>\n' + CSS + SPIN_CSS + '</style>\n' +
    '</head>\n<body class="sp-page">\n\n' + SPIN_BODY + '\n' +
    '<script>\n\n' + SPIN_JS + '\n</script>\n' +
    '</body>\n</html>\n';
}
