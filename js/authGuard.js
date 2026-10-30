(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FTAuthGuard = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BOUNCE_WINDOW_MS = 10000;
  var BOUNCE_LIMIT = 3;

  function storageKey(key) {
    return key ? 'ft_bounce_meta:' + key : 'ft_bounce_meta';
  }

  function registerBounce(storage, now, key) {
    now = typeof now === 'number' ? now : Date.now();
    var k = storageKey(key);
    var count = 0;
    var windowStart = now;

    try {
      var raw = storage.getItem(k);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && typeof parsed.count === 'number' && typeof parsed.windowStart === 'number') {
          count = parsed.count;
          windowStart = parsed.windowStart;
        }
      }
    } catch (e) {}

    if (now - windowStart > BOUNCE_WINDOW_MS) {
      count = 0;
      windowStart = now;
    }

    count += 1;

    try {
      storage.setItem(k, JSON.stringify({ count: count, windowStart: windowStart }));
    } catch (e) {}

    return { blocked: count > BOUNCE_LIMIT, count: count };
  }

  function clearBounceGuard(storage, key) {
    try {
      storage.removeItem(storageKey(key));
    } catch (e) {}
  }

  return {
    BOUNCE_WINDOW_MS: BOUNCE_WINDOW_MS,
    BOUNCE_LIMIT: BOUNCE_LIMIT,
    registerBounce: registerBounce,
    clearBounceGuard: clearBounceGuard,
  };
});
