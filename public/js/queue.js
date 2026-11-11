/*
 * Pending-result queue in IndexedDB. Classic script (no modules) so the page and
 * the service worker (via importScripts) share exactly the same code.
 *
 * A result stays in this queue until the server has answered 2xx for it. Every
 * entry carries a client-generated `clientId`, and the server treats repeated
 * submissions of the same clientId as the same result, so retries from the page
 * and from the service worker can never create duplicates.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'ten-seconds';
  var DB_VERSION = 1;
  var STORE = 'pending';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'clientId' });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { dbPromise = null; reject(req.error); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var store = t.objectStore(STORE);
        var out;
        Promise.resolve(fn(store)).then(function (v) { out = v; });
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function req2p(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  var Queue = {
    add: function (result) {
      return tx('readwrite', function (s) { return req2p(s.put(result)); });
    },
    remove: function (clientId) {
      return tx('readwrite', function (s) { return req2p(s.delete(clientId)); });
    },
    all: function () {
      return tx('readonly', function (s) { return req2p(s.getAll()); }).then(function (rows) {
        return (rows || []).sort(function (a, b) { return a.playedAt - b.playedAt; });
      });
    },
    count: function () {
      return tx('readonly', function (s) { return req2p(s.count()); });
    },

    /**
     * Try to submit every pending result, oldest first.
     * Stops at the first network failure (we are offline / server unreachable).
     * Returns { sent: [{result, response}], rejected: [{result, error}], remaining, networkError }
     */
    flush: function (endpoint) {
      var report = { sent: [], rejected: [], remaining: 0, networkError: false };
      return Queue.all().then(function (rows) {
        var chain = Promise.resolve();
        rows.forEach(function (r) {
          chain = chain.then(function () {
            if (report.networkError) return;
            return fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(r),
              cache: 'no-store',
            }).then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (body) {
                if (res.ok) {
                  report.sent.push({ result: r, response: body });
                  return Queue.remove(r.clientId);
                }
                if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
                  // Permanently refused (invalid data). Drop it and report it, never retry forever.
                  report.rejected.push({ result: r, error: body && body.error || ('HTTP ' + res.status) });
                  return Queue.remove(r.clientId);
                }
                // 5xx / 408 / 429: keep it queued and try again later.
                report.networkError = true;
              });
            }, function () {
              report.networkError = true;
            });
          });
        });
        return chain;
      }).then(function () {
        return Queue.count();
      }).then(function (n) {
        report.remaining = n;
        return report;
      });
    },
  };

  global.TenQueue = Queue;
})(typeof self !== 'undefined' ? self : this);
