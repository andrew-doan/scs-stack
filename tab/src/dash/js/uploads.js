// Files on their way up: straight to storage in slices when the worker
// can sign for them, a name typed over each before it goes, HEIC and WebP
// redrawn, the EXIF copied into a JPEG, the small and viewing copies, and
// the kinds of proof file a quest takes.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, h = dash.h, post = dash.post, session = dash.session, toast = dash.toast;

  dash.uploadMode = uploadMode;
  dash.putSlice = putSlice;
  dash.waitOutLimit = waitOutLimit;
  dash.limitedJson = limitedJson;
  dash.stageFiles = stageFiles;
  dash.ptKindOf = ptKindOf;
  dash.appendProof = appendProof;
  dash.sendName = sendName;
  dash.renameRow = renameRow;
  dash.sizeText = sizeText;
  dash.needsConverting = needsConverting;
  dash.toJpeg = toJpeg;
  dash.pngPicks = pngPicks;
  dash.jpegPicks = jpegPicks;
  dash.imageThumb = imageThumb;

  // ---------- files straight to storage ----------
  // With the worker's R2 token set, a file goes from here to the bucket
  // in slices, each to an address the worker signs, and the save that
  // follows names it by its id (staged<i>) instead of carrying it.
  // Without the token a save carries its files as before.
  var uploadModeAsked = null;
  function uploadMode() {
    if (!uploadModeAsked) {
      uploadModeAsked = api('/api/console/upload/mode').then(function (d) {
        return d && d.ok ? d : { direct: false };
      }, function () {
        uploadModeAsked = null;
        return { direct: false };
      });
    }
    return uploadModeAsked;
  }

  // one slice to its signed address: no headers, so the bucket's CORS
  // rule only has to allow PUT
  function putSlice(url, blob, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        reject({ error: 'Storage answered ' + xhr.status + '.' });
      };
      xhr.onerror = function () { reject({ error: 'Could not reach storage.' }); };
      xhr.send(blob);
    });
  }

  // Cloudflare turns an account's requests away for a minute when it
  // sends too many (a 429, its error 1015), so an upload waits and asks
  // again rather than failing. ask() resolves {status: 429} for one;
  // onWait hears how many seconds the wait is.
  var LIMITED_WAITS = [20, 40, 60, 60];
  function waitOutLimit(ask, onWait) {
    var tries = 0;
    function go() {
      return ask().then(function (res) {
        if (!res || res.status !== 429 || tries >= LIMITED_WAITS.length) return res;
        var secs = LIMITED_WAITS[tries++];
        onWait(secs);
        return new Promise(function (resolve) { setTimeout(resolve, secs * 1000); }).then(go);
      });
    }
    return go();
  }
  // a fetch's answer read as api() reads one, a 429 included
  function limitedJson(r) { return r.status === 429 ? { status: 429, error: dash.LIMITED } : r.json(); }
  function saysWaiting(secs) { toast('Too many requests right now. Trying again in ' + secs + ' seconds.'); }

  // One file into the bucket for what it is for (msg, qst, slide, drop,
  // points). Resolves its id; onProgress hears the share sent so far.
  function stageFile(file, purpose, onProgress) {
    onProgress = onProgress || function () {};
    return waitOutLimit(function () {
      return post('/api/console/upload/start', {
        purpose: purpose, name: file.name, type: file.type, size: file.size
      });
    }, saysWaiting).then(function (u) {
      if (!u || !u.ok) throw u || {};
      function slice(n, tries) {
        return waitOutLimit(function () {
          return api('/api/console/upload/sign?id=' + u.id + '&n=' + n);
        }, saysWaiting).then(function (s) {
          if (!s || !s.ok) throw s || {};
          var blob = file.slice((n - 1) * u.part_size, Math.min(n * u.part_size, file.size));
          return putSlice(s.url, blob, function (share) { onProgress((n - 1 + share) / u.parts); });
        }).catch(function (err) {
          // turned away even after the waits, or signed out: no use asking again at once
          if (tries > 1 && !(err && err.status === 429) && session()) return slice(n, tries - 1);
          throw err;
        });
      }
      var n = 0;
      function next() {
        n += 1;
        if (n > u.parts) {
          return waitOutLimit(function () { return post('/api/console/upload/finish', { id: u.id }); }, saysWaiting);
        }
        onProgress((n - 1) / u.parts);
        return slice(n, 3).then(next);
      }
      return next().then(function (r) {
        if (!r || !r.ok) throw r || {};
        onProgress(1);
        return u.id;
      }).catch(function (err) {
        post('/api/console/upload/abort', { id: u.id }).catch(function () {});
        throw { error: (err && err.error) || 'Could not send ' + file.name + '.' };
      });
    });
  }

  // Several, one after another: resolves their ids in order, or null
  // when the worker cannot sign and the save should carry the files.
  // A failure part way takes back the ones already sent.
  function stageFiles(files, purpose, onProgress) {
    return uploadMode().then(function (m) {
      if (!m.direct || !files.length) return null;
      var total = files.reduce(function (t, f) { return t + f.size; }, 0) || 1;
      var sent = 0;
      var ids = [];
      return files.reduce(function (chain, file) {
        return chain.then(function () {
          return stageFile(file, purpose, function (share) {
            if (onProgress) onProgress((sent + share * file.size) / total);
          }).then(function (id) {
            ids.push(id);
            sent += file.size;
          });
        });
      }, Promise.resolve()).then(function () { return ids; }, function (err) {
        ids.forEach(function (id) { post('/api/console/upload/abort', { id: id }).catch(function () {}); });
        throw err;
      });
    });
  }
  dash.PT_ACCEPT = { photo: 'image/*', video: 'video/*', gpx: '.gpx,application/gpx+xml', pdf: '.pdf,application/pdf' };
  dash.PT_KINDS = { photo: 'photos', video: 'videos', gpx: 'GPX tracks', pdf: 'PDFs' };
  dash.PT_KIND = { photo: 'a photo', video: 'a video', gpx: 'a GPX track', pdf: 'a PDF' };
  // the type a file is staged under: a GPX track usually comes with none
  function ptType(file) {
    if (file.type && file.type !== 'application/octet-stream') return file.type;
    if (extOf(file.name) === 'gpx') return 'application/gpx+xml';
    if (extOf(file.name) === 'pdf') return 'application/pdf';
    return file.type;
  }
  // which of the kinds a quest takes a file is, '' for none of them
  function ptKindOf(file) {
    var type = String(ptType(file) || '').toLowerCase();
    if (type.indexOf('image/') === 0) return 'photo';
    if (type.indexOf('video/') === 0) return 'video';
    if (type === 'application/gpx+xml') return 'gpx';
    if (type === 'application/pdf') return 'pdf';
    return '';
  }

  // Proof on its way to a save, from the desk's Record a result and from the Queue's Add
  // files: a small copy and a viewing copy of each picture made here,
  // then each file sent straight to storage when the worker can sign for
  // it (staged, in order) or carried in the form (files), with thumb<i>
  // and view<i> beside it. Staged under the names typed over them, a GPX
  // track or a PDF under its own type. Resolves the form.
  function appendProof(form, files, names, onProgress) {
    return Promise.all(files.map(imageCopies)).then(function (copies) {
      var named = files.map(function (f, i) {
        var type = ptType(f);
        return names[i] === f.name && type === f.type ? f : new File([f], names[i], { type: type });
      });
      return stageFiles(named, 'points', onProgress).then(function (ids) {
        files.forEach(function (f, i) {
          if (ids) form.append('staged', String(ids[i]));
          else form.append('files', f, names[i]);
          if (copies[i][0]) form.append('thumb' + i, copies[i][0], 'thumb.jpg');
          if (copies[i][1]) form.append('view' + i, copies[i][1], 'view.jpg');
        });
        return form;
      });
    });
  }
  var MSG_THUMB_EDGE = dash.MSG_THUMB_EDGE = 480;

  // a file's name is typed over before it goes: the box holds the
  // part before the extension, the extension stays as it was
  function splitName(name) {
    var m = /^(.*?)(\.[A-Za-z0-9]{1,5})$/.exec(String(name || ''));
    return m ? { base: m[1], ext: m[2] } : { base: String(name || ''), ext: '' };
  }
  function sendName(file, typed) {
    var parts = splitName(file.name);
    var t = String(typed == null ? parts.base : typed).trim().replace(/[\\\/:*?"<>|]/g, '');
    return (t || parts.base || 'file') + parts.ext;
  }
  // one row per file waiting to go up: a box for its name, the
  // extension after it, the size, and a Remove
  function renameRow(file, names, i, onRemove) {
    var line = h('div', 'file-row');
    var parts = splitName(file.name);
    var box = h('input', 'file-rename');
    box.type = 'text';
    box.maxLength = 100;
    box.value = names[i] != null ? names[i] : parts.base;
    box.setAttribute('aria-label', 'File name');
    box.addEventListener('input', function () { names[i] = box.value; });
    line.appendChild(box);
    line.appendChild(h('span', 'muted', parts.ext));
    line.appendChild(h('span', 'muted grow', sizeText(file.size)));
    line.appendChild(btn('Remove', 'quiet small', onRemove));
    return line;
  }

  function sizeText(bytes) {
    var kb = Math.round((bytes || 0) / 1024);
    return kb >= 1024 ? (Math.round(kb / 102.4) / 10) + ' MB' : kb + ' KB';
  }

  // HEIC and WebP are redrawn before they go up. The worker can only take
  // a location out of JPEG, PNG and GIF, so it refuses the other two, and
  // a phone's library is full of HEIC. A photo for a submission or an
  // album becomes a JPEG with the original's EXIF copied in, as the
  // site's scs.toJpeg makes one, so the worker can still say when and
  // where it was taken; anything else becomes a PNG of the pixels and
  // nothing more, which keeps a transparent picture transparent. Every
  // browser draws WebP and only Safari draws HEIC, so anywhere else the
  // site's copy of the HEIC decoder is fetched the first time one is
  // picked. Over MAX_PNG_PIXELS a picture is scaled down to it, which is
  // about as big a canvas as iOS Safari will make.
  var HEIC_LIB = 'https://scs.andyrew.space/assets/heic/heic-to.js';
  var MAX_PNG_PIXELS = 16000000;
  var JPEG_QUALITY = 0.92;
  function extOf(name) {
    var n = String(name || '').toLowerCase();
    var dot = n.lastIndexOf('.');
    return dot === -1 ? '' : n.slice(dot + 1);
  }
  function heicFile(file) {
    var type = String(file.type || '').toLowerCase();
    return type === 'image/heic' || type === 'image/heif' || extOf(file.name) === 'heic' || extOf(file.name) === 'heif';
  }
  function needsConverting(file) {
    return heicFile(file) || String(file.type || '').toLowerCase() === 'image/webp' || extOf(file.name) === 'webp';
  }
  function renamed(blob, file, ext, type) {
    var name = String(file.name || 'picture');
    var dot = name.lastIndexOf('.');
    return new File([blob], (dot > 0 ? name.slice(0, dot) : name) + '.' + ext, { type: type, lastModified: file.lastModified || Date.now() });
  }
  var heicLib = null;
  function loadHeic() {
    if (window.HeicTo) return Promise.resolve(window.HeicTo);
    if (heicLib) return heicLib;
    heicLib = new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = HEIC_LIB;
      tag.onload = function () { if (window.HeicTo) resolve(window.HeicTo); else { heicLib = null; reject(new Error('no HEIC decoder')); } };
      tag.onerror = function () { heicLib = null; reject(new Error('the HEIC decoder did not load')); };
      document.head.appendChild(tag);
    });
    return heicLib;
  }
  // an ImageBitmap, then an <img>, then for HEIC the site's decoder
  function decodePicture(file) {
    function bitmap(bmp) { return { pic: bmp, done: function () { if (bmp.close) bmp.close(); } }; }
    function viaImg() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { resolve({ pic: img, done: function () { URL.revokeObjectURL(url); } }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not a picture this browser draws')); };
        img.src = url;
      });
    }
    var drawn = window.createImageBitmap ? window.createImageBitmap(file).then(bitmap, viaImg) : viaImg();
    return drawn.catch(function (err) {
      if (!heicFile(file)) throw err;
      return loadHeic().then(function (HeicTo) { return HeicTo({ blob: file, type: 'bitmap' }); }).then(bitmap);
    });
  }
  // a JPEG is drawn over white, or a transparent part comes out black
  function redraw(got, type, quality) {
    var w = got.pic.naturalWidth || got.pic.width;
    var hgt = got.pic.naturalHeight || got.pic.height;
    var scale = Math.min(1, Math.sqrt(MAX_PNG_PIXELS / Math.max(1, w * hgt)));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hgt * scale));
    var ctx = canvas.getContext('2d');
    if (type === 'image/jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(got.pic, 0, 0, canvas.width, canvas.height);
    got.done();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob); else reject(new Error('could not redraw the picture'));
      }, type, quality);
    });
  }
  function toPng(file) {
    if (!needsConverting(file)) return Promise.resolve(file);
    return decodePicture(file).then(function (got) { return redraw(got, 'image/png'); })
      .then(function (blob) { return renamed(blob, file, 'png', 'image/png'); });
  }
  function toJpeg(file) {
    if (!needsConverting(file)) return Promise.resolve(file);
    var exif = exifOf(file);
    return decodePicture(file).then(function (got) { return redraw(got, 'image/jpeg', JPEG_QUALITY); }).then(function (jpeg) {
      // a metadata copy that fails sends the picture without it
      return exif.then(function (tiff) {
        return withExif(jpeg, tiff && uprightExif(tiff));
      }).then(null, function () { return jpeg; });
    }).then(function (blob) { return renamed(blob, file, 'jpg', 'image/jpeg'); });
  }
  // every file in a pick, the HEIC and WebP ones redrawn; one that will
  // not redraw stays as it was, and the worker says what it thinks of it
  function convertEach(files, convert, kind) {
    return Promise.all(files.map(function (f) {
      return convert(f).catch(function () {
        toast('Could not convert ' + f.name + ' to ' + kind + '.', true);
        return f;
      });
    }));
  }
  function pngPicks(files) { return convertEach(files, toPng, 'PNG'); }
  function jpegPicks(files) { return convertEach(files, toJpeg, 'JPEG'); }

  // ---- the EXIF of a WebP or a HEIC, as a TIFF block ----
  // The same reader as the site's (scs.exifOf in website/assets/site.js),
  // which this page does not load; a fix to one goes in both.
  function readBytes(blob, start, end) {
    var part = blob.slice(start, end);
    if (part.arrayBuffer) return part.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(part);
    });
  }
  function fourcc(b, at) {
    return at + 4 > b.length ? '' : String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  }
  // an unsigned big-endian number of n bytes
  function uintBE(b, at, n) {
    if (at + n > b.length) throw new Error('past the end');
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + b[at + i];
    return v;
  }
  function uint32LE(b, at) {
    if (at + 4 > b.length) throw new Error('past the end');
    return b[at] + b[at + 1] * 256 + b[at + 2] * 65536 + b[at + 3] * 16777216;
  }
  // "Exif\0\0"; its first four bytes are also the HEIC item type
  var EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0, 0];
  function startsExif(b, at, n) {
    n = n || 6;
    if (at + n > b.length) return false;
    for (var i = 0; i < n; i++) if (b[at + i] !== EXIF_MAGIC[i]) return false;
    return true;
  }
  // the bytes from `at` on, if a TIFF header starts there
  function tiffFrom(b, at) {
    if (at < 0 || at + 8 > b.length) return null;
    var ii = b[at] === 0x49 && b[at + 1] === 0x49 && b[at + 2] === 42 && b[at + 3] === 0;
    var mm = b[at] === 0x4D && b[at + 1] === 0x4D && b[at + 2] === 0 && b[at + 3] === 42;
    return ii || mm ? new Uint8Array(b.subarray(at)) : null;
  }

  // WebP: an 'EXIF' chunk in a VP8X file, flagged in the VP8X header
  function webpExif(file) {
    return readBytes(file, 0, 30).then(function (head) {
      if (fourcc(head, 12) !== 'VP8X' || !(head[20] & 0x08)) return null;
      var end = Math.min(file.size, uint32LE(head, 4) + 8);
      var hops = 0;
      function chunkAt(at) {
        if (at + 8 > end || ++hops > 256) return null;
        return readBytes(file, at, at + 8).then(function (h) {
          var size = uint32LE(h, 4);
          if (fourcc(h, 0) !== 'EXIF') return chunkAt(at + 8 + size + (size & 1));
          if (at + 8 + size > end) return null;
          return readBytes(file, at + 8, at + 8 + size).then(function (data) {
            return tiffFrom(data, startsExif(data, 0) ? 6 : 0);
          });
        });
      }
      return chunkAt(12);
    });
  }

  // ISO-BMFF boxes between two offsets, by type (the first of each)
  function boxesIn(b, from, to) {
    var out = {};
    var at = from;
    while (at + 8 <= to) {
      var size = uintBE(b, at, 4);
      var head = 8;
      if (size === 1) { size = uintBE(b, at + 8, 8); head = 16; } else if (size === 0) size = to - at;
      if (size < head || at + size > to) break;
      var type = fourcc(b, at + 4);
      if (!out[type]) out[type] = { start: at + head, end: at + size };
      at += size;
    }
    return out;
  }
  // HEIC: the item typed 'Exif' in the meta box's iinf, found through iloc
  function exifItem(file, meta, head) {
    var kids = boxesIn(meta, head + 4, meta.length);
    var iinf = kids.iinf;
    var iloc = kids.iloc;
    if (!iinf || !iloc) return null;
    var id = -1;
    var p = iinf.start + 4 + (meta[iinf.start] === 0 ? 2 : 4);
    while (p + 8 <= iinf.end && id < 0) {
      var size = uintBE(meta, p, 4);
      if (size < 8 || p + size > iinf.end) break;
      var v = meta[p + 8];
      if (fourcc(meta, p + 4) === 'infe' && v >= 2) {
        var q = p + 12;
        var itemId = uintBE(meta, q, v === 2 ? 2 : 4);
        q += (v === 2 ? 2 : 4) + 2;
        if (q + 4 <= p + size && startsExif(meta, q, 4)) id = itemId;
      }
      p += size;
    }
    if (id < 0) return null;

    var lv = meta[iloc.start];
    if (lv > 2) return null;
    var at = iloc.start + 4;
    var offSize = meta[at] >> 4;
    var lenSize = meta[at] & 15;
    var baseSize = meta[at + 1] >> 4;
    var idxSize = lv > 0 ? meta[at + 1] & 15 : 0;
    if ([offSize, lenSize, baseSize, idxSize].some(function (k) { return k !== 0 && k !== 4 && k !== 8; })) return null;
    at += 2;
    var idBytes = lv < 2 ? 2 : 4;
    var count = uintBE(meta, at, idBytes);
    at += idBytes;
    var found = null;
    for (var n = 0; n < count && !found; n++) {
      var item = uintBE(meta, at, idBytes);
      at += idBytes;
      var method = 0;
      if (lv > 0) { method = uintBE(meta, at, 2) & 15; at += 2; }
      var dataRef = uintBE(meta, at, 2);
      var base = uintBE(meta, at + 2, baseSize);
      var extents = uintBE(meta, at + 2 + baseSize, 2);
      at += 4 + baseSize;
      var list = [];
      for (var e = 0; e < extents; e++) {
        at += idxSize;
        list.push([base + uintBE(meta, at, offSize), uintBE(meta, at + offSize, lenSize)]);
        at += offSize + lenSize;
      }
      if (item === id) found = { method: method, dataRef: dataRef, extents: list };
    }
    if (!found || found.dataRef !== 0 || !found.extents.length) return null;
    var total = 0;
    var bad = found.extents.some(function (x) { total += x[1]; return x[1] <= 0; });
    if (bad || total > 1048576) return null;

    var parts;
    if (found.method === 0) {
      parts = Promise.all(found.extents.map(function (x) {
        if (x[0] + x[1] > file.size) throw new Error('past the end');
        return readBytes(file, x[0], x[0] + x[1]);
      }));
    } else if (found.method === 1 && kids.idat) {
      parts = Promise.resolve(found.extents.map(function (x) {
        var from = kids.idat.start + x[0];
        if (from + x[1] > kids.idat.end) throw new Error('past the end');
        return meta.subarray(from, from + x[1]);
      }));
    } else {
      return null;
    }
    return parts.then(function (pieces) {
      var data = new Uint8Array(total);
      var off = 0;
      pieces.forEach(function (piece) { data.set(piece, off); off += piece.length; });
      // four bytes saying how far past them the TIFF header starts
      return tiffFrom(data, 4 + uintBE(data, 0, 4)) || (startsExif(data, 4) ? tiffFrom(data, 10) : null);
    });
  }
  function heicExif(file) {
    var hops = 0;
    function boxAt(at) {
      if (at + 8 > file.size || ++hops > 64) return null;
      return readBytes(file, at, at + 16).then(function (h) {
        var size = uintBE(h, 0, 4);
        var head = 8;
        if (size === 1) { size = uintBE(h, 8, 8); head = 16; } else if (size === 0) size = file.size - at;
        if (size < head) return null;
        if (fourcc(h, 4) !== 'meta') return boxAt(at + size);
        if (size > 4194304 || at + size > file.size) return null;
        return readBytes(file, at, at + size).then(function (meta) { return exifItem(file, meta, head); });
      });
    }
    return boxAt(0);
  }

  // Resolves the TIFF block (the EXIF without "Exif\0\0") of a WebP or
  // a HEIC, or null when there is none or it cannot be read.
  function exifOf(file) {
    return Promise.resolve().then(function () {
      return readBytes(file, 0, 12);
    }).then(function (head) {
      if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WEBP') return webpExif(file);
      if (fourcc(head, 4) === 'ftyp') return heicExif(file);
      return null;
    }).then(function (tiff) { return tiff || null; }, function () { return null; });
  }

  // a copy with Orientation (0x0112 in IFD0) set to 1, because the
  // canvas has already turned the picture upright
  function uprightExif(tiff) {
    var out = new Uint8Array(tiff);
    var le = out[0] === 0x49;
    function u16(at) {
      if (at + 2 > out.length) throw new Error('past the end');
      return le ? out[at] + out[at + 1] * 256 : out[at] * 256 + out[at + 1];
    }
    var ifd = le ? uint32LE(out, 4) : uintBE(out, 4, 4);
    var count = u16(ifd);
    if (ifd + 2 + count * 12 > out.length) throw new Error('past the end');
    for (var i = 0; i < count; i++) {
      var at = ifd + 2 + i * 12;
      if (u16(at) === 0x0112 && u16(at + 2) === 3) {
        out[at + 8] = le ? 1 : 0;
        out[at + 9] = le ? 0 : 1;
      }
    }
    return out;
  }
  // The TIFF block as an APP1 segment straight after the JPEG's SOI.
  // One segment holds 65533 bytes, "Exif\0\0" included.
  function withExif(jpeg, tiff) {
    if (!tiff || tiff.length + 8 > 65535) return Promise.resolve(jpeg);
    return readBytes(jpeg, 0, 2).then(function (soi) {
      if (soi[0] !== 0xFF || soi[1] !== 0xD8) return jpeg;
      var len = tiff.length + 8;
      var head = new Uint8Array([0xFF, 0xE1, len >> 8, len & 255].concat(EXIF_MAGIC));
      return new Blob([jpeg.slice(0, 2), head, tiff, jpeg.slice(2)], { type: 'image/jpeg' });
    });
  }


  // The worker cannot resize pictures, so this browser makes the small
  // copy before sending: 480px on the long edge as a light JPEG, the
  // same as the submit page does. Anything that will not draw goes up
  // without a preview, and reads fall back to the full file.
  // A GIF is skipped: a canvas takes one frame of it, the worker will
  // not store a still in place of an animation, and readers serve the
  // whole file instead.
  function imageThumb(file) {
    return imageCopy(file, MSG_THUMB_EDGE, 0.72, 300 * 1024);
  }
  // and, for points with a photo, the viewing copy the submit page makes
  var PT_VIEW_EDGE = dash.PT_VIEW_EDGE = 1920;
  var PT_VIEW_BYTES = dash.PT_VIEW_BYTES = 2 * 1024 * 1024;
  function drawImageCopy(img, edge, quality, maxBytes) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        canvas.width = 0;
        canvas.height = 0;
        resolve(blob && blob.size > 0 && blob.size <= maxBytes ? blob : null);
      }, 'image/jpeg', quality);
    });
  }
  function imageCopies(file) {
    return new Promise(function (resolve) {
      var kind = String(file.type || '').toLowerCase();
      if (kind.indexOf('image/') !== 0 || kind === 'image/gif') return resolve([null, null]);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        Promise.all([
          drawImageCopy(img, MSG_THUMB_EDGE, 0.72, 300 * 1024),
          drawImageCopy(img, PT_VIEW_EDGE, 0.8, PT_VIEW_BYTES)
        ]).then(function (out) {
          URL.revokeObjectURL(url);
          resolve(out);
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve([null, null]); };
      img.src = url;
    });
  }
  function imageCopy(file, edge, quality, maxBytes) {
    return new Promise(function (resolve) {
      var kind = String(file.type || '').toLowerCase();
      if (kind.indexOf('image/') !== 0 || kind === 'image/gif') return resolve(null);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        drawImageCopy(img, edge, quality, maxBytes).then(function (blob) {
          URL.revokeObjectURL(url);
          resolve(blob);
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
})(window.dash);
