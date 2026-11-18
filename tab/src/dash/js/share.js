// The receipt and the standings as pictures to paste into a chat, drawn
// by the site's share-image.js.
(function (dash) {
  // core.js
  var h = dash.h, SITE = dash.SITE, toast = dash.toast;

  dash.shareImageLib = shareImageLib;
  dash.nowStamp = nowStamp;
  dash.receiptDetail = receiptDetail;
  dash.copyReceipt = copyReceipt;
  dash.copyStandings = copyStandings;

  // ---- pictures to paste into a chat ----
  // The receipt and the standings are drawn by the site's
  // share-image.js, so a team's own copy from its team page and the one
  // sent from here look the same. It is loaded from the site the first
  // time either is wanted.
  var shareLib = null;
  function shareImageLib() {
    if (window.SCSShareImage) return Promise.resolve(window.SCSShareImage);
    if (!shareLib) {
      shareLib = new Promise(function (resolve) {
        var tag = h('script');
        tag.src = SITE + '/assets/share-image.js';
        tag.onload = function () { resolve(window.SCSShareImage || null); };
        tag.onerror = function () { shareLib = null; resolve(null); };
        document.head.appendChild(tag);
      });
    }
    return shareLib;
  }
  function nowStamp() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
  function siteHost() { return SITE.replace(/^https?:\/\//, ''); }
  // a picture is drawn in the theme the dashboard is showing, which is
  // the device's
  function darkNow() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  // How much a receipt shows: quests only, with the codes under each, or
  // each code on a line of its own with its points; kept on this device.
  // The tick box before it kept '1' for quests only.
  var RECEIPT_DETAIL = dash.RECEIPT_DETAIL = 'scs2-dash-receipt-detail';
  function receiptDetail() {
    try {
      return localStorage.getItem(RECEIPT_DETAIL) ||
        (localStorage.getItem('scs2-dash-receipt-compact') === '1' ? 'compact' : 'standard');
    } catch (e) { return 'standard'; }
  }

  // Onto the clipboard as a PNG; where the browser will not allow that,
  // saved as a file. The write starts inside the click with the picture
  // still a promise, which is what Safari needs, so this cannot wait for
  // the script or the data (which may be a promise too) to arrive first.
  function copyPicture(kind, data, filename, what) {
    var blob = Promise.resolve(data).then(function (d) {
      return shareImageLib().then(function (lib) {
        if (!lib) throw new Error('no picture script');
        return lib.png(kind, d, SITE + '/assets/icons/logo-256.png');
      });
    });
    function save() {
      return blob.then(function (b) {
        var a = h('a');
        a.href = URL.createObjectURL(b);
        a.download = filename.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        return 'saved';
      });
    }
    var going;
    if (!navigator.clipboard || !navigator.clipboard.write || !window.ClipboardItem) going = save();
    else {
      try {
        going = navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).then(function () { return 'copied'; }, save);
      } catch (e) { going = save(); }
    }
    going.then(function (how) {
      toast(what + (how === 'copied' ? ' copied as an image.' : ' saved as an image.'));
    }, function () { toast(what + ' could not be drawn.', true); });
  }

  // A code that is not on the tab any more holds nothing, so it is left
  // out of the picture.
  function copyReceipt(d) {
    copyPicture('receipt', {
      team: d.team.name,
      total: d.total,
      place: null,
      site: siteHost(),
      dark: darkNow(),
      detail: receiptDetail(),
      quests: d.quests.filter(function (q) { return !q.gone; }).map(function (q) {
        return { key: q.key, name: q.name, times: q.times, worth: q.worth, held: q.held };
      })
    }, 'Receipt ' + d.team.name, 'Receipt');
  }

  // board: a promise of {teams, at}, the live standings or a saved copy
  function copyStandings(board) {
    copyPicture('leaderboard', board.then(function (b) {
      return {
        title: 'SCS.2 Leaderboard',
        site: siteHost(),
        dark: darkNow(),
        teams: b.teams.map(function (t) {
          return { rank: t.rank, name: t.name, points: t.points, quests: t.quests_done, dnf: !!t.dnf };
        })
      };
    }), 'SCS.2 standings', 'Standings');
  }
})(window.dash);
