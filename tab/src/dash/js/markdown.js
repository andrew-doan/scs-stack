// The small markdown descriptions and messages are written in, and the
// toolbar for a box that takes it (quests, messages, email).
(function (dash) {
  // core.js
  var btn = dash.btn, h = dash.h;

  dash.markdown = markdown;
  dash.markdownTools = markdownTools;

  // a small markdown for descriptions: **bold**, __underline__, *italic*,
  // lists, paragraphs, links. HTML is escaped first, so it is safe.
  var TICK = String.fromCharCode(96);
  var CODE_RE = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');
  function markdown(text) {
    var esc = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    function inline(t) {
      return t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/__(.+?)__/g, '<u>$1</u>')
        .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(CODE_RE, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }
    return esc.split(/\n{2,}/).map(function (block) {
      var lines = block.split('\n');
      if (lines.every(function (l) { return /^\s*[-*] /.test(l); })) {
        return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>'; }).join('') + '</ul>';
      }
      return '<p>' + lines.map(inline).join('<br>') + '</p>';
    }).join('');
  }

  // ---- a markdown toolbar for any textarea that takes markdown ----
  // The buttons wrap or prefix whatever is selected and leave it
  // selected, so a second tap undoes the first. Preview renders through
  // the same markdown above, in place under the box.
  function wrapSelection(area, before, after) {
    var start = area.selectionStart;
    var end = area.selectionEnd;
    var text = area.value;
    var picked = text.slice(start, end);
    // tapping the same button again takes the marks back off
    var already = text.slice(start - before.length, start) === before &&
      text.slice(end, end + after.length) === after;
    if (already) {
      area.value = text.slice(0, start - before.length) + picked + text.slice(end + after.length);
      area.selectionStart = start - before.length;
      area.selectionEnd = end - before.length;
    } else {
      area.value = text.slice(0, start) + before + picked + after + text.slice(end);
      area.selectionStart = start + before.length;
      area.selectionEnd = start + before.length + picked.length;
    }
    area.focus();
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function prefixLines(area, mark) {
    var start = area.selectionStart;
    var end = area.selectionEnd;
    var text = area.value;
    var from = text.lastIndexOf('\n', start - 1) + 1;
    var to = text.indexOf('\n', end);
    if (to === -1) to = text.length;
    var lines = text.slice(from, to).split('\n');
    var on = lines.every(function (line) { return line.indexOf(mark) === 0; });
    var block = lines.map(function (line) {
      return on ? line.slice(mark.length) : mark + line;
    }).join('\n');
    area.value = text.slice(0, from) + block + text.slice(to);
    area.focus();
    area.selectionStart = from;
    area.selectionEnd = from + block.length;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // preview is an optional node; render an optional function for the
  // callers that preview more than the one box (the quest description
  // shows its flavour line too)
  function markdownTools(area, preview, render, withQuest) {
    var bar = h('div', 'md-bar');
    function tool(label, className, title, run) {
      var b = btn(label, 'quiet small' + (className ? ' ' + className : ''), run);
      b.title = title;
      bar.appendChild(b);
      return b;
    }
    tool('B', 'md-b', 'Bold', function () { wrapSelection(area, '**', '**'); });
    tool('I', 'md-i', 'Italic', function () { wrapSelection(area, '*', '*'); });
    tool('H', '', 'Heading', function () { prefixLines(area, '## '); });
    tool('List', '', 'Bulleted list', function () { prefixLines(area, '- '); });
    tool('Link', '', 'Link', function () { wrapSelection(area, '[', '](https://)'); });
    tool('Code', '', 'Code', function () { wrapSelection(area, TICK, TICK); });
    if (withQuest) {
      // [[quest:SQ40]] on a line of its own; the site renders the card
      tool('Quest', '', 'Embed a quest by its code, on a line of its own', function () {
        var start = area.selectionStart;
        var text = area.value;
        var picked = text.slice(start, area.selectionEnd).trim();
        var before = text.slice(0, start);
        var after = text.slice(area.selectionEnd);
        var lead = before && before.slice(-1) !== '\n' ? '\n' : '';
        var tail = after && after.charAt(0) !== '\n' ? '\n' : '';
        area.value = before + lead + '[[quest:' + picked + ']]' + tail + after;
        var pos = before.length + lead.length + 8 + picked.length;
        area.selectionStart = area.selectionEnd = pos; // inside, ready for the code
        area.focus();
        area.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    if (preview) {
      var paint = render || function () {
        // the site turns a quest token into a card; the preview marks
        // the spot rather than pretending to be the card
        preview.innerHTML = markdown(area.value).replace(
          /<p>\[\[quest:\s*([^\]<]+?)\s*\]\]<\/p>/g,
          '<div class="mq-stub">Quest embed: $1</div>');
      };
      var toggle = tool('Preview', '', 'Show the message as the site will', function () {
        var off = preview.classList.toggle('hidden');
        toggle.classList.toggle('is-on', !off);
        if (!off) paint();
      });
      area.addEventListener('input', function () {
        if (!preview.classList.contains('hidden')) paint();
      });
    }
    return bar;
  }
})(window.dash);
