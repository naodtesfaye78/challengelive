/* A FAKE version of Twitch's helper script, used only in test mode (DEV_HARNESS=1).
   It pretends to be Twitch so ChallengeLive can be tested without Twitch.
   Options come from the page address, for example:
   ?role=viewer&user=1001&bits=1&linked=1&channel=9999 */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var role = q.get('role') || 'viewer';
  var user = (q.get('user') || '1001').replace(/\D/g, '');
  var channel = q.get('channel') || '9999';
  var linked = q.get('linked') !== '0';
  var bitsOn = q.get('bits') !== '0';
  var anon = q.get('anon') === '1';

  var authCbs = [];
  var txCbs = [];
  var cancelCbs = [];
  var featureCbs = [];
  var viewerCbs = [];
  var authData = null;

  function qs() {
    return '?role=' + encodeURIComponent(role) + '&user=' + user + '&channel=' + channel + '&linked=' + (linked ? 1 : 0) + (anon ? '&anon=1' : '');
  }

  fetch('/dev/token' + qs()).then(function (r) { return r.json(); }).then(function (j) {
    authData = { token: j.token, channelId: channel, clientId: 'dev', userId: (anon ? 'A' : 'U') + user };
    authCbs.forEach(function (cb) { cb(authData); });
  });

  window.Twitch = {
    ext: {
      onAuthorized: function (cb) { authCbs.push(cb); if (authData) cb(authData); },
      onError: function () {},
      onContext: function () {},
      features: {
        get isBitsEnabled() { return bitsOn; },
        onChanged: function (cb) { featureCbs.push(cb); }
      },
      viewer: {
        get isLinked() { return linked && !anon; },
        get id() { return linked && !anon ? user : null; },
        get opaqueId() { return (anon ? 'A' : 'U') + user; },
        onChanged: function (cb) { viewerCbs.push(cb); }
      },
      actions: {
        requestIdShare: function () { window.__idShareRequested = true; }
      },
      bits: {
        setUseLoopback: function () {},
        getProducts: function () { return Promise.resolve([]); },
        useBits: function (sku) {
          fetch('/dev/receipt?sku=' + encodeURIComponent(sku) + '&user=' + user)
            .then(function (r) { return r.json(); })
            .then(function (j) {
              txCbs.forEach(function (cb) { cb({ transactionReceipt: j.transactionReceipt, product: { sku: sku } }); });
            });
        },
        onTransactionComplete: function (cb) { txCbs.push(cb); },
        onTransactionCancelled: function (cb) { cancelCbs.push(cb); }
      }
    }
  };
  window.__devCancelBits = function () { cancelCbs.forEach(function (cb) { cb(); }); };
})();
