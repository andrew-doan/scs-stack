// The Queue tab (review in the code): what waits on review, one
// submission on its own, claiming, the decision buttons, and the video
// encoders.
(function (dash) {
  // core.js
  var amountText = dash.amountText, api = dash.api, btn = dash.btn, busy = dash.busy, byName = dash.byName,
    canTab = dash.canTab, chip = dash.chip, done = dash.done, el = dash.el, fmtTime = dash.fmtTime,
    h = dash.h, heldIn = dash.heldIn, hiddenTeamNames = dash.hiddenTeamNames, holdOpen = dash.holdOpen,
    holdPlace = dash.holdPlace, letGo = dash.letGo, post = dash.post, postForm = dash.postForm,
    session = dash.session, state = dash.state, toast = dash.toast, whoAmI = dash.whoAmI;
  // uploads.js
  var appendProof = dash.appendProof, jpegPicks = dash.jpegPicks, PT_ACCEPT = dash.PT_ACCEPT,
    PT_KIND = dash.PT_KIND, PT_KINDS = dash.PT_KINDS, ptKindOf = dash.ptKindOf, renameRow = dash.renameRow,
    sendName = dash.sendName;
  // preview.js
  var reviewMedia = dash.reviewMedia;
  // parts.js
  var answerFrom = dash.answerFrom, answerInput = dash.answerInput, answerParts = dash.answerParts,
    countBox = dash.countBox, creditForm = dash.creditForm, creditWorth = dash.creditWorth,
    numberChallenge = dash.numberChallenge, worthWords = dash.worthWords;
  // tabs.js
  var activeTab = dash.activeTab, openTab = dash.openTab, refreshTeamsOnly = dash.refreshTeamsOnly,
    rememberTab = dash.rememberTab, REVIEW_KEY = dash.REVIEW_KEY;

  dash.loadEncoder = loadEncoder;
  dash.openSubmission = openSubmission;
  dash.loadReview = loadReview;
  dash.undoLabel = undoLabel;
  dash.takenBackText = takenBackText;
  dash.putBackLabel = putBackLabel;

  // ---- the video encoders ----
  // They run on people's laptops, any number of them, so the box is a
  // list: which machines are there, what each is doing and how fast it
  // gets through a video. Nothing polls — it refreshes with the Review
  // tab and on either Refresh button.
  function encoderPace(avgMs) {
    var secs = Math.round(avgMs / 1000);
    if (secs < 90) return 'about ' + secs + 's per video';
    var mins = Math.floor(secs / 60);
    var rest = secs % 60;
    return 'about ' + mins + 'm' + (rest ? ' ' + rest + 's' : '') + ' per video';
  }
  function paintEncoders(d) {
    var counts = el('enc-counts');
    if (!counts) return;
    // A skipped video is out of the queue and serves to nobody, so it
    // has to be visible here — it was counted nowhere, and a batch of
    // failures looked like videos that had stopped existing.
    counts.textContent = d.waiting + ' waiting · ' + d.encoding + ' encoding · ' + d.done + ' done' +
      (d.skipped ? ' · ' + d.skipped + ' gave up' : '');
    counts.classList.toggle('has-failed', !!d.skipped);
    var list = el('enc-list');
    list.textContent = '';
    var machines = d.encoders || [];
    if (d.skipped) {
      list.appendChild(h('p', 'enc-none enc-failed',
        'A video that gave up shows to organisers only. Retry failed videos puts it back on the pile.'));
    }
    if (!machines.length) {
      list.appendChild(h('p', 'muted enc-none',
        'No machine has run the encoder yet, and until one does videos show to organisers only. ' +
        'ENCODER.md in the tab folder says how to start one.'));
      return;
    }
    machines.forEach(function (e) {
      var row = h('div', 'enc-row' + (e.online ? '' : ' is-off'));
      row.appendChild(h('strong', null, e.name));
      var what = e.online
        ? 'Online, ' + (e.state === 'encoding'
          ? 'encoding ' + (e.working_name || e.working_on || 'a video')
          : 'idle')
        : 'Offline' + (e.last_seen ? ', last seen ' + fmtTime(e.last_seen) : '');
      row.appendChild(h('span', 'enc-when', what));
      var tally = e.jobs_done + (e.jobs_done === 1 ? ' video done' : ' videos done');
      if (e.jobs_done > 0 && e.avg_ms > 0) tally += ' · ' + encoderPace(e.avg_ms);
      row.appendChild(h('span', 'muted', tally));
      list.appendChild(row);
    });
  }
  function loadEncoder() {
    if (!el('enc-counts')) return;
    api('/api/console/encoder/status').then(function (d) { if (d.ok) paintEncoders(d); }).catch(function () {});
  }
  if (el('enc-release')) {
    el('enc-release').addEventListener('click', function () {
      busy(el('enc-release'), post('/api/console/encoder/release')).then(function (r) {
        if (done(r, function () {
          if (!r.freed) return 'Every video is either done or already waiting';
          var parts = [];
          if (r.held) parts.push(r.held + ' being held');
          if (r.failed) parts.push(r.failed + ' that gave up');
          return 'Put back ' + parts.join(' and ');
        })) loadEncoder();
      }).catch(function () {});
    });
  }

  // ---- review ----
  // Taking a submission happens as a reviewer opens it, so it is quiet
  // in both directions: nothing is disabled while it runs, and a worker
  // that cannot be reached says nothing rather than putting an error in
  // front of someone who did not ask for anything.
  function claimReview(id) {
    return fetch('/api/console/review/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session() },
      body: JSON.stringify({ id: id })
    }).then(function (res) {
      return res.json().catch(function () { return null; });
    }).catch(function () { return null; });
  }
  // the quests with something in this status, each with how many, and
  // the one picked kept even when it has none
  function drawReviewQuests(counts, picked) {
    var sel = el('review-quest');
    sel.textContent = '';
    var shown = (counts || []).map(function (c) {
      return { key: c.key, name: c.name, n: c.n - (state.hideHidden ? c.hidden : 0) };
    }).filter(function (c) { return c.n > 0 || c.key === picked; });
    shown.sort(function (a, b) { return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: 'base' }); });
    var total = shown.reduce(function (sum, c) { return sum + c.n; }, 0);
    var every = h('option', null, 'Every quest (' + total + ')');
    every.value = '';
    sel.appendChild(every);
    if (picked && !shown.some(function (c) { return c.key === picked; })) shown.unshift({ key: picked, name: '', n: 0 });
    shown.forEach(function (c) {
      var o = h('option', null, c.key + (c.name && c.name !== c.key ? ' · ' + c.name : '') + ' (' + c.n + ')');
      o.value = c.key;
      sel.appendChild(o);
    });
    sel.value = picked || '';
    return total;
  }
  el('review-quest').addEventListener('change', function () { state.reviewQuest = el('review-quest').value; loadReview(); });
  // the same for teams, by name, a hidden team's count left out while
  // the switch hides them
  function drawReviewTeams(counts, picked) {
    var sel = el('review-team');
    sel.textContent = '';
    var shown = (counts || []).map(function (c) {
      return { id: String(c.id), name: c.name, hidden: c.hidden, n: state.hideHidden && c.hidden ? 0 : c.n };
    }).filter(function (c) { return c.n > 0 || c.id === picked; });
    shown.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }); });
    var total = shown.reduce(function (sum, c) { return sum + c.n; }, 0);
    var every = h('option', null, 'Every team (' + total + ')');
    every.value = '';
    sel.appendChild(every);
    if (picked && !shown.some(function (c) { return c.id === picked; })) shown.unshift({ id: picked, name: reviewTeamName(picked), n: 0 });
    shown.forEach(function (c) {
      var o = h('option', null, c.name + (c.hidden ? ' · hidden' : '') + ' (' + c.n + ')');
      o.value = c.id;
      sel.appendChild(o);
    });
    sel.value = picked || '';
  }
  el('review-team').addEventListener('change', function () { state.reviewTeam = el('review-team').value; loadReview(); });
  function reviewTeamName(id) {
    var t = state.teams.filter(function (x) { return String(x.id) === id; })[0];
    return t ? t.name : '';
  }
  // On Review narrowed to one team: where its points stand, and the way
  // to its ledger.
  function reviewLedgerLine(team) {
    var line = el('review-ledger');
    line.textContent = '';
    var t = team ? state.teams.filter(function (x) { return String(x.id) === String(team); })[0] : null;
    line.classList.toggle('hidden', !t || !canTab('ledger'));
    if (!t || !canTab('ledger')) return;
    line.appendChild(h('strong', null, t.name));
    line.appendChild(document.createTextNode(' · ' + amountText(t.pts) + ' points'));
    line.appendChild(btn('Open the ledger', 'quiet small', function () { dash.openLedger(t.id); }));
  }
  // the Queue showing one submission: the filters step aside for a way
  // back to the queue
  function reviewOneLine(one) {
    var line = el('review-one');
    line.textContent = '';
    line.classList.toggle('hidden', !one);
    el('review-quest').classList.toggle('hidden', !!one);
    el('review-team').classList.toggle('hidden', !!one);
    if (!one) return;
    line.appendChild(document.createTextNode('One submission. '));
    line.appendChild(btn('Back to the queue', 'quiet small', function () { state.reviewOne = null; loadReview(); }));
  }
  // A submission's card on Review, every status shown if it is filtered out.
  // One submission's card on the Queue, whatever its status, from a line
  // on a ledger or a desk; Back to the queue leaves it.
  function openSubmission(id) {
    if (!canTab('review')) return;
    state.reviewOne = id;
    if (activeTab().dataset.tab === 'review') loadReview();
    else if (openTab('review')) rememberTab('review');
  }

  // The queue: what waits on review, oldest first, narrowed to a quest
  // or a team; or one submission in whatever state it is in, opened from
  // a ledger or a desk. Only the answer to the latest load is drawn, and
  // a card with a form open in it is kept as it is.
  var reviewAsked = 0;
  function loadReview() {
    var one = state.reviewOne || null;
    var status = one ? 'all' : 'pending';
    var quest = state.reviewQuest || '';
    var team = state.reviewTeam || '';
    if (team && state.teams.length && !reviewTeamName(team)) team = state.reviewTeam = ''; // deleted since it was picked
    try { localStorage.setItem(REVIEW_KEY, JSON.stringify({ quest: quest, team: team })); } catch (e) {}
    reviewOneLine(one);
    reviewLedgerLine(one ? '' : team);
    var asked = ++reviewAsked;
    api('/api/console/submissions?' + (one ? 'id=' + one : 'status=pending' + (quest ? '&quest=' + encodeURIComponent(quest) : '') +
      (team ? '&team_id=' + encodeURIComponent(team) : ''))).then(function (d) {
      if (asked !== reviewAsked || !d.ok || (state.reviewOne || null) !== one) return;
      state.reviewQuestions = d.questions || {};
      state.reviewPlaces = d.places || null;
      var hiddenNames = hiddenTeamNames();
      var subs = d.submissions.filter(function (sub) { return !hiddenNames[String(sub.team_name).toLowerCase()]; });
      var total = d.counts && !one ? drawReviewQuests(d.counts, quest) : subs.length;
      if (d.team_counts && !one) drawReviewTeams(d.team_counts, team);
      var waiting = d.pending ? d.pending.n - (state.hideHidden ? d.pending.hidden : 0) : status === 'pending' ? total : null;
      if (waiting != null) el('review-count').textContent = waiting ? String(waiting) : '';
      var list = el('review-list');
      var restore = holdPlace(list, '.review-card');
      var take = heldIn(list);
      list.textContent = '';
      var which = [team ? reviewTeamName(team) : '', quest].filter(Boolean).join(' on ');
      el('review-empty').textContent = subs.length ? '' : one ? 'That submission is not there any more.'
        : 'Nothing waiting' + (which ? ' for ' + which : '') + '.';
      subs.forEach(function (sub) { list.appendChild(take(sub.id) || reviewCard(sub, !!one)); });
      restore();
    }).catch(function () {});
  }
  // One submission's card. Opening a form in it holds the card through
  // a reload of the list; Cancel draws the card again on its own. A write
  // that is refused looks the submission up again: if it has moved on
  // (decided by somebody else) the card shows it as it is now, and if not
  // the form stays as it was typed.
  function reviewCard(sub, one) {
    var card = h('div', 'card review-card');
    card.setAttribute('data-id', sub.id);
    var ctl = {
      opened: function () { holdOpen(card, sub.id); },
      cancel: function () { swapCard(card, reviewCard(sub, one)); },
      after: function (r, text, teams) {
        if (done(r, text)) {
          letGo(card);
          loadReview();
          if (teams) refreshTeamsOnly();
        } else if (r && !r.cancelled) recheckCard(card, sub, one);
      }
    };
    var head = h('div', 'review-head');
    head.appendChild(h('strong', null, sub.team_name));
    head.appendChild(chip(sub.quest_code));
    head.appendChild(h('span', null, (sub.quest_name ? sub.quest_name + ' · ' : '') + (sub.points != null ? sub.points + ' pts' : 'not on the tab')));
    head.appendChild(h('span', 'muted', fmtTime(sub.submitted_at)));
    // every other status says itself on the line under the files
    if (one && sub.status === 'pending') head.appendChild(h('span', 'pill pending', 'pending'));
    if (sub.gallery) head.appendChild(h('span', 'pill same', 'gallery'));
    if (sub.added_by) head.appendChild(h('span', 'muted', 'Recorded by ' + byName(sub.added_by)));
    // who else is on this one. Advice, not a lock: the buttons below
    // stay live either way.
    var claimLine = h('span', 'review-claim');
    head.appendChild(claimLine);
    function showClaim(name) {
      claimLine.textContent = name && name !== whoAmI() ? 'Being reviewed by ' + name : '';
    }
    showClaim(sub.claimed_by);
    card.appendChild(head);
    if (sub.note) card.appendChild(h('p', 'review-note', sub.note));
    var parts = answerParts(sub.answer);
    if (parts.length) {
      var ans = h('div', 'review-answer');
      parts.forEach(function (part) {
        var line = h('p');
        line.appendChild(h('strong', null, part.q));
        line.appendChild(document.createTextNode(part.text));
        ans.appendChild(line);
      });
      card.appendChild(ans);
    }

    card.appendChild(reviewMedia(sub.media));

    if (sub.status === 'pending') {
      // Reading a submission takes it in your name, once, without
      // saying anything: the first touch on the card is the claim.
      // Somebody else already on it says so and nothing is taken.
      var claimed = false;
      var claimThis = function () {
        if (claimed) return;
        claimed = true;
        claimReview(sub.id).then(function (r) {
          if (!r) return;
          if (r.ok) { sub.claimed_by = r.claimed_by; showClaim(r.claimed_by); return; }
          if (r.claimed_by) {
            sub.claimed_by = r.claimed_by;
            showClaim(r.claimed_by);
            toast(r.claimed_by + ' is reviewing this one.');
          }
        });
      };
      card.addEventListener('pointerdown', claimThis);
      card.addEventListener('focusin', claimThis);

      // what this team already holds on this quest's codes: a
      // second acceptance should be a decision, not a slip
      var already = Object.keys(sub.credited || {}).filter(function (code) {
        return Number(sub.credited[code]) > 0;
      });
      if (already.length) {
        card.appendChild(h('p', 'review-warn',
          'This team already has points on ' + already.join(', ') + '.'));
      }

      var actions = h('div', 'review-actions');
      var form = creditForm(sub, null);
      // a deleted quest's submission can be rejected or deleted, not credited
      var credits = !sub.deleted_from;
      if (form.codesRow && credits) card.appendChild(form.codesRow);
      var counted = countBox(sub);
      var accept = btn('Accept', null, function () {
        // A number put right goes in once the accept has gone through,
        // so a refused accept leaves the team's number as it was.
        var number = counted && counted.changed() ? counted.answer() : null;
        busy(accept, post('/api/console/submissions/accept', form.body()).then(function (r) {
          if (!r || !r.ok || !number) return r;
          return post('/api/console/submissions/answer', { id: sub.id, answer: number }).then(function (a) {
            if (!a || !a.ok) r.unsaved = (a && a.error) || 'That did not go through.';
            return r;
          }, function () { r.unsaved = 'Could not reach the worker.'; return r; });
        })).then(function (r) {
          function said() {
            if (r.full != null && r.gained !== r.full) return r.team + ' +' + r.gained + ' of ' + r.full + ' points on ' + r.quest + ' · total ' + r.total;
            return r.team + ' +' + r.gained + ' on ' + r.quest + ' · total ' + r.total;
          }
          if (r && r.ok && r.unsaved) {
            toast(said() + '. The number did not save: ' + r.unsaved, true);
            letGo(card);
            loadReview();
            refreshTeamsOnly();
            return;
          }
          ctl.after(r, said, true);
        }).catch(function () {});
      });
      var reject = btn('Reject', 'danger', function () {
        // the reason appears in the card, then a second click sends it
        var reason = h('input', 'reason'); reason.placeholder = 'Reason the team will see';
        var send = btn('Send rejection', 'danger', function () {
          busy(send, post('/api/console/submissions/reject', { id: sub.id, reason: reason.value })).then(function (r) {
            ctl.after(r, 'Rejected ' + sub.quest_code + ' for ' + sub.team_name);
          }).catch(function () {});
        });
        var cancel = btn('Cancel', 'quiet', ctl.cancel);
        reason.addEventListener('keydown', function (e) { if (e.key === 'Enter') send.click(); if (e.key === 'Escape') ctl.cancel(); });
        ctl.opened();
        actions.textContent = '';
        actions.appendChild(reason); actions.appendChild(send); actions.appendChild(cancel);
        reason.focus();
      });
      // a number or a part's box being typed in holds the card too
      actions.addEventListener('input', ctl.opened);
      if (form.codesRow) form.codesRow.addEventListener('change', ctl.opened);
      if (credits) {
        if (counted) actions.appendChild(counted.node);
        if (form.amountLabel) actions.appendChild(form.amountLabel);
        if (form.pointsLabel) actions.appendChild(form.pointsLabel);
        actions.appendChild(accept);
      }
      actions.appendChild(reject);
      actions.appendChild(moreMenu(sub, card, actions, ctl));
      card.appendChild(actions);
    } else {
      var stamp = h('p', 'review-note muted');
      stamp.appendChild(h('span', 'pill ' + sub.status, sub.status));
      stamp.appendChild(document.createTextNode(' by ' + byName(sub.reviewed_by) +
        (sub.part ? ' · part marks, ' + sub.part.given + ' of ' + sub.part.of + ' points' : '')));
      card.appendChild(stamp);
      // the words the team was given, on their own line
      if (sub.reason) card.appendChild(h('p', 'review-reason', (sub.status === 'deleted' ? 'Note: ' : 'Reason: ') + sub.reason));
      if (sub.status !== 'deleted') {
        var later = h('div', 'review-actions');
        decisionButtons(sub, card, later, ctl);
        later.appendChild(moreMenu(sub, card, later, ctl));
        card.appendChild(later);
      } else if (sub.added_by && sub.reason === 'Taken back' && sub.credit && !sub.deleted_from) {
        // an organiser's entry taken back can be put back
        var again = h('div', 'review-actions');
        again.appendChild(btn('Put back', 'quiet', function () {
          var worth = creditWorth(sub);
          var go = btn(putBackLabel(worth), null, function () {
            busy(go, post('/api/console/points/redo', { id: sub.id })).then(function (r) {
              ctl.after(r, function () { return 'Put back for ' + sub.team_name + ' · total ' + r.total; }, true);
            }).catch(function () {});
          });
          ctl.opened();
          again.textContent = '';
          again.appendChild(go);
          again.appendChild(btn('Cancel', 'quiet', ctl.cancel));
        }));
        card.appendChild(again);
      }
    }
    return card;
  }
  function swapCard(was, card) {
    if (was.parentNode) was.parentNode.replaceChild(card, was);
  }
  // After a refusal: the submission as it is now. One that has not moved
  // keeps its card and what was typed in it.
  function stateOf(s) { return JSON.stringify([s.status, s.credit || null, s.reason || null, s.answer || null]); }
  function recheckCard(card, sub, one) {
    api('/api/console/submissions?id=' + sub.id).then(function (d) {
      if (!d || !d.ok || !card.parentNode) return;
      var now = d.submissions[0];
      if (now && stateOf(now) === stateOf(sub)) return;
      Object.keys(d.questions || {}).forEach(function (k) {
        state.reviewQuestions = state.reviewQuestions || {};
        state.reviewQuestions[k] = d.questions[k];
      });
      if (now) { swapCard(card, reviewCard(now, one)); return; }
      var gone = h('div', 'card review-card');
      gone.setAttribute('data-id', sub.id);
      gone.appendChild(h('p', 'muted', sub.quest_code + ' for ' + sub.team_name + ' is not there any more.'));
      swapCard(card, gone);
    }).catch(function () {});
  }
  // The buttons a card needs once in a while, behind More. Each opens its
  // boxes in the card's row of actions, in place of the row.
  function moreMenu(sub, card, actions, ctl) {
    var menu = h('details', 'menu review-more');
    menu.appendChild(h('summary', null, 'More'));
    var pop = h('div', 'menu-pop');
    if (sub.status !== 'pending') countButton(sub, card, actions, pop, ctl);
    answerButton(sub, card, actions, pop, ctl);
    filesButton(sub, card, actions, pop, ctl);
    pop.appendChild(deleteButton(sub, actions, ctl));
    menu.appendChild(pop);
    return menu;
  }
  // Change number on a decided card: the box, then Save
  function countButton(sub, card, actions, into, ctl) {
    if (!numberChallenge(sub)) return;
    into.appendChild(btn('Change number', 'quiet', function () {
      var box = countBox(sub);
      var save = btn('Save', null, function () {
        if (!box.changed()) { ctl.cancel(); return; }
        busy(save, post('/api/console/submissions/answer', { id: sub.id, answer: box.answer() })).then(function (r) {
          ctl.after(r, 'Saved the number for ' + sub.team_name);
        }).catch(function () {});
      });
      ctl.opened();
      actions.textContent = '';
      actions.appendChild(box.node);
      actions.appendChild(save);
      actions.appendChild(btn('Cancel', 'quiet', ctl.cancel));
      box.input.focus();
    }));
  }
  // Edit answers: the quest's questions as boxes in place of what the
  // team said, started from it. A codes question is the codes the team
  // ticked, which Accept and Change decide on, so it is kept as sent.
  function answerButton(sub, card, actions, into, ctl) {
    var list = (state.reviewQuestions || {})[sub.group_id] || [];
    if (!list.some(function (q) { return q.kind !== 'codes'; })) return;
    var open = btn('Edit answers', 'quiet', function () {
      ctl.opened();
      var given = sub.answer ? [sub.answer].concat(sub.answer.more || []) : [];
      var form = h('div', 'pt-answer review-answer-edit');
      var reads = list.map(function (q, i) {
        var was = given[i] && given[i].kind === q.kind ? given[i].value : null;
        if (q.kind === 'codes') return function () { return was; };
        return answerInput(form, q, state.reviewPlaces, was);
      });
      var shown = card.querySelector('.review-answer');
      if (shown) card.replaceChild(form, shown);
      else card.insertBefore(form, sub.note ? card.firstChild.nextSibling.nextSibling : card.firstChild.nextSibling);
      var save = btn('Save answers', null, function () {
        var answer = answerFrom(list, reads.map(function (read) { return read(); }));
        busy(save, post('/api/console/submissions/answer', { id: sub.id, answer: answer })).then(function (r) {
          ctl.after(r, function () { return r.unchanged ? 'Nothing changed.' : 'Saved the answers for ' + sub.team_name; });
        }).catch(function () {});
      });
      actions.textContent = '';
      actions.appendChild(save);
      actions.appendChild(btn('Cancel', 'quiet', ctl.cancel));
      var first = form.querySelector('input, select');
      if (first) first.focus();
    });
    into.appendChild(open);
  }
  // Delete, from any state: a note box for the team, then a second
  // press, which says what comes off the tab with it.
  function deleteButton(sub, actions, ctl) {
    return btn('Delete', 'quiet danger', function () {
      var worth = sub.status === 'accepted' && sub.credit ? creditWorth(sub) : 0;
      var note = h('input', 'reason'); note.placeholder = 'Note the team will see';
      var go = btn(worth ? 'Delete and ' + pointsWords(worth) : 'Delete submission', 'danger', function () {
        busy(go, post('/api/console/submissions/delete', { id: sub.id, note: note.value })).then(function (r) {
          ctl.after(r, function () { return 'Deleted ' + sub.quest_code + ' for ' + sub.team_name + (r.total != null ? ' · total ' + r.total : ''); },
            !!(r && r.total != null));
        }).catch(function () {});
      });
      var cancel = btn('Cancel', 'quiet', ctl.cancel);
      note.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') ctl.cancel(); });
      ctl.opened();
      actions.textContent = '';
      actions.appendChild(note); actions.appendChild(go); actions.appendChild(cancel);
      note.focus();
    });
  }
  // Files added to a submission already sent: proof the team sent another
  // way, or a file that did not arrive. The kinds its quest takes are
  // picked here, named in rows as on the desk, and sent the way the
  // desk sends them. A quest that takes no files has no button.
  function filesButton(sub, card, actions, into, ctl) {
    var kinds = sub.files && Array.isArray(sub.files.kinds) ? sub.files.kinds : ['photo', 'video'];
    if (!kinds.length) return;
    var picker = h('input', 'hidden');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = kinds.map(function (k) { return PT_ACCEPT[k]; }).join(',');
    card.appendChild(picker);
    var files = [];
    var names = [];
    var list = h('div');
    var note = h('span', 'muted');
    var send = btn('Add to submission', null, function () {
      var picked = files.slice();
      var typed = picked.map(function (f, i) { return sendName(f, names[i]); });
      var form = new FormData();
      form.append('id', String(sub.id));
      busy(send, appendProof(form, picked, typed, function (share) {
        note.textContent = 'Sending ' + Math.round(share * 100) + '%';
      }).then(function () {
        return postForm('/api/console/submissions/files', form);
      })).then(function (r) {
        note.textContent = '';
        ctl.after(r, function () { return 'Added ' + filesWords(picked) + ' to ' + sub.quest_code + ' for ' + sub.team_name; });
      }).catch(function (err) {
        note.textContent = '';
        if (err && err.error) toast(err.error, true);
      });
    });
    function draw() {
      list.textContent = '';
      files.forEach(function (f, i) {
        list.appendChild(renameRow(f, names, i, function () {
          files.splice(i, 1);
          names.splice(i, 1);
          if (files.length) draw(); else ctl.cancel();
        }));
      });
    }
    picker.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(picker.files);
      picker.value = '';
      if (!picked.length) return;
      ctl.opened();
      jpegPicks(picked).then(function (ready) {
        if (!files.length) {
          actions.textContent = '';
          card.insertBefore(list, actions);
          actions.appendChild(btn('Add more', 'quiet', function () { picker.click(); }));
          actions.appendChild(send);
          actions.appendChild(btn('Cancel', 'quiet', ctl.cancel));
          actions.appendChild(note);
        }
        files = files.concat(ready);
        draw();
      });
    });
    into.appendChild(btn('Add ' + (kinds.length === 1 ? PT_KINDS[kinds[0]] : 'files'), 'quiet', function () { picker.click(); }));
  }
  // what was added, for the toast: "a photo", "2 photos", "3 files"
  function filesWords(files) {
    var kinds = files.map(ptKindOf);
    if (!kinds.every(function (k) { return k && k === kinds[0]; })) return files.length + ' files';
    return files.length === 1 ? PT_KIND[kinds[0]] : files.length + ' ' + PT_KINDS[kinds[0]];
  }
  // A decision already made, changed. An accepted card has Change (the
  // Accept boxes, filled in from what it credited) and Undo; a rejected
  // one has Undo. Undo is the same word whoever made the line: a team's
  // submission goes back to the queue, an organiser's entry is taken
  // back, and either way what it gave comes off (or, for one that took
  // points off, goes back on).
  function pointsWords(worth) {
    var n = Math.abs(worth);
    var pts = n + (n === 1 ? ' point' : ' points');
    return worth > 0 ? 'take ' + pts + ' off' : 'give ' + pts + ' back';
  }
  function undoLabel(worth) {
    if (!worth) return 'Undo it';
    var w = pointsWords(worth);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  function takenBackText(worth, team) {
    var n = Math.abs(worth);
    if (!worth) return 'Undone';
    return worth > 0 ? 'Took ' + n + ' off ' + team : 'Gave ' + n + ' back to ' + team;
  }
  // and putting an organiser's entry back does it again
  function putBackLabel(worth) {
    var n = Math.abs(worth);
    if (!worth) return 'Put it back';
    return worth > 0 ? 'Put back ' + n + (n === 1 ? ' point' : ' points') : 'Take ' + n + (n === 1 ? ' point' : ' points') + ' off again';
  }

  function decisionButtons(sub, card, actions, ctl) {
    function after(r, text) { ctl.after(r, text, true); }
    var accepted = sub.status === 'accepted' && !!sub.credit;
    var worth = accepted ? creditWorth(sub) : 0;
    // an adjustment is changed by taking it back and adjusting again, and
    // a deleted quest's submission is not credited again
    if (accepted && sub.credit.amount > 0 && !sub.credit.points && !sub.deleted_from) {
      actions.appendChild(btn('Change', 'quiet', function () {
        var line = h('span', 'muted');
        var form = creditForm(sub, sub.credit, showWorth);
        function showWorth() {
          var w = form.worth();
          line.textContent = worthWords(w.given, w.full) + ' · was ' + worth;
        }
        var save = btn('Save', null, function () {
          busy(save, post('/api/console/submissions/revise', form.body())).then(function (r) {
            after(r, function () {
              if (r.unchanged) return 'Nothing changed.';
              return r.team + ': ' + r.quest + ' now worth ' + r.gained + (r.full !== r.gained ? ' of ' + r.full : '') + ' · total ' + r.total;
            });
          }).catch(function () {});
        });
        ctl.opened();
        actions.textContent = '';
        if (form.codesRow) card.insertBefore(form.codesRow, actions);
        if (form.amountLabel) actions.appendChild(form.amountLabel);
        if (form.pointsLabel) actions.appendChild(form.pointsLabel);
        actions.appendChild(line);
        actions.appendChild(save);
        actions.appendChild(btn('Cancel', 'quiet', ctl.cancel));
        showWorth();
      }));
    }
    if (sub.added_by ? !accepted : !accepted && sub.status !== 'rejected') return;
    function undo(button) {
      var asked = sub.added_by
        ? post('/api/console/points/undo', { id: sub.id })
        : post('/api/console/submissions/reopen', { id: sub.id });
      busy(button, asked).then(function (r) {
        after(r, function () {
          if (sub.added_by) return takenBackText(worth, sub.team_name) + ' · total ' + r.total;
          return sub.quest_code + ' for ' + sub.team_name + ' is back in the queue' + (r.was === 'accepted' ? ' · total ' + r.total : '');
        });
      }).catch(function () {});
    }
    var first = btn('Undo', 'quiet', function () {
      if (!accepted) { undo(first); return; }
      var go = btn(undoLabel(worth), 'danger', function () { undo(go); });
      ctl.opened();
      actions.textContent = '';
      actions.appendChild(go);
      if (!sub.added_by) actions.appendChild(h('span', 'muted', 'It goes back to the queue.'));
      actions.appendChild(btn('Cancel', 'quiet', ctl.cancel));
    });
    actions.appendChild(first);
  }
  el('review-refresh').addEventListener('click', function () { loadReview(); loadEncoder(); });
  // the filters last used on this device, put back before the first load
  (function () {
    var kept = null;
    try { kept = JSON.parse(localStorage.getItem(REVIEW_KEY) || 'null'); } catch (e) {}
    if (!kept) return;
    state.reviewQuest = String(kept.quest || '');
    state.reviewTeam = String(kept.team || '');
  })();
})(window.dash);
