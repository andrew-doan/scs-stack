#!/usr/bin/env node
// Draws the icons the confirmation email carries — beside its details,
// on its check-in note and in its two link buttons — into
// website/assets/email/, where the site serves them and the email
// links to them.
//
// Mail clients do not draw SVG, so each icon is a PNG: the same outline
// the ticket page draws inline (24 units, a 2-unit stroke, round ends),
// in the ink of the words beside it, on nothing, at three times its 24px.
// The Discord mark is Discord's own logo, filled, in the same ink: one
// colour like everything else in the buttons, which Discord's brand
// guidance allows.
//
// The ink is email-html.js's INK.text, read from the module. A file
// already sent in an email is linked from that email for good: change
// what one looks like by saving over it, and add a new name for a new
// icon.
//
// Under the ink each icon carries an outline in the colour of the ground
// it sits on (HALO_UNITS either side of the stroke). On that ground it
// cannot be seen. When a mail app darkens the message on its own — the
// Gmail apps do, ignoring the email's `color-scheme: light only` and
// telling it nothing, so no style can answer — the ground goes dark,
// the pictures stay as they are, and the outline is what keeps a dark
// icon visible on it.
// Run with: node scripts/email-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'website', 'assets', 'email');
const SIZE = 24;    // drawn in
const SCALE = 3;    // drawn at
const HALO_UNITS = 1.5;

// the ground each sits on: the note's grey box for the phone, the white
// sheet and buttons for the rest
const GROUND = { phone: 'tint' };

const LINE = {
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5"/>' +
    '<path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 13.8c2 .8 3.5 3 3.5 6.2"/>',
  date: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  place: '<path d="M12 21s-6.5-5.7-6.5-11a6.5 6.5 0 0 1 13 0c0 5.3-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M11 18.5h2"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
    '<path d="M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9s1.2-6.4 3.6-9z"/>'
};

const FILLED = {
  discord: '<path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .078-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.1.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/>'
};

(async () => {
  const { INK } = await import(path.join(__dirname, '..', 'src', 'email-html.ts'));
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ viewport: { width: 100, height: 100 }, deviceScaleFactor: SCALE });
  const draw = async (name, svg) => {
    await p.setContent('<body style="margin:0;background:transparent">' +
      '<svg id="icon" viewBox="0 0 24 24" width="' + SIZE + '" height="' + SIZE + '" style="display:block" ' + svg + '</svg></body>');
    const file = path.join(OUT, 'icon-' + name + '.png');
    await p.locator('#icon').screenshot({ path: file, omitBackground: true });
    console.log('wrote ' + path.relative(process.cwd(), file));
  };
  const halo = name => INK[GROUND[name] || 'card'];
  for (const name of Object.keys(LINE)) {
    await draw(name, 'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
      '<g stroke="' + halo(name) + '" stroke-width="' + (2 + 2 * HALO_UNITS) + '">' + LINE[name] + '</g>' +
      '<g stroke="' + INK.text + '" stroke-width="2">' + LINE[name] + '</g>');
  }
  // a filled mark runs to the edge of its box, so it is drawn a little
  // smaller to leave its outline room
  for (const name of Object.keys(FILLED)) {
    await draw(name, '><g transform="translate(12 12) scale(0.86) translate(-12 -12)">' +
      '<g fill="' + halo(name) + '" stroke="' + halo(name) + '" stroke-width="' + (2 * HALO_UNITS / 0.86) + '" stroke-linejoin="round">' + FILLED[name] + '</g>' +
      '<g fill="' + INK.text + '">' + FILLED[name] + '</g></g>');
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
