/* A row of the event's own photographs, on any page that asks for one.
   ------------------------------------------------------------------
   Mark the place with `<ul class="photo-strip" data-photo-strip hidden>`
   and this fills it from the same pictures the home page's slideshow
   plays. With none uploaded the element stays hidden and the page is
   what it was — the same rule the slideshow follows, so a site with no
   photographs has no empty frames in it.

   It reads the copy the home page kept in localStorage first, so a
   reader who has been to the home page sees the row at the first paint,
   and asks the worker behind that. It writes nothing: the home page
   owns that key, and two writers of one cache is how the two disagree. */
(function () {
  var KEY = 'scs2-slides-cache';
  var HOST = 'https://files.scs.andyrew.space';
  var MAX = 5;

  var spots = document.querySelectorAll('[data-photo-strip]');
  if (!spots.length) return;

  function api() { return (window.scs && window.scs.TAB_API) || HOST; }
  // site.js's read that tries again when the network drops the first
  // request, where site.js is on the page
  function get(url, opts) {
    return window.scs && window.scs.fetch ? window.scs.fetch(url, opts) : fetch(url, opts);
  }

  // the point each picture is cropped around, in percent; the middle
  // when the list does not say
  function point(v) {
    var n = Number(v);
    return v == null || v === '' || !isFinite(n) ? 50 : Math.max(0, Math.min(100, n));
  }

  function clean(list) {
    if (!list || typeof list.length !== 'number') return [];
    var out = [];
    for (var i = 0; i < list.length && out.length < MAX; i++) {
      var s = list[i] || {};
      if (!s.key) continue;
      out.push({ key: String(s.key), alt: s.alt == null ? '' : String(s.alt), at: point(s.x) + '% ' + point(s.y) + '%' });
    }
    return out;
  }

  // Either the bare array an older build wrote or {slides, step}.
  function stored() {
    var raw;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); }
    catch (err) { return []; }
    if (raw && !raw.length && raw.slides) return clean(raw.slides);
    return clean(raw);
  }

  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].key !== b[i].key || a[i].at !== b[i].at) return false;
    return true;
  }

  var showing = [];

  function draw(list) {
    if (same(list, showing)) return;
    showing = list;
    for (var s = 0; s < spots.length; s++) {
      var node = spots[s];
      node.textContent = '';
      for (var i = 0; i < list.length; i++) {
        var li = document.createElement('li');
        var img = document.createElement('img');
        img.alt = list[i].alt;
        img.style.objectPosition = list[i].at;
        img.draggable = false;
        // the shared image cache in sw.js can only keep what it may read
        img.crossOrigin = 'anonymous';
        li.appendChild(img);
        // the thumbnail: these are shown a few hundred pixels across, and
        // the whole photograph is what the slideshow is for; the row
        // scrolls sideways by itself, which the page's observer cannot see into
        var thumb = api() + '/api/slides/file?key=' + encodeURIComponent(list[i].key) + '&thumb=1';
        if (window.scs && window.scs.keepPicture) window.scs.keepPicture(img, thumb, { near: false });
        else { img.loading = 'lazy'; img.src = thumb; }
        node.appendChild(li);
      }
      node.hidden = !list.length;
    }
  }

  draw(stored());

  get(api() + '/api/slides', { cache: 'no-cache' }).then(function (r) {
    return r.ok ? r.json() : null;
  }).then(function (d) {
    if (d && d.ok) draw(clean(d.slides));
  }).catch(function () { /* whatever is on screen stands */ });
})();
