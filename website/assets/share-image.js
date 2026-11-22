// Pictures to paste into a chat: one team's receipt and the leaderboard.
// Drawn on a canvas so they look the same whatever page they are made
// from, in that page's theme. Loaded by the site (team pages, the live
// tab) and by the dashboard, which takes it from the site.
(function () {
  var FONT = '"Helvetica Neue", "SCS Heros", Helvetica, Arial, sans-serif';
  // the stand-in's files sit beside this script, wherever it was loaded from
  var FONT_DIR = (function () {
    var src = document.currentScript && document.currentScript.src;
    return src ? src.replace(/[^/]*$/, '') + 'fonts/' : '';
  })();
  // The site's paper and ink in each theme. A picture takes the theme of
  // the page it is made from (data.dark); the medals are the same in both.
  var THEMES = {
    light: { paper: '#ffffff', ink: '#111111', muted: '#616161', hair: '#e1e3e6', rule: '#111111' },
    dark: { paper: '#1b1b1b', ink: '#eeeeee', muted: '#a3a3a3', hair: '#333333', rule: '#6d6d6d' }
  };
  var PAPER, INK, MUTED, HAIR, RULE, DARK;
  function useTheme(dark) {
    var t = THEMES[dark ? 'dark' : 'light'];
    DARK = !!dark;
    PAPER = t.paper; INK = t.ink; MUTED = t.muted; HAIR = t.hair; RULE = t.rule;
  }
  useTheme(false);
  var MEDAL = { 1: ['#d9a300', '#111111'], 2: ['#b9bcc0', '#111111'], 3: ['#9c5f26', '#ffffff'] };
  var W = 640, PAD = 24, SCALE = 2, LOGO_H = 52;
  var TITLE = '700 26px ' + FONT, META = '400 14px ' + FONT, SITE = '700 14px ' + FONT;
  var NAME = '700 16px ' + FONT, BODY = '400 16px ' + FONT, FIG = '700 16px ' + FONT;
  var SUB = '400 15px ' + FONT, LABEL = '700 11px ' + FONT, LABEL_TRACK = 11 * 0.08;
  var SITE_LINE = ' · quests, submissions, event stats and the full tab';

  // grouped in thousands the way the site prints points, with a real minus
  function amountText(n) {
    var v = Math.round(Number(n || 0) * 100) / 100;
    var parts = String(Math.abs(v)).split('.');
    var s = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (parts[1] ? '.' + parts[1] : '');
    return v < 0 ? '\u2212' + s : s;
  }

  var measure = null;
  function widthOf(text, font) {
    if (!measure) measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    return measure.measureText(text).width;
  }

  // Breaks on ordinary spaces only, so a no-break space holds "MQ6-1 ×1"
  // together. A word wider than the column on its own is cut, starting
  // on the line already begun.
  function wrap(text, font, width) {
    var lines = [], line = '';
    String(text == null ? '' : text).split(/[ \t\r\n]+/).forEach(function (word) {
      if (!word) return;
      var next = line ? line + ' ' + word : word;
      if (widthOf(next, font) <= width) { line = next; return; }
      if (widthOf(word, font) <= width) { lines.push(line); line = word; return; }
      while (next.length > 1 && widthOf(next, font) > width) {
        var cut = next.length - 1;
        while (cut > 1 && widthOf(next.slice(0, cut), font) > width) cut--;
        lines.push(next.slice(0, cut).replace(/\s+$/, ''));
        next = next.slice(cut).replace(/^\s+/, '');
      }
      line = next;
    });
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function clamp(lines, max, font, width) {
    if (lines.length <= max) return lines;
    var last = lines.slice(max - 1).join(' ');
    while (last.length > 1 && widthOf(last + '…', font) > width) last = last.slice(0, -1);
    return lines.slice(0, max - 1).concat([last.replace(/[\s,·]+$/, '') + '…']);
  }

  function labelWidth(str) {
    var w = 0;
    for (var i = 0; i < str.length; i++) w += widthOf(str.charAt(i), LABEL);
    return w + LABEL_TRACK * (str.length - 1);
  }

  function discWidth(rank) {
    return Math.max(28, widthOf(String(rank), '700 14px ' + FONT) + 12);
  }

  // "3rd of 41" -> {rank: 3, rest: "of 41"}
  function parsePlace(place) {
    var m = /^\s*(\d+)(?:st|nd|rd|th)?\b\s*(.*)$/.exec(String(place || ''));
    return m ? { rank: Number(m[1]), rest: m[2] } : null;
  }

  // Records what to draw while the layout is worked out, so the canvas
  // can be made at the height the content comes to.
  function sheet() {
    var ops = [];
    var s = {
      text: function (str, font, colour, x, y, align) {
        ops.push(function (c) {
          c.font = font; c.fillStyle = colour; c.textAlign = align || 'left';
          c.fillText(str, x, y);
        });
      },
      rect: function (x, y, w, h, colour) {
        ops.push(function (c) { c.fillStyle = colour; c.fillRect(x, y, w, h); });
      },
      image: function (img, x, y, w, h) {
        ops.push(function (c) { c.drawImage(img, x, y, w, h); });
      },
      // tracked by hand: canvas letterSpacing is not everywhere yet
      label: function (str, x, y, align) {
        var at = align === 'right' ? x - labelWidth(str) : x;
        ops.push(function (c) {
          c.font = LABEL; c.fillStyle = MUTED; c.textAlign = 'left';
          var px = at;
          for (var i = 0; i < str.length; i++) {
            c.fillText(str.charAt(i), px, y);
            px += widthOf(str.charAt(i), LABEL) + LABEL_TRACK;
          }
        });
      },
      // a place as a route disc: medals for the first three, ink after
      disc: function (cx, cy, rank) {
        var medal = MEDAL[rank], fill = medal ? medal[0] : INK, ink = medal ? medal[1] : PAPER;
        var w = discWidth(rank), r = 14;
        ops.push(function (c) {
          c.fillStyle = fill;
          c.beginPath();
          c.arc(cx - w / 2 + r, cy, r, Math.PI / 2, Math.PI * 1.5);
          c.arc(cx + w / 2 - r, cy, r, Math.PI * 1.5, Math.PI / 2);
          c.closePath();
          c.fill();
          c.font = '700 14px ' + FONT; c.fillStyle = ink; c.textAlign = 'center';
          c.fillText(String(rank), cx, cy + 5);
        });
      },
      render: function (height) {
        var canvas = document.createElement('canvas');
        canvas.width = W * SCALE;
        canvas.height = Math.ceil(height) * SCALE;
        var c = canvas.getContext('2d');
        c.scale(SCALE, SCALE);
        c.fillStyle = PAPER;
        c.fillRect(0, 0, W, Math.ceil(height));
        c.textBaseline = 'alphabetic';
        ops.forEach(function (fn) { fn(c); });
        return canvas;
      }
    };
    return s;
  }

  // The logo, the title and the meta line. Caps meet the logo's top edge
  // and the meta line sits on its bottom edge.
  function logoWidth(logo) {
    return logo ? Math.round(LOGO_H * logo.naturalWidth / logo.naturalHeight) : 0;
  }
  function titleX(logo) {
    return PAD + (logo ? logoWidth(logo) + 16 : 0);
  }

  function header(s, logo, title, meta, rightW) {
    var top = PAD + 4;
    if (logo && DARK) {
      // the mark's black edge needs white beside it, as on the site
      s.rect(PAD, top, logoWidth(logo), LOGO_H, '#ffffff');
      var inset = 4, h = LOGO_H - inset * 2, w = Math.round(h * logo.naturalWidth / logo.naturalHeight);
      s.image(logo, PAD + (logoWidth(logo) - w) / 2, top + inset, w, h);
    } else if (logo) s.image(logo, PAD, top, logoWidth(logo), LOGO_H);
    var tx = titleX(logo);
    var room = W - PAD - tx - (rightW ? rightW + 24 : 0);
    var lines = wrap(title, TITLE, room);
    // a title with no line under it sits level with the middle of the logo
    var drop = !meta && lines.length === 1 ? 9 : 0;
    lines.forEach(function (line, i) { s.text(line, TITLE, INK, tx, top + 19 + drop + i * 32); });
    var y = Math.max(top + LOGO_H, top + 19 + (lines.length - 1) * 32 + 24);
    // below the right-hand block the meta line can run the full width
    var metaLines = wrap(meta, META, y - 11 > top + LOGO_H + 6 ? W - PAD - tx : room);
    metaLines.forEach(function (line, i) { s.text(line, META, MUTED, tx, y + i * 18); });
    return { top: top, bottom: y + (metaLines.length - 1) * 18 };
  }

  function colophon(s, y, site) {
    var lead = String(site || '');
    s.text(lead, SITE, INK, PAD, y);
    s.text(lead ? SITE_LINE : SITE_LINE.slice(3), META, MUTED, PAD + widthOf(lead, SITE), y);
  }

  // d: {team, total, place, site, dark, detail, quests: [{key, name, times, held: [{code, amount, label, worth}], worth}]}
  // detail is 'compact' (a quest's code, name and points), 'standard' (and
  // a line under it: its submissions and the codes it holds) or 'detailed'
  // (each code on a line of its own, indented, with what it came to; the
  // lines add up to the quest's figure). `compact: true` still means
  // 'compact'. A quest list where no row has `times` leaves the submission
  // counts out.
  function receipt(d, logo) {
    useTheme(d.dark);
    var s = sheet();
    var inner = W - PAD * 2;
    var quests = d.quests || [];
    var detail = d.detail || (d.compact ? 'compact' : 'standard');
    var withTimes = quests.some(function (q) { return q.times != null; });

    // Right of the name: the place (disc, then "of 41") as one unit and
    // the total as another, both on the total's line; "points" under
    // the total only.
    var TOTAL = '700 40px ' + FONT;
    var totalStr = amountText(d.total);
    var totalW = widthOf(totalStr, TOTAL);
    var place = parsePlace(d.place);
    var dw = place ? discWidth(place.rank) : 0;
    var restW = place && place.rest ? widthOf(place.rest, META) : 0;
    var unitW = place ? dw + (restW ? 6 + restW : 0) + 24 : 0;
    var rightW = Math.max(unitW + totalW, widthOf('points', META));
    // where the place would leave the name too narrow to hold a word, it
    // goes in the meta line as text instead
    if (place && W - PAD - titleX(logo) - 24 - rightW < 200) {
      place = null;
      unitW = 0;
      rightW = Math.max(totalW, widthOf('points', META));
    }
    // the place, when there was no room to draw it as a disc ("Did not finish" is never a disc)
    var meta = d.place && !place ? d.place : '';
    var head = header(s, logo, d.team, meta, rightW);

    s.text(totalStr, TOTAL, INK, W - PAD, head.top + 29, 'right');
    s.text('points', META, MUTED, W - PAD, head.top + LOGO_H, 'right');
    if (place) {
      var cy = head.top + 15, dx = W - PAD - totalW - unitW;
      s.disc(dx + dw / 2, cy, place.rank);
      if (restW) s.text(place.rest, META, MUTED, dx + dw + 6, cy + 5);
    }

    var figW = Math.max(labelWidth('POINTS'), widthOf(totalStr, '700 20px ' + FONT));
    var rows = quests.map(function (q) {
      var worth = amountText(q.worth);
      figW = Math.max(figW, widthOf(worth, FIG));
      var held = detail !== 'standard' ? '' : (q.held || []).map(function (h) {
        return (h.amount == null ? h.code : h.code + ' ×' + amountText(h.amount));
      }).join(', ');
      if (withTimes && q.times != null && detail === 'standard') {
        var count = q.times + ' submission' + (q.times === 1 ? '' : 's');
        held = held ? count + ' · ' + held : count;
      }
      // a code a line, when the quest has more than its own one code
      var codes = [];
      var list = q.held || [];
      if (detail === 'detailed' && (list.length > 1 || (list[0] && (list[0].code !== q.key || list[0].label)))) {
        codes = list.map(function (h) {
          var text = h.code + (h.label ? ' · ' + h.label : '') +
            (h.amount != null && Number(h.amount) !== 1 ? ' ×' + amountText(h.amount) : '');
          return { text: text, worth: h.worth == null ? '' : amountText(h.worth) };
        });
      }
      return { name: q.key === q.name || !q.name ? q.key : q.key + ' · ' + q.name, held: held, codes: codes, worth: worth };
    });
    var textW = inner - figW - 24;

    var y = head.bottom + 28;
    if (!rows.length) {
      s.text('No quests credited yet.', '400 15px ' + FONT, MUTED, PAD, y + 11);
      y += 11 + 24;
    } else {
      s.rect(PAD, y, inner, 2, RULE);
      s.label('QUEST', PAD, y + 21);
      s.label('POINTS', W - PAD, y + 21, 'right');
      s.rect(PAD, y + 31, inner, 1, HAIR);
      y += 32;
      rows.forEach(function (r, i) {
        var name = wrap(r.name, NAME, textW);
        var held = r.held ? wrap(r.held, SUB, textW) : [];
        var base = y + 24;
        name.forEach(function (line, j) { s.text(line, NAME, INK, PAD, base + j * 20); });
        var last = base + (name.length - 1) * 20;
        held.forEach(function (line, j) { s.text(line, SUB, MUTED, PAD, last + 20 + j * 20); });
        last += held.length * 20;
        // each code indented under the quest, its points at the right
        r.codes.forEach(function (c) {
          var lines = wrap(c.text, SUB, textW - 16);
          lines.forEach(function (line, j) { s.text(line, SUB, MUTED, PAD + 16, last + 20 + j * 20); });
          if (c.worth) s.text(c.worth, SUB, MUTED, W - PAD, last + 20, 'right');
          last += lines.length * 20;
        });
        s.text(r.worth, FIG, INK, W - PAD, base, 'right');
        y = last + 14;
        if (i < rows.length - 1) s.rect(PAD, y - 1, inner, 1, HAIR);
      });
    }
    s.rect(PAD, y, inner, 2, RULE);
    s.label('TOTAL', PAD, y + 30);
    s.text(totalStr, '700 20px ' + FONT, INK, W - PAD, y + 30, 'right');
    y += 30 + 40;
    colophon(s, y, d.site);
    return s.render(y + PAD);
  }

  // d: {title, site, dark, teams: [{rank, name, points, quests, dnf}]}
  // rank is null for a team that did not finish.
  function leaderboard(d, logo) {
    useTheme(d.dark);
    var s = sheet();
    var inner = W - PAD * 2;
    var teams = d.teams || [];
    var head = header(s, logo, d.title, '', 0);
    var y = head.bottom + 28;
    if (!teams.length) {
      s.text('No standings yet.', '400 15px ' + FONT, MUTED, PAD, y + 11);
      y += 11 + 40;
      colophon(s, y, d.site);
      return s.render(y + PAD);
    }

    // the sums close the table under the columns they add up, as on the live tab
    var sumPoints = 0, sumQuests = 0, anyQuests = false;
    teams.forEach(function (t) {
      sumPoints += Number(t.points || 0);
      if (t.quests != null && t.quests !== '') { anyQuests = true; sumQuests += Number(t.quests) || 0; }
    });
    var sumPointsStr = amountText(sumPoints), sumQuestsStr = anyQuests ? amountText(sumQuests) : '';
    var TEAM_X = PAD + Math.max(52, labelWidth('PLACE') + 12);
    var figW = Math.max(labelWidth('POINTS'), widthOf(sumPointsStr, FIG));
    teams.forEach(function (t) { figW = Math.max(figW, widthOf(amountText(t.points), FIG)); });
    var POINTS_R = W - PAD, QUESTS_R = W - PAD - Math.max(84, figW + 20);
    var nameW = QUESTS_R - Math.max(labelWidth('QUESTS'), widthOf(sumQuestsStr, FIG)) - 16 - TEAM_X;

    s.rect(PAD, y, inner, 2, RULE);
    s.label('PLACE', PAD, y + 21);
    s.label('TEAM', TEAM_X, y + 21);
    s.label('QUESTS', QUESTS_R, y + 21, 'right');
    s.label('POINTS', POINTS_R, y + 21, 'right');
    s.rect(PAD, y + 31, inner, 1, HAIR);
    y += 32;

    var anyDnf = false;
    teams.forEach(function (t, i) {
      var lines = clamp(wrap(t.name, NAME, nameW), 3, NAME, nameW);
      var base = y + 26;
      if (t.rank == null) s.text('–', FIG, MUTED, PAD + 14, base, 'center');
      else if (MEDAL[t.rank]) s.disc(PAD + 14, base - 6, t.rank);
      else s.text(String(t.rank), FIG, INK, PAD + 14, base, 'center');
      lines.forEach(function (line, j) { s.text(line, NAME, INK, TEAM_X, base + j * 20); });
      s.text(String(t.quests == null ? '' : t.quests), BODY, INK, QUESTS_R, base, 'right');
      s.text(amountText(t.points), FIG, INK, POINTS_R, base, 'right');
      // the mark hangs past the column's edge so the figures stay in line
      if (t.dnf) { anyDnf = true; s.text('*', FIG, INK, POINTS_R + 1, base, 'left'); }
      y += lines.length * 20 + 20;
      if (i < teams.length - 1) s.rect(PAD, y - 1, inner, 1, HAIR);
    });
    s.rect(PAD, y, inner, 2, RULE);
    s.label('TOTAL', TEAM_X, y + 30);
    if (sumQuestsStr) s.text(sumQuestsStr, FIG, INK, QUESTS_R, y + 30, 'right');
    s.text(sumPointsStr, FIG, INK, POINTS_R, y + 30, 'right');
    y += 30;
    if (anyDnf) {
      s.text('* Did not finish.', META, MUTED, PAD, y + 30);
      y += 30;
    }
    y += 40;
    colophon(s, y, d.site);
    return s.render(y + PAD);
  }

  // ---------- Getting a picture out ----------
  // The logo, loaded once per address and allowed to fail: the picture
  // is drawn without it rather than not at all.
  var logos = {};
  function loadLogo(src) {
    if (!src) return Promise.resolve(null);
    if (!logos[src]) {
      logos[src] = new Promise(function (resolve) {
        var img = new Image();
        var wait = setTimeout(function () {
          img.onload = img.onerror = null;
          delete logos[src];
          resolve(null);
        }, 4000);
        img.crossOrigin = 'anonymous';
        img.onload = function () { clearTimeout(wait); resolve(img); };
        img.onerror = function () { clearTimeout(wait); delete logos[src]; resolve(null); };
        img.src = src;
      });
    }
    return logos[src];
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('no image')); }, 'image/png');
    });
  }

  // kind: 'receipt' or 'leaderboard'. A logo another site will not let
  // a canvas give back leaves it unreadable, so it is drawn again
  // without one.
  // A canvas draws with whatever has loaded by then, so on a device
  // without Helvetica Neue the stand-in is loaded first: regular and
  // bold, and the Latin Extended files only for a picture with those
  // letters in it. A picture whose fonts do not come in four seconds is
  // drawn in the next face in the stack.
  function hasHelveticaNeue() {
    var c = document.createElement('canvas').getContext('2d');
    var probe = 'abcdefghijklmnopqrstuvwxyz0123456789';
    c.font = '40px monospace';
    var plain = c.measureText(probe).width;
    c.font = '40px "Helvetica Neue", monospace';
    return c.measureText(probe).width !== plain;
  }
  var fontsAsked = {};
  function loadFonts(data) {
    if (!FONT_DIR || !window.FontFace || !document.fonts || hasHelveticaNeue()) return Promise.resolve();
    var cuts = ['latin'];
    if (/[Ā-ʯḀ-ỿ]/.test(JSON.stringify(data || {}))) cuts.push('ext');
    var loads = [];
    cuts.forEach(function (cut) {
      ['regular', 'bold'].forEach(function (face) {
        var file = 'heros-' + face + '-' + cut + '.woff2';
        if (!fontsAsked[file]) {
          var f = new window.FontFace('SCS Heros', 'url("' + FONT_DIR + file + '") format("woff2")',
            { weight: face === 'bold' ? '700' : '400', ascentOverride: '95.2%', descentOverride: '21.3%', lineGapOverride: '2.8%' });
          document.fonts.add(f);
          fontsAsked[file] = f.load().catch(function () {});
        }
        loads.push(fontsAsked[file]);
      });
    });
    return Promise.race([Promise.all(loads), new Promise(function (r) { setTimeout(r, 4000); })]);
  }

  function png(kind, data, logoSrc) {
    var draw = kind === 'leaderboard' ? leaderboard : receipt;
    return Promise.all([loadLogo(logoSrc), loadFonts(data)]).then(function (got) {
      var logo = got[0];
      return toBlob(draw(data, logo)).catch(function () { return toBlob(draw(data, null)); });
    });
  }

  function saveFile(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // A PNG on its way (a promise) onto the clipboard, or saved as a file
  // where the browser will not allow that. Called inside the tap, with
  // the picture still a promise, so Safari counts the write as part of
  // it. Answers 'copied' or 'saved'.
  function copy(blob, filename) {
    function save() { return blob.then(function (b) { saveFile(b, filename); return 'saved'; }); }
    if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) return save();
    try {
      return navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
        .then(function () { return 'copied'; }, save);
    } catch (e) { return save(); }
  }

  // a name a file can carry
  function fileName(text) {
    return String(text || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() + '.png';
  }

  window.SCSShareImage = {
    receipt: receipt,
    leaderboard: leaderboard,
    logo: loadLogo,
    png: png,
    copy: copy,
    fileName: fileName
  };
})();
