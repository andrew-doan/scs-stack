// Run with: node tests/verify-email.cjs
// Needs playwright installed nearby (npm i playwright) and a Chromium
// (CHROMIUM_PATH env, or /opt/pw-browsers/chromium).
//
// The confirmation email in an actual renderer. verify-email.mjs reads
// the markup; this one looks at what the markup does, which is the only
// way to catch the fault it was written for: the ticket frame carried a
// width="320" attribute, and an HTML table's width attribute is also
// its smallest width — so on a 380px phone the frame could not shrink
// and shoved the whole message 8px sideways. Every string check passed.
//
// An email client is not Chromium and this proves nothing about
// Outlook. What it does prove is that the message holds together in an
// engine that follows the rules, which is the floor, and that nothing
// runs off the side at phone width, which is the failure people
// actually see.
const { chromium } = require('playwright');
const { writeFileSync, mkdtempSync, existsSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

(async () => {
  const { regoEmail } = await import('../src/rego.ts');
  const dir = mkdtempSync(join(tmpdir(), 'scs-email-'));
  const lead = { name: 'Alex Nguyen' };
  const member = {
    name: 'Alex Nguyen', email: 'a@example.com', position: 1,
    qr_url: 'https://checkin.example/qr/abc.png'
  };
  const pages = {
    ticket: regoEmail(member, lead, 'Night Owls').html,
    // a long name and a long team, because those are what push a fixed
    // width past the edge
    long: regoEmail(
      { name: 'Alexandra Constantinopoulos', email: 'a@example.com', position: 1, qr_url: member.qr_url },
      lead, 'The Considerably Longer Team Name').html,
    banner: regoEmail(member, lead, 'Night Owls', { banner: 'https://files.example/t.gif' }).html,
    nocode: regoEmail({ name: 'Sam Lee', email: 's@example.com', position: 2 }, lead, 'Night Owls').html
  };
  for (const name of Object.keys(pages)) writeFileSync(join(dir, name + '.html'), pages[name]);

  const exe = process.env.CHROMIUM_PATH ||
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const browser = await chromium.launch(exe ? { executablePath: exe } : {});
  const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });

  // Nothing in an email may reach the network from here, and the two
  // pictures are the whole point of the layout, so they are stood in
  // for at the size the real ones are.
  await page.route('**/qr/*.png', r => r.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">' +
      '<rect width="220" height="220" fill="#000"/></svg>'
  }));
  await page.route('**/assets/email/header-banner.png', r => r.fulfill({
    status: 200, contentType: 'image/png',
    body: require('fs').readFileSync(join(__dirname, '..', '..', 'website', 'assets', 'email', 'header-banner.png'))
  }));
  await page.route('**/t.gif', r => r.fulfill({
    status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 400">' +
      '<rect width="1200" height="400" fill="#131313"/></svg>'
  }));

  const overflow = async () => page.evaluate(() => {
    const wide = [];
    document.querySelectorAll('*').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.right > window.innerWidth + 0.5 || r.left < -0.5) {
        wide.push(el.tagName + ' ' + Math.round(r.left) + '+' + Math.round(r.width));
      }
    });
    return { wide: wide.slice(0, 4), scroll: document.body.scrollWidth, view: window.innerWidth };
  });

  // 320 is a narrow phone in portrait; 700 is a desktop reading pane.
  for (const width of [320, 380, 700]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of Object.keys(pages)) {
      await page.goto('file://' + join(dir, name + '.html'));
      await page.waitForTimeout(120);
      const o = await overflow();
      check('the ' + name + ' message fits a ' + width + 'px screen',
        o.wide.length === 0 && o.scroll <= o.view,
        o.wide.join(', ') || (o.scroll > o.view ? o.scroll + ' wide in ' + o.view : ''));
    }
  }

  await page.setViewportSize({ width: 700, height: 1000 });
  await page.goto('file://' + join(dir, 'ticket.html'));
  await page.waitForTimeout(150);

  // The sheet is a fixed 600 on a wide screen, centred on the paper.
  const sheet = await page.evaluate(() => {
    const el = document.querySelector('.sheet');
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) };
  });
  check('on a wide screen the sheet holds at 600 and sits centred',
    sheet.width === 600 && Math.abs(sheet.left - sheet.right) <= 1, JSON.stringify(sheet));

  // The stripe: five equal runs of colour, top and bottom.
  const stripes = await page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('td[bgcolor]').forEach(td => {
      if (td.getAttribute('height') !== '5') return;
      const r = td.getBoundingClientRect();
      rows.push({ colour: td.getAttribute('bgcolor'), w: Math.round(r.width), y: Math.round(r.top) });
    });
    return rows;
  });
  const ys = Array.from(new Set(stripes.map(s => s.y)));
  check('the five routes run along the top and the bottom, in equal widths',
    stripes.length === 10 && ys.length === 2 &&
    new Set(stripes.map(s => s.w)).size === 1 &&
    stripes.slice(0, 5).map(s => s.colour).join(',') === '#ee352e,#ff6319,#fccc0a,#00933c,#0039a6',
    stripes.length + ' cells, widths ' + Array.from(new Set(stripes.map(s => s.w))).join('/'));

  // The code has to be big enough to scan off a phone held up to a
  // scanner. Anything under about 180 across starts to fail in poor light.
  const qr = await page.evaluate(() => {
    const img = document.querySelector('img[alt="Your check-in QR code"]');
    const r = img.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('the code is drawn big enough to scan', qr.w >= 200 && qr.w === qr.h, JSON.stringify(qr));

  // A button whose whole rectangle is not the link is a button people
  // miss the edge of.
  const button = await page.evaluate(() => {
    const a = Array.from(document.querySelectorAll('a')).find(x => x.textContent === 'Open your ticket');
    const cell = a.closest('td').getBoundingClientRect();
    const link = a.getBoundingClientRect();
    return {
      covered: Math.round(link.width) >= Math.round(cell.width) - 1 &&
        Math.round(link.height) >= Math.round(cell.height) - 1,
      colour: getComputedStyle(a.closest('td')).backgroundColor,
      href: a.getAttribute('href')
    };
  });
  check('the whole green rectangle is the link, not just the words',
    button.covered && button.colour === 'rgb(0, 147, 60)' &&
    button.href.indexOf('https://scs.andyrew.space/ticket/?') === 0,
    JSON.stringify({ covered: button.covered, colour: button.colour }));

  // Black on the bar, black on the plate, ink on paper in the card:
  // the contrasts the design depends on, measured rather than assumed.
  const contrast = await page.evaluate(() => {
    const lum = c => {
      const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(n => {
        const v = n / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // the nearest painted surface behind the text, the way an eye sees
    // it: transparent boxes are looked through until one has a colour
    const ratio = el => {
      let bg = el;
      let colour = 'rgba(0, 0, 0, 0)';
      while (bg) {
        colour = getComputedStyle(bg).backgroundColor;
        if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') break;
        bg = bg.parentElement;
      }
      if (!bg) colour = 'rgb(255, 255, 255)';
      const a = lum(getComputedStyle(el).color);
      const b = lum(colour);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10;
    };
    // the innermost element that carries the words, so the colour read
    // is the one the words are actually painted in
    const find = text => Array.from(document.querySelectorAll('td, div, p, a'))
      .filter(el => el.textContent.indexOf(text) !== -1).pop();
    const of = text => {
      const el = find(text);
      return el ? ratio(el) : 'not found';
    };
    return {
      plate: of('Night Owls'),
      label: of('TEAM'),
      body: of('You are registered'),
      note: of('Questions?')
    };
  });
  const poor = Object.keys(contrast).filter(k => !(contrast[k] >= 4.5));
  check('every piece of type clears 4.5:1 against what is behind it',
    poor.length === 0, JSON.stringify(contrast));

  await browser.close();
  console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
