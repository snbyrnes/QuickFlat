/*
 * QuickFlat - Web Worker.
 *
 * Parses the XML off the main thread so even large (10MB+) HPRA exports never
 * freeze the UI. Posts progress updates, then the extracted records + metadata.
 * Transform/serialisation happens on the main thread (it is cheap and reacts to
 * option changes without re-parsing).
 */
/* global QFExtract */
importScripts('xml-sax.js', 'extract.js');

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.type !== 'parse') return;

  var lastPct = -1;
  try {
    var result = QFExtract.extract(msg.text, function (pos, len) {
      var pct = len ? Math.floor((pos / len) * 100) : 100;
      if (pct !== lastPct) {
        lastPct = pct;
        self.postMessage({ type: 'progress', pct: pct });
      }
    });
    self.postMessage({
      type: 'done',
      records: result.records,
      meta: result.meta,
      recordTag: result.recordTag,
      recordCount: result.recordCount,
      isHPRA: result.isHPRA
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
