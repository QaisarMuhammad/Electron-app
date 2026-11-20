/*
 * loading.html - after 12 seconds without the POS appearing, reveal the "taking longer than usual" hint.
 * Classic script (no imports) so the loading page costs one extra tiny file and nothing else.
 */
(function () {
  'use strict';
  var hint = document.getElementById('hint');
  if (!hint) return;
  setTimeout(function () {
    hint.hidden = false;
  }, 12000);
})();
