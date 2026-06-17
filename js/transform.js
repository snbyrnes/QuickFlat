/*
 * QuickFlat - transform layer (Power BI / QuickSight shaping).
 *
 * Converts the generic record tree from extract.js into a flat, rectangular
 * table and serialises it to CSV / JSON array / NDJSON.
 *
 * For recognised HPRA "human medicines" lists it applies a curated column model
 * (stable column set, ISO date column, tidy multi-value handling). For anything
 * else it falls back to a generic dotted-path flattener so the tool still works.
 *
 * Runs on the main thread (no DOM use) and is also unit-tested in Node.
 */
(function (root) {
  'use strict';

  var DEFAULT_SEP = ' | ';

  // ---- HPRA human-medicines column model -------------------------------------
  // Scalar (single-value) fields, in the order analysts expect to read them.
  var HPRA_SCALARS = [
    'DrugIDPK', 'LicenceNumber', 'InterchangeableListCode', 'ProductName', 'PAHolder',
    'AuthorisedDate', 'ProductType', 'MarketInfo', 'RegistrationStatus', 'DosageForm',
    'LegalBasis', 'SupplyLegalStatus', 'PromotionLegalStatus', 'SupplyComments'
  ];

  // Multi-value fields: { col = output column, container = wrapper tag, child = repeated tag }.
  var HPRA_MULTI = [
    { col: 'ATC', container: 'ATCs', child: 'ATC' },
    { col: 'RoutesOfAdministration', container: 'RoutesOfAdministration', child: 'RoutesOfAdministration' },
    { col: 'ActiveSubstance', container: 'ActiveSubstances', child: 'ActiveSubstance' },
    { col: 'DispensingLegalStatus', container: 'DispensingLegalStatus', child: 'Status' }
  ];

  var HPRA_KNOWN = (function () {
    var set = {};
    HPRA_SCALARS.forEach(function (s) { set[s] = true; });
    HPRA_MULTI.forEach(function (m) { set[m.container] = true; });
    return set;
  })();

  function asArray(v) {
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  /** Pull a clean array of non-empty strings out of a multi-value container. */
  function getMulti(record, spec) {
    var container = record[spec.container];
    var raw;
    if (container === null || container === undefined) {
      raw = [];
    } else if (typeof container === 'object' && !Array.isArray(container)) {
      raw = asArray(container[spec.child]);
    } else {
      raw = asArray(container); // structure differed from expectation - be forgiving
    }
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var v = raw[i];
      if (v === null || v === undefined) continue;
      var s = (typeof v === 'object') ? JSON.stringify(v) : String(v).trim();
      if (s !== '') out.push(s);
    }
    return out;
  }

  function scalar(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return JSON.stringify(v);
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /** "dd/mm/yyyy" -> "yyyy-mm-dd" (null if it does not match). */
  function toISODate(v) {
    if (!v) return null;
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v).trim());
    return m ? m[3] + '-' + m[2] + '-' + m[1] : null;
  }

  /** Generic dotted-path flattener for non-HPRA XML (and unknown extra fields). */
  function genericFlatten(value, sep, prefix, out) {
    out = out || {};
    if (value === null || value === undefined) {
      if (prefix) out[prefix] = null;
      return out;
    }
    if (Array.isArray(value)) {
      var allPrimitive = value.every(function (x) { return x === null || typeof x !== 'object'; });
      if (allPrimitive) {
        out[prefix] = value.map(function (x) { return x === null ? '' : String(x); }).join(sep);
      } else {
        value.forEach(function (item, idx) {
          genericFlatten(item, sep, prefix + '[' + idx + ']', out);
        });
      }
      return out;
    }
    if (typeof value === 'object') {
      var keys = Object.keys(value);
      if (keys.length === 0 && prefix) { out[prefix] = null; return out; }
      keys.forEach(function (k) {
        genericFlatten(value[k], sep, prefix ? prefix + '.' + k : k, out);
      });
      return out;
    }
    out[prefix] = value;
    return out;
  }

  // ---- Row building ----------------------------------------------------------

  /**
   * buildRows(records, meta, opts) -> { columns: [..], rows: [..] }
   * opts: { explode, separator, addISODate, includeSource, isHPRA }
   *   explode: a multi-value column name, or 'none'
   */
  function buildRows(records, meta, opts) {
    opts = opts || {};
    var sep = opts.separator != null ? opts.separator : DEFAULT_SEP;
    var isHPRA = !!opts.isHPRA;
    var addISO = opts.addISODate !== false;
    var includeSource = opts.includeSource !== false;
    meta = meta || {};

    if (!isHPRA) return buildGenericRows(records, meta, sep, includeSource);

    var explode = opts.explode && opts.explode !== 'none' ? opts.explode : null;
    var explodeSpec = explode ? HPRA_MULTI.filter(function (m) { return m.col === explode; })[0] : null;
    if (!explodeSpec) explode = null;

    // Stable column order.
    var columns = [];
    HPRA_SCALARS.forEach(function (s) {
      columns.push(s);
      if (s === 'AuthorisedDate' && addISO) columns.push('AuthorisedDateISO');
    });
    HPRA_MULTI.forEach(function (m) { columns.push(m.col); });

    var extraCols = {}; // discovered non-standard fields -> stable union
    var rows = [];

    for (var r = 0; r < records.length; r++) {
      var rec = records[r] || {};
      var base = {};

      for (var s = 0; s < HPRA_SCALARS.length; s++) {
        var key = HPRA_SCALARS[s];
        base[key] = scalar(rec[key]);
        if (key === 'AuthorisedDate' && addISO) base.AuthorisedDateISO = toISODate(base.AuthorisedDate);
      }

      var multiVals = {};
      HPRA_MULTI.forEach(function (m) { multiVals[m.col] = getMulti(rec, m); });

      // Anything the HPRA model does not know about is kept via generic flatten.
      for (var k in rec) {
        if (HPRA_KNOWN[k]) continue;
        var flat = genericFlatten(rec[k], sep, k, {});
        for (var fk in flat) { base[fk] = flat[fk]; extraCols[fk] = true; }
      }

      if (explode) {
        // One row per value of the exploded field; all other multi fields joined.
        var template = cloneBase(base, multiVals, sep, explodeSpec.col);
        var values = multiVals[explodeSpec.col];
        if (values.length === 0) {
          template[explodeSpec.col] = null;
          rows.push(template);
        } else {
          for (var v = 0; v < values.length; v++) {
            var row = shallow(template);
            row[explodeSpec.col] = values[v];
            rows.push(row);
          }
        }
      } else {
        rows.push(cloneBase(base, multiVals, sep, null));
      }
    }

    Object.keys(extraCols).sort().forEach(function (c) { columns.push(c); });
    if (includeSource) {
      columns.push('SourceDatePublished', 'SourceSchemaVersion');
      for (var i = 0; i < rows.length; i++) {
        rows[i].SourceDatePublished = meta.datePublished || null;
        rows[i].SourceSchemaVersion = meta.schemaVersion || null;
      }
    }

    return { columns: columns, rows: normalize(columns, rows) };
  }

  /** Apply joined multi-values onto a base row (skipping the exploded column). */
  function cloneBase(base, multiVals, sep, skipCol) {
    var row = shallow(base);
    HPRA_MULTI.forEach(function (m) {
      if (m.col === skipCol) return;
      var arr = multiVals[m.col];
      row[m.col] = arr.length ? arr.join(sep) : null;
    });
    if (skipCol) row[skipCol] = null; // placeholder; set by caller per value
    return row;
  }

  function buildGenericRows(records, meta, sep, includeSource) {
    var columns = [];
    var seen = {};
    var rows = [];
    for (var r = 0; r < records.length; r++) {
      var flat = genericFlatten(records[r], sep, '', {});
      rows.push(flat);
      for (var k in flat) {
        if (!seen[k]) { seen[k] = true; columns.push(k); }
      }
    }
    if (includeSource && (meta.datePublished || meta.schemaVersion)) {
      columns.push('SourceDatePublished', 'SourceSchemaVersion');
      rows.forEach(function (row) {
        row.SourceDatePublished = meta.datePublished || null;
        row.SourceSchemaVersion = meta.schemaVersion || null;
      });
    }
    return { columns: columns, rows: normalize(columns, rows) };
  }

  function shallow(o) {
    var c = {};
    for (var k in o) c[k] = o[k];
    return c;
  }

  /** Ensure every row has exactly the column set, in order, missing => null. */
  function normalize(columns, rows) {
    return rows.map(function (r) {
      var o = {};
      for (var i = 0; i < columns.length; i++) {
        var c = columns[i];
        var v = r[c];
        o[c] = v === undefined ? null : v;
      }
      return o;
    });
  }

  // ---- Serialisers -----------------------------------------------------------

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** RFC-4180 CSV with a UTF-8 BOM so Excel / Power BI read accents correctly. */
  function toCSV(columns, rows) {
    var lines = [columns.map(csvCell).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = new Array(columns.length);
      for (var c = 0; c < columns.length; c++) cells[c] = csvCell(row[columns[c]]);
      lines.push(cells.join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function toJSON(columns, rows) {
    return JSON.stringify(rows, null, 2);
  }

  function toNDJSON(columns, rows) {
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) out[i] = JSON.stringify(rows[i]);
    return out.join('\n') + (rows.length ? '\n' : '');
  }

  root.QFTransform = {
    DEFAULT_SEP: DEFAULT_SEP,
    HPRA_MULTI: HPRA_MULTI,
    buildRows: buildRows,
    toCSV: toCSV,
    toJSON: toJSON,
    toNDJSON: toNDJSON,
    toISODate: toISODate,
    genericFlatten: genericFlatten
  };
})(typeof self !== 'undefined' ? self : this);
