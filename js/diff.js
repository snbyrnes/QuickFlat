/*
 * QuickFlat - change tracking (diff between two published lists).
 *
 * Compares two flat row sets (typically the "one row per product" output of
 * QFTransform.buildRows with explode='none') keyed on a primary column, and
 * reports added / removed / changed / unchanged records with field-level
 * deltas. Pure (no DOM); unit-tested in Node.
 */
(function (root) {
  'use strict';

  function indexBy(rows, key) {
    var map = {};
    for (var i = 0; i < rows.length; i++) {
      var k = rows[i][key];
      if (k !== null && k !== undefined && k !== '') map[k] = rows[i];
    }
    return map;
  }

  /**
   * buildDiff(oldRows, newRows, opts)
   * opts: { key='DrugIDPK', labelCol='ProductName', ignore=['Source...'] }
   * Returns { summary, added:[row], removed:[row], changed:[{key,label,changes:[{field,old,new}]}] }
   */
  function buildDiff(oldRows, newRows, opts) {
    opts = opts || {};
    var key = opts.key || 'DrugIDPK';
    var labelCol = opts.labelCol || 'ProductName';
    var ignore = {};
    (opts.ignore || ['SourceDatePublished', 'SourceSchemaVersion']).forEach(function (c) { ignore[c] = true; });

    var oldIx = indexBy(oldRows, key);
    var newIx = indexBy(newRows, key);

    // Compare the union of columns present in either side (minus ignored + key).
    var colSet = {};
    if (oldRows[0]) Object.keys(oldRows[0]).forEach(function (c) { colSet[c] = true; });
    if (newRows[0]) Object.keys(newRows[0]).forEach(function (c) { colSet[c] = true; });
    var cols = Object.keys(colSet).filter(function (c) { return c !== key && !ignore[c]; });

    var added = [], removed = [], changed = [], unchanged = 0;

    Object.keys(newIx).forEach(function (k) {
      if (!(k in oldIx)) { added.push(newIx[k]); return; }
      var o = oldIx[k], nw = newIx[k];
      var changes = [];
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        var ov = norm(o[c]), nv = norm(nw[c]);
        if (ov !== nv) changes.push({ field: c, old: o[c] == null ? null : o[c], new: nw[c] == null ? null : nw[c] });
      }
      if (changes.length) changed.push({ key: k, label: nw[labelCol] || o[labelCol] || '', changes: changes });
      else unchanged++;
    });
    Object.keys(oldIx).forEach(function (k) {
      if (!(k in newIx)) removed.push(oldIx[k]);
    });

    return {
      key: key,
      summary: {
        oldCount: oldRows.length, newCount: newRows.length,
        added: added.length, removed: removed.length,
        changed: changed.length, unchanged: unchanged
      },
      added: added, removed: removed, changed: changed
    };
  }

  function norm(v) { return v === null || v === undefined ? '' : String(v); }

  // ---- Serialisers -----------------------------------------------------------

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Long-format changelog CSV: one row per change/add/remove. */
  function diffToCSV(diff, labelCol) {
    labelCol = labelCol || 'ProductName';
    var head = ['change', diff.key, 'label', 'field', 'old_value', 'new_value'];
    var lines = [head.join(',')];
    diff.added.forEach(function (r) {
      lines.push(['added', csvCell(r[diff.key]), csvCell(r[labelCol]), '', '', ''].join(','));
    });
    diff.removed.forEach(function (r) {
      lines.push(['removed', csvCell(r[diff.key]), csvCell(r[labelCol]), '', '', ''].join(','));
    });
    diff.changed.forEach(function (c) {
      c.changes.forEach(function (ch) {
        lines.push(['changed', csvCell(c.key), csvCell(c.label), csvCell(ch.field), csvCell(ch.old), csvCell(ch.new)].join(','));
      });
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function diffToJSON(diff) { return JSON.stringify(diff, null, 2); }

  root.QFDiff = {
    buildDiff: buildDiff,
    diffToCSV: diffToCSV,
    diffToJSON: diffToJSON
  };
})(typeof self !== 'undefined' ? self : this);
