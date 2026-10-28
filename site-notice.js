// Notice strip across the top of the landing and booking pages.
// Loaded with a plain <script> right after <body>, so the strip is in place before the page
// draws (no jump). To change the message, edit NOTICE below and bump ?v= on both pages.
// The strip hides itself outside its dates, so ending it needs no deploy.
(function () {
  var NOTICE = {
    text: 'For Christmas hotel bookings, please contact the branch:',
    branches: [
      { name: 'Estancia', phone: '+639276073681', display: '+63 927 607 3681' },
      { name: 'Eastwood', phone: '+639567819641', display: '+63 956 781 9641' }
    ]
  };

  // Is the notice still relevant at this moment? `now` is a Date (the visitor's clock).
  // Write dates with the Philippine offset, e.g. new Date('2026-12-26T00:00:00+08:00'),
  // so the cut-off is the same for every visitor whatever their device's timezone.
  function isNoticeShowing(now) {
    // Shows until the end of Christmas Day; from 26 Dec (PHT) the strip is gone by itself.
    return now < new Date('2026-12-26T00:00:00+08:00');
  }

  if (!isNoticeShowing(new Date())) return;

  var script = document.currentScript;
  var strip = document.createElement('div');
  strip.className = 'site-notice' + (script && script.hasAttribute('data-overlay') ? ' site-notice--overlay' : '');
  strip.setAttribute('role', 'status');
  strip.innerHTML = '<span>' + NOTICE.text + '</span> ' + NOTICE.branches.map(function (b) {
    return '<span class="site-notice-branch">' + b.name + ' <a href="tel:' + b.phone + '">' + b.display + '</a></span>';
  }).join(' <span aria-hidden="true">·</span> ');

  if (script) script.insertAdjacentElement('afterend', strip);
  else document.body.insertBefore(strip, document.body.firstChild);
})();
