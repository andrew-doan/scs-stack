// Run with: node tests/verify-sw-push.cjs
// The service worker's push half, run in a stubbed worker global so it
// can be checked without a real push service: every push shows a
// visible notification (iOS revokes silent ones), and a tap resolves
// the pushed link against the registration's own scope — which is what
// lets one push work on the live site, a Netlify deploy preview or a
// local server without knowing which it landed on.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

const SW = fs.readFileSync(path.join(__dirname, '..', '..', 'website', 'sw.js'), 'utf8');

// Loads sw.js against a fake worker global and returns its handlers.
function loadWorker(scope, windows) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const navigated = [];
  // a window is its address, or {url, uncontrolled} for one this worker
  // does not control, which navigate() refuses
  const clientList = (windows || []).map(w => ({
    url: w.url || w,
    navigate(to) {
      if (w.uncontrolled) return Promise.reject(new TypeError('not controlled by this worker'));
      navigated.push(to); this.url = to; return Promise.resolve(this);
    },
    focus() { this.focused = true; return Promise.resolve(this); }
  }));
  const clients = {
    matchAll: () => Promise.resolve(clientList),
    openWindow(url) { opened.push(url); return Promise.resolve(null); }
  };
  const self = {
    addEventListener: (name, fn) => { handlers[name] = fn; },
    registration: {
      scope,
      showNotification(title, opts) { shown.push({ title, opts }); return Promise.resolve(); }
    },
    location: { origin: new URL(scope).origin },
    clients
  };
  const ctx = { self, clients, caches: { open: () => Promise.resolve({}), keys: () => Promise.resolve([]) }, fetch: () => Promise.resolve(), URL, Response: class {}, console };
  vm.createContext(ctx);
  vm.runInContext(SW, ctx);
  return { handlers, shown, opened, navigated, clientList };
}

const waits = [];
const evt = extra => Object.assign({ waitUntil: p => waits.push(p) }, extra);

(async () => {
  // ---- push always shows something ----
  let w = loadWorker('https://scs.andyrew.space/');
  w.handlers.push(evt({ data: { json: () => ({ title: 'Briefing 3', body: 'Check the list.', url: '/questlist/' }) } }));
  await Promise.all(waits.splice(0));
  check('a push shows a visible notification with its title and body',
    w.shown.length === 1 && w.shown[0].title === 'Briefing 3' && w.shown[0].opts.body === 'Check the list.',
    JSON.stringify(w.shown[0]));
  check('the pushed link is carried on the notification',
    w.shown[0].opts.data.url === '/questlist/', JSON.stringify(w.shown[0].opts.data));

  w = loadWorker('https://scs.andyrew.space/');
  w.handlers.push(evt({ data: { json() { throw new Error('not json'); }, text: () => 'plain words' } }));
  await Promise.all(waits.splice(0));
  check('a malformed push still shows something rather than staying silent',
    w.shown.length === 1 && w.shown[0].title === 'SCS.2' && w.shown[0].opts.body === 'plain words',
    JSON.stringify(w.shown[0]));

  // ---- clicking resolves the link against this deployment's scope ----
  const preview = 'https://deploy-preview-1--scs.netlify.app/';
  w = loadWorker(preview, [preview + 'welfare/']);
  w.handlers.notificationclick(evt({ notification: { close() {}, data: { url: '/questlist/' } } }));
  await Promise.all(waits.splice(0));
  check('on a deploy preview the link opens on that preview, not the live domain',
    w.navigated.length === 1 && w.navigated[0] === preview + 'questlist/', JSON.stringify(w.navigated));

  w = loadWorker('https://scs.andyrew.space/', ['https://scs.andyrew.space/welfare/']);
  w.handlers.notificationclick(evt({ notification: { close() {}, data: { url: '/questlist/' } } }));
  await Promise.all(waits.splice(0));
  check('the same push resolves to the live site when that is where it landed',
    w.navigated[0] === 'https://scs.andyrew.space/questlist/', JSON.stringify(w.navigated));

  // ---- a window the worker does not control cannot be moved ----
  w = loadWorker('https://scs.andyrew.space/', [{ url: 'https://scs.andyrew.space/welfare/', uncontrolled: true }]);
  w.handlers.notificationclick(evt({ notification: { close() {}, data: { url: '/questlist/' } } }));
  await Promise.all(waits.splice(0));
  check('a window the worker does not control refuses to move, so the link opens in a new one',
    w.navigated.length === 0 && w.opened.length === 1 && w.opened[0] === 'https://scs.andyrew.space/questlist/',
    JSON.stringify({ navigated: w.navigated, opened: w.opened }));

  // ---- windows belonging to another origin are left alone ----
  w = loadWorker(preview, ['https://scs.andyrew.space/welfare/']);
  w.handlers.notificationclick(evt({ notification: { close() {}, data: { url: '/questlist/' } } }));
  await Promise.all(waits.splice(0));
  check('a window from a different deployment is never hijacked',
    w.navigated.length === 0 && w.opened.length === 1 && w.opened[0] === preview + 'questlist/',
    JSON.stringify({ navigated: w.navigated, opened: w.opened }));

  // ---- no link: bring the app forward where it already is ----
  // dispatched through the real push handler, since it is the one that
  // decides what a link-less notification carries
  w = loadWorker(preview, [preview + 'tab/']);
  w.handlers.push(evt({ data: { json: () => ({ title: 'Heads up', body: 'Weather turning.' }) } }));
  await Promise.all(waits.splice(0));
  w.handlers.notificationclick(evt({ notification: { close() {}, data: w.shown[0].opts.data } }));
  await Promise.all(waits.splice(0));
  check('a link-less push focuses the app without yanking the reader elsewhere',
    w.navigated.length === 0 && w.clientList[0].focused === true &&
    w.clientList[0].url === preview + 'tab/', JSON.stringify(w.navigated));

  // ---- nothing open at all ----
  w = loadWorker(preview, []);
  w.handlers.notificationclick(evt({ notification: { close() {}, data: { url: '/gallery/' } } }));
  await Promise.all(waits.splice(0));
  check('with nothing open it opens a window on the pushed link',
    w.opened.length === 1 && w.opened[0] === preview + 'gallery/', JSON.stringify(w.opened));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  process.exit(fail === 0 ? 0 : 1);
})();
