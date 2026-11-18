// Runs last, once every other file has: opens the page signed in or at the sign-in form.
(function (dash) {
  // core.js
  var session = dash.session, setFileCookie = dash.setFileCookie;
  // tabs.js
  var show = dash.show;

  setFileCookie(session());
  if (session()) show(true); else show(false);
})(window.dash);
