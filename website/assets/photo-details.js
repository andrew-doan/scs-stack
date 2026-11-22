/* What a photo or video says about itself, as the rows of a details
   panel: when it was taken, the camera and its settings, the file,
   where, and who added it. Built from the answer /api/albums/info gives,
   for the album page's viewer and a shared photo's page, which loads it
   from the site. Each row is {icon, title, lines, href, link}. */
(function () {
  'use strict';

  var ICONS = {
    when: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4"/><path d="M16 3v4"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8A1.5 1.5 0 0 1 4.5 6.5h2.6l1.7-2.2h6.4l1.7 2.2h2.6A1.5 1.5 0 0 1 21 8v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V8z"/><circle cx="12" cy="12.5" r="3.75"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9" r="1.75"/><path d="m20.5 15.5-5-5-11 10"/></svg>',
    place: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    who: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></svg>'
  };

  // the site's 24-hour setting where the site's helpers are on the page
  function clock() {
    return window.scs && window.scs.hour24 && window.scs.hour24()
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : { hour: 'numeric', minute: '2-digit' };
  }

  // The time it was taken, on the clock where it was taken when the
  // phone wrote its zone, else on this device's.
  function takenText(utc, offset) {
    var at = Date.parse(String(utc).replace(' ', 'T') + 'Z');
    if (!isFinite(at)) return null;
    var off = /^([+-])(\d{2}):(\d{2})$/.exec(offset || '');
    var opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    var hours = clock();
    if (off) {
      var shift = (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000;
      var local = new Date(at + shift);
      opts.timeZone = 'UTC';
      hours.timeZone = 'UTC';
      return {
        day: local.toLocaleDateString(undefined, opts),
        time: local.toLocaleTimeString(undefined, hours) + ' · GMT' + off[1] + off[2] + ':' + off[3]
      };
    }
    var d = new Date(at);
    return { day: d.toLocaleDateString(undefined, opts), time: d.toLocaleTimeString(undefined, hours) };
  }

  // when it was added: the site's own formatter where it is loaded
  function addedText(at) {
    if (!at) return '';
    if (window.scs && window.scs.fmtTime) return window.scs.fmtTime(at);
    var t = Date.parse(String(at).replace(' ', 'T') + 'Z');
    if (!isFinite(t)) return String(at);
    var hours = clock();
    var opts = { day: 'numeric', month: 'short', hour: hours.hour, minute: '2-digit' };
    if (hours.hourCycle) opts.hourCycle = hours.hourCycle;
    return new Date(t).toLocaleString(undefined, opts);
  }

  function sizeText(bytes) {
    if (!bytes) return '';
    if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function exposureText(s) {
    if (!s) return '';
    if (s >= 1) return (Math.round(s * 10) / 10) + 's';
    return '1/' + Math.round(1 / s);
  }

  function rows(d, video) {
    var out = [];
    var when = d.taken ? takenText(d.taken, d.offset) : null;
    if (when) out.push({ icon: ICONS.when, title: when.day, lines: [when.time] });
    var settings = [
      d.fnumber ? 'ƒ/' + d.fnumber : '',
      exposureText(d.exposure),
      d.focal ? d.focal + 'mm' : '',
      d.iso ? 'ISO ' + d.iso : ''
    ].filter(Boolean).join(' · ');
    if (d.camera || settings) {
      out.push({ icon: ICONS.camera, title: d.camera || 'Camera', lines: [d.lens && d.lens !== d.camera ? d.lens : '', settings] });
    }
    var shape = d.w && d.h ? (video ? '' : (Math.round(d.w * d.h / 100000) / 10) + 'MP · ') + d.w + ' × ' + d.h : '';
    out.push({ icon: ICONS.file, title: d.name || (video ? 'Video' : 'Photo'), lines: [[shape, sizeText(d.bytes)].filter(Boolean).join(' · ')] });
    if (d.gps) {
      var lat = Number(d.gps.lat).toFixed(5);
      var lng = Number(d.gps.lng).toFixed(5);
      out.push({
        icon: ICONS.place, title: lat + ', ' + lng,
        lines: [d.gps.alt != null ? Math.round(d.gps.alt) + ' m above sea level' : ''],
        href: 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng, link: 'Open in Maps'
      });
    }
    out.push({
      icon: ICONS.who, title: d.by ? 'Added by ' + d.by : 'Added',
      lines: [d.quest ? 'Sent for ' + d.quest : '', addedText(d.at)]
    });
    return out;
  }

  window.scsPhotoDetails = { rows: rows };
})();
