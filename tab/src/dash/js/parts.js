// A quest's questions and parts as an organiser fills them in, on the
// Queue's Accept and Change and the Desk's Record a result: the answer
// boxes, the count a challenge reads, and the box each part's scoring
// type takes.
(function (dash) {
  // core.js
  var btn = dash.btn, chip = dash.chip, h = dash.h, labelled = dash.labelled, state = dash.state;

  dash.worthWords = worthWords;
  dash.answerFrom = answerFrom;
  dash.answerInput = answerInput;
  dash.answerParts = answerParts;
  dash.partWords = partWords;
  dash.partInput = partInput;
  dash.creditForm = creditForm;
  dash.creditWorth = creditWorth;
  dash.countAt = countAt;
  dash.withCount = withCount;
  dash.numberChallenge = numberChallenge;
  dash.countBox = countBox;

  // what a credit comes to, on this form and on Review's Change
  function worthWords(worth, full) {
    return worth !== full ? 'Worth ' + worth + ' of ' + full + ' points' : 'Worth ' + worth + (worth === 1 ? ' point' : ' points');
  }
  // the answers in the shape the worker keeps: the first question's at
  // the top, the rest under more with the question as it was worded
  function answerFrom(list, values) {
    if (!list.length || !values.some(function (v) { return v != null; })) return null;
    var many = list.length > 1;
    var entry = function (question, value) {
      var out = { kind: question.kind, value: value };
      if (many && question.prompt) out.prompt = question.prompt;
      return out;
    };
    var top = entry(list[0], values[0]);
    if (many) top.more = list.slice(1).map(function (question, i) { return values[i + 1] == null ? null : entry(question, values[i + 1]); });
    return top;
  }
  // One question's box, started from what was answered, and a function
  // reading what it says now. places is the lists behind @stations.
  function answerInput(box, q, places, start) {
    if (q.kind === 'count' || q.kind === 'text') {
      var input = h('input');
      input.type = q.kind === 'count' ? 'number' : 'text';
      if (q.kind === 'count') { input.min = '0'; input.step = '1'; input.inputMode = 'numeric'; }
      else input.maxLength = 500;
      if (start != null) input.value = String(start);
      box.appendChild(labelled(q.prompt || (q.kind === 'count' ? 'How many?' : 'Their answer'), input));
      return function () {
        var v = input.value.trim();
        if (!v) return null;
        return q.kind === 'count' ? Number(v) : v;
      };
    }
    if (q.kind === 'choice') {
      var sel = h('select');
      var blank = h('option', null, 'Not answered'); blank.value = ''; sel.appendChild(blank);
      var choices = (q.options || []).slice();
      // an answer the options no longer hold stays pickable
      if (start != null && choices.indexOf(start) === -1) choices.push(start);
      choices.forEach(function (o) { var opt = h('option', null, o); opt.value = o; sel.appendChild(opt); });
      if (start != null) sel.value = start;
      box.appendChild(labelled(q.prompt || 'Their answer', sel));
      return function () { return sel.value || null; };
    }
    // pick: a filter over the quest's list, the chosen ones as chips
    var all = [];
    (q.options || []).forEach(function (o) {
      if (o === '@stations') all = all.concat((places && places.stations) || []);
      else if (o === '@sushi') all = all.concat((places && places.sushi) || []);
      else all.push(o);
    });
    var chosen = Array.isArray(start) ? start.slice() : [];
    var find = h('input');
    find.type = 'search';
    find.placeholder = 'Type to find one';
    var hits = h('div', 'pt-hits');
    var picked = h('div', 'pt-picked');
    box.appendChild(labelled(q.prompt || 'Which ones?', find));
    box.appendChild(hits);
    box.appendChild(picked);
    function drawPicked() {
      picked.textContent = '';
      chosen.forEach(function (name) {
        picked.appendChild(btn(name + ' ×', 'quiet small', function () {
          chosen.splice(chosen.indexOf(name), 1);
          drawPicked();
        }));
      });
    }
    function drawHits() {
      hits.textContent = '';
      var term = find.value.trim().toLowerCase();
      if (!term) return;
      all.filter(function (name) { return chosen.indexOf(name) === -1 && name.toLowerCase().indexOf(term) !== -1; })
        .slice(0, 8).forEach(function (name) {
          hits.appendChild(btn(name, 'quiet small', function () {
            chosen.push(name);
            find.value = '';
            drawHits();
            drawPicked();
            find.focus();
          }));
        });
    }
    find.addEventListener('input', drawHits);
    drawPicked();
    return function () { return chosen.length ? chosen.slice() : null; };
  }
  // A stored answer as lines: the question as it was asked, then what
  // was said. A quest with one question reads "Answer: …" as before.
  function answerParts(answer) {
    if (!answer) return [];
    var list = [answer].concat(answer.more || []);
    var many = list.length > 1;
    var out = [];
    list.forEach(function (a, i) {
      if (!a || a.value == null || a.value === '') return;
      var text = Array.isArray(a.value) ? a.value.join(', ') : String(a.value);
      var q = many ? (a.prompt || 'Question ' + (i + 1)) : (a.prompt || 'Answer');
      // a question that ends in its own mark takes no colon after it
      out.push({ q: q + (/[?.!:]$/.test(q) ? ' ' : ': '), text: text });
    });
    return out;
  }

  // ---- a quest's parts, as Accept, Change and the desk draw them ----
  // Each code is a part with a scoring type (the worker's parts.js): a
  // fixed part is credited once at its points, a per-unit part counts up
  // to its most, a judged part is given up to its points, a tiered part
  // is worth the band its number reached, and a counted part adds to its
  // challenge's count and is worth nothing until that is awarded.
  dash.SCORING_NAMES = [['', 'Fixed'], ['unit', 'Per unit'], ['judged', 'Judged'], ['tiered', 'Tiered'], ['counted', 'Counted']];
  function bandOf(bands, n) {
    var x = Number(n);
    var out = 0;
    if (!isFinite(x)) return 0;
    (bands || []).forEach(function (b) { if (Number(b.from) <= x) out = Number(b.points) || 0; });
    return out;
  }
  function bandsText(bands) {
    return (bands || []).map(function (b) { return b.from + '+: ' + b.points; }).join(' · ');
  }
  // what a part is worth, beside its name
  function partWords(p) {
    var s = p.scoring || '';
    if (s === 'unit') return p.points + ' each' + (p.most != null ? ', up to ' + p.most : '');
    if (s === 'judged') return 'up to ' + p.points;
    if (s === 'tiered') return bandsText(p.bands);
    if (s === 'counted') return '';
    return String(p.points);
  }
  // the first number a team gave in its answer, which a tiered part
  // starts from
  function firstNumber(answer) {
    if (!answer) return null;
    var list = [answer].concat(answer.more || []);
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].kind === 'count' && list[i].value != null && isFinite(Number(list[i].value))) return Number(list[i].value);
    }
    return null;
  }
  // How many times one of a quest's codes is credited, beside it.
  function countInput(start, code, changed) {
    var input = h('input', 'code-count');
    input.type = 'number'; input.step = 'any'; input.min = '0';
    input.value = String(start);
    input.setAttribute('aria-label', 'How many times for ' + code);
    input.addEventListener('input', changed);
    var node = h('span', 'code-times');
    node.appendChild(h('span', 'muted', '×'));
    node.appendChild(input);
    return { node: node, input: input };
  }
  // what a credit counted one code, its own count or else its amount
  function countIn(credit, code) {
    return credit.counts && credit.counts[code] != null ? Number(credit.counts[code]) : Number(credit.amount);
  }
  // The box one part takes, by its type: a count for a per-unit part, the
  // points given for a judged one, the number reached for a tiered one,
  // and none for a fixed or a counted one. `given` is the credit to start
  // from, `answered` the team's first number.
  function partInput(p, given, changed, answered) {
    var kind = p.scoring || '';
    var node = null;
    var input = null;
    var shown = null;
    if (kind === 'unit') {
      var c = countInput(given ? countIn(given, p.code) : 1, p.code, changed);
      if (p.most != null) c.input.max = String(p.most);
      node = c.node; input = c.input;
    } else if (kind === 'judged') {
      input = h('input', 'part-pts');
      input.type = 'number';
      input.step = Number(p.points) === Math.round(Number(p.points)) ? '1' : 'any';
      input.min = String(Math.min(0, p.points));
      input.max = String(Math.max(0, p.points));
      input.setAttribute('aria-label', 'Points given for ' + p.code);
      var part = given && given.amounts && given.amounts[p.code] != null ? Number(given.amounts[p.code]) : 1;
      input.value = String(Math.round(part * Number(p.points) * 100) / 100);
      input.addEventListener('input', changed);
      node = h('span', 'part-mark');
      node.appendChild(input);
      node.appendChild(h('span', 'muted', 'of ' + p.points));
    } else if (kind === 'tiered') {
      input = h('input', 'part-number');
      input.type = 'number'; input.min = '0'; input.step = 'any';
      input.setAttribute('aria-label', 'Number reached for ' + p.code);
      var start = given && given.numbers && given.numbers[p.code] != null ? given.numbers[p.code] : answered;
      if (start != null) input.value = String(start);
      shown = h('span', 'muted');
      var showBand = function () { shown.textContent = input.value === '' ? 'reached' : '= ' + bandOf(p.bands, input.value) + ' points'; };
      input.addEventListener('input', function () { showBand(); changed(); });
      showBand();
      node = h('span', 'part-band');
      node.appendChild(input);
      node.appendChild(shown);
    } else if (kind === 'counted') {
      node = h('span', 'muted', 'counts towards the challenge');
    }
    return {
      node: node,
      enable: function (on) { if (input) input.disabled = !on; },
      // its share of what is sent: counts, awarded and numbers by code
      fill: function (out) {
        if (kind === 'unit') out.counts[p.code] = input.value || '1';
        else if (kind === 'judged' && input.value !== '') out.awarded[p.code] = input.value;
        else if (kind === 'tiered') out.numbers[p.code] = input.value;
      },
      worth: function () {
        var pts = Number(p.points) || 0;
        if (kind === 'unit') { var n = Number(input.value || 1); var w = pts * (isFinite(n) ? n : 0); return { given: w, full: w }; }
        if (kind === 'judged') { var g = input.value === '' ? pts : Number(input.value); return { given: isFinite(g) ? g : 0, full: pts }; }
        if (kind === 'tiered') { var b = bandOf(p.bands, input.value); return { given: b, full: b }; }
        if (kind === 'counted') return { given: 0, full: 0 };
        return { given: pts, full: pts };
      }
    };
  }
  var PART_LABELS = { unit: 'How many', judged: 'Points', tiered: 'Reached' };

  // What Accept sends, and Change on an accepted card: the codes to
  // credit on a quest with several, and each code's box by its type.
  // given is what an accepted one credited, to start from; onChange is
  // called when what it comes to may have moved.
  function creditForm(sub, given, onChange) {
    var built = false;
    function changed() { if (built && onChange) onChange(); }
    var answered = firstNumber(sub.answer);
    var many = !!(sub.codes && sub.codes.length > 1);
    var parts = many ? sub.codes : [{ code: sub.quest_code, label: '', points: sub.points, scoring: sub.scoring || '', most: sub.most, bands: sub.bands || [] }];
    var picks = parts.map(function (p) { return { part: p, input: partInput(p, given, changed, answered), box: null }; });
    var codesRow = null;
    var amountLabel = null;
    if (many) {
      codesRow = h('div', 'review-codes');
      var ticked = sub.answer && sub.answer.kind === 'codes' ? sub.answer.value : null;
      picks.forEach(function (pk) {
        var c = pk.part;
        var box = h('input'); box.type = 'checkbox';
        box.checked = given ? given.codes.indexOf(c.code) !== -1
          : ticked ? ticked.indexOf(c.code) !== -1 : c.code === sub.quest_code;
        var lab = h('label'); lab.appendChild(box); lab.appendChild(chip(c.code, true));
        lab.appendChild(document.createTextNode(' ' + (c.label || '') + ' ' + partWords(c)));
        var one = h('span', 'review-code');
        one.appendChild(lab);
        if (pk.input.node) one.appendChild(pk.input.node);
        function able() { pk.input.enable(box.checked); }
        able();
        box.addEventListener('change', able);
        box.addEventListener('change', changed);
        codesRow.appendChild(one);
        pk.box = box;
      });
    } else if (picks[0].input.node) {
      amountLabel = h('label', 'review-amount');
      if (PART_LABELS[picks[0].part.scoring]) amountLabel.appendChild(h('span', null, PART_LABELS[picks[0].part.scoring]));
      amountLabel.appendChild(picks[0].input.node);
    }
    function chosen() { return many ? picks.filter(function (pk) { return pk.box.checked; }) : picks; }
    built = true;
    return {
      codesRow: codesRow, amountLabel: amountLabel, pointsLabel: null,
      body: function () {
        var out = { counts: {}, awarded: {}, numbers: {} };
        var list = chosen();
        list.forEach(function (pk) { pk.input.fill(out); });
        var body = { id: sub.id, amount: '1' };
        if (many) body.codes = list.map(function (pk) { return pk.part.code; });
        else if (out.counts[sub.quest_code] != null) { body.amount = out.counts[sub.quest_code]; delete out.counts[sub.quest_code]; }
        ['counts', 'awarded', 'numbers'].forEach(function (k) { if (Object.keys(out[k]).length) body[k] = out[k]; });
        return body;
      },
      // {given, full}: what the boxes come to, and at full points
      worth: function () {
        var sum = 0;
        var full = 0;
        chosen().forEach(function (pk) { var w = pk.input.worth(); sum += w.given; full += w.full; });
        return { given: Math.round(sum * 100) / 100, full: Math.round(full * 100) / 100 };
      }
    };
  }
  // what an accepted submission's credit gave, from its quest's parts
  function creditWorth(sub) {
    var sum = 0;
    var c = sub.credit;
    c.codes.forEach(function (code) {
      var p = (sub.codes || []).filter(function (x) { return x.code === code; })[0] ||
        (code === sub.quest_code ? { points: sub.points, scoring: sub.scoring || '', bands: sub.bands || [] } : { points: 0 });
      if (c.points && c.points[code] != null) { sum += Number(c.points[code]) || 0; return; }
      if (p.scoring === 'counted') return;
      if (p.scoring === 'tiered') { sum += bandOf(p.bands, c.numbers && c.numbers[code]) * (Number(c.amount) < 0 ? -1 : 1); return; }
      var parts = c.amounts;
      sum += Number(p.points || 0) * Number(parts && parts[code] != null ? parts[code] : countIn(c, code));
    });
    return Math.round(sum * 100) / 100;
  }
  // A challenge counting numbers reads the quest's number question, or,
  // where it asks none, a number a reviewer typed, kept in the answer as
  // an entry of its own (Counted). An answer sent before the questions
  // changed may hold it somewhere else, so a slot holding another kind
  // falls back to the first number in the answer, as answerTo in tally.ts
  // does.
  function countAt(list) {
    var at = -1;
    list.some(function (q, i) { if (q.kind === 'count') { at = i; return true; } return false; });
    return at;
  }
  function countOf(answer, list) {
    var given = answer ? [answer].concat(answer.more || []) : [];
    var at = countAt(list);
    // a question left unanswered is no number at all
    if (at !== -1 && at < given.length && given[at] === null) return null;
    var hit = at !== -1 && given[at] && given[at].kind === 'count' ? given[at]
      : given.filter(function (e) { return e && e.kind === 'count'; })[0];
    return hit && hit.value != null ? Number(hit.value) : null;
  }
  function withCount(answer, list, n) {
    var at = countAt(list);
    if (at !== -1) {
      var given = answer ? [answer].concat(answer.more || []) : [];
      var values = list.map(function (q, i) { return given[i] && given[i].kind === q.kind ? given[i].value : null; });
      values[at] = n;
      return answerFrom(list, values);
    }
    var entry = n == null ? null : { kind: 'count', value: n, prompt: 'Counted' };
    var counted = function (e) { return !!e && e.kind === 'count' && e.prompt === 'Counted'; };
    if (!answer || counted(answer)) return entry;
    var top = {};
    Object.keys(answer).forEach(function (k) { top[k] = answer[k]; });
    var more = (answer.more || []).filter(function (e) { return !counted(e); });
    if (entry) more.push(entry);
    if (more.length) top.more = more; else delete top.more;
    return top;
  }
  function numberChallenge(sub) { return sub.tally === 'sum' || sub.tally === 'highest'; }
  // the number in a box, started from what is there
  function countBox(sub) {
    if (!numberChallenge(sub)) return null;
    var list = (state.reviewQuestions || {})[sub.group_id] || [];
    var at = countAt(list);
    var was = countOf(sub.answer, list);
    var input = h('input');
    input.type = 'number'; input.min = '0'; input.step = 'any'; input.inputMode = 'decimal';
    if (was != null) input.value = String(was);
    var label = h('label', 'review-amount review-count');
    label.appendChild(h('span', null, (at !== -1 && list[at].prompt) || 'Counted'));
    label.appendChild(input);
    var now = function () { var v = input.value.trim(); return v === '' ? null : Number(v); };
    return {
      node: label, input: input,
      changed: function () { return now() !== was; },
      answer: function () { return withCount(sub.answer, list, now()); }
    };
  }
})(window.dash);
