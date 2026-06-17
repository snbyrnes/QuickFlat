/*
 * QuickFlat - data quality & validation report.
 *
 * Produces an audit-style summary of a parsed list: field completeness,
 * duplicate keys, invalid dates, empty multi-value fields, unexpected elements,
 * and quick categorical distributions. Pure (no DOM); runs on the main thread
 * and is unit-tested in Node.
 */
(function (root) {
  'use strict';

  var T = root.QFTransform;

  function topCounts(map, n) {
    return Object.keys(map)
      .map(function (k) { return { value: k, count: map[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, n || 15);
  }

  function bump(map, key) { map[key] = (map[key] || 0) + 1; }

  /** buildReport(records, meta, recordTag, isHPRA) -> report object */
  function buildReport(records, meta, recordTag, isHPRA) {
    meta = meta || {};
    var n = records.length;

    return isHPRA
      ? hpraReport(records, meta, n)
      : genericReport(records, meta, recordTag, n);
  }

  function hpraReport(records, meta, n) {
    var fields = [];
    var distinct = {}, present = {};
    T.HPRA_SCALARS.forEach(function (s) { distinct[s] = {}; present[s] = 0; });

    var dupes = {}, idSeen = {};
    var invalidDates = [];
    var emptyMulti = {}; T.HPRA_MULTI.forEach(function (m) { emptyMulti[m.col] = 0; });
    var multiPresent = {}, multiDistinct = {}, multiTotal = {};
    T.HPRA_MULTI.forEach(function (m) { multiPresent[m.col] = 0; multiDistinct[m.col] = {}; multiTotal[m.col] = 0; });

    var dist = { MarketInfo: {}, RegistrationStatus: {}, ProductType: {}, DispensingLegalStatus: {} };
    var holders = {}, atcPrefix = {};
    var unknown = {};

    for (var i = 0; i < n; i++) {
      var rec = records[i] || {};

      // Duplicate primary keys.
      var id = T.scalar(rec.DrugIDPK);
      if (id !== null) {
        if (idSeen[id]) bump(dupes, id);
        idSeen[id] = true;
      }

      // Scalar completeness + distinct.
      T.HPRA_SCALARS.forEach(function (s) {
        var v = T.scalar(rec[s]);
        if (v !== null) { present[s]++; distinct[s][v] = true; }
      });

      // Date validity.
      var rawDate = T.scalar(rec.AuthorisedDate);
      if (rawDate !== null && T.toISODate(rawDate) === null) {
        if (invalidDates.length < 50) invalidDates.push({ DrugIDPK: id, value: rawDate });
      }

      // Multi-value fields.
      T.HPRA_MULTI.forEach(function (m) {
        var vals = T.getMulti(rec, m);
        if (vals.length === 0) emptyMulti[m.col]++;
        else multiPresent[m.col]++;
        multiTotal[m.col] += vals.length;
        vals.forEach(function (v) { multiDistinct[m.col][v] = true; });
      });

      // Distributions.
      bump(dist.MarketInfo, T.scalar(rec.MarketInfo) || '(none)');
      bump(dist.RegistrationStatus, T.scalar(rec.RegistrationStatus) || '(none)');
      bump(dist.ProductType, T.scalar(rec.ProductType) || '(none)');
      T.getMulti(rec, { container: 'DispensingLegalStatus', child: 'Status' }).forEach(function (s) { bump(dist.DispensingLegalStatus, s); });
      var h = T.scalar(rec.PAHolder); if (h) bump(holders, h);
      T.getMulti(rec, { container: 'ATCs', child: 'ATC' }).forEach(function (a) { bump(atcPrefix, a.slice(0, 1)); });

      // Unexpected elements.
      for (var k in rec) {
        if (T.HPRA_SCALARS.indexOf(k) === -1 &&
            !T.HPRA_MULTI.some(function (m) { return m.container === k; })) {
          bump(unknown, k);
        }
      }
    }

    T.HPRA_SCALARS.forEach(function (s) {
      fields.push({
        name: s, type: 'scalar', present: present[s], missing: n - present[s],
        completeness: n ? present[s] / n : 0, distinct: Object.keys(distinct[s]).length
      });
    });
    T.HPRA_MULTI.forEach(function (m) {
      fields.push({
        name: m.col, type: 'multi', present: multiPresent[m.col], missing: emptyMulti[m.col],
        completeness: n ? multiPresent[m.col] / n : 0,
        distinct: Object.keys(multiDistinct[m.col]).length,
        totalValues: multiTotal[m.col]
      });
    });

    return {
      generatedAt: new Date().toISOString(),
      schema: 'HPRA human medicines',
      recordTag: 'Product',
      recordCount: n,
      datePublished: meta.datePublished || null,
      schemaVersion: meta.schemaVersion || null,
      fields: fields,
      issues: {
        duplicateIds: topCounts(dupes, 50).map(function (d) { return { id: d.value, occurrences: d.count + 1 }; }),
        invalidDates: invalidDates,
        emptyMultiValue: emptyMulti,
        unexpectedElements: topCounts(unknown, 50)
      },
      distributions: {
        MarketInfo: dist.MarketInfo,
        RegistrationStatus: dist.RegistrationStatus,
        ProductType: dist.ProductType,
        DispensingLegalStatus: topCounts(dist.DispensingLegalStatus, 20),
        topPAHolders: topCounts(holders, 15),
        atcFirstLevel: topCounts(atcPrefix, 30)
      }
    };
  }

  function genericReport(records, meta, recordTag, n) {
    var present = {}, distinct = {}, order = [];
    for (var i = 0; i < n; i++) {
      var flat = T.genericFlatten(records[i], ' | ', '', {});
      for (var k in flat) {
        if (!(k in present)) { present[k] = 0; distinct[k] = {}; order.push(k); }
        if (flat[k] !== null && flat[k] !== '') { present[k]++; distinct[k][flat[k]] = true; }
      }
    }
    var fields = order.map(function (k) {
      return {
        name: k, type: 'scalar', present: present[k], missing: n - present[k],
        completeness: n ? present[k] / n : 0, distinct: Object.keys(distinct[k]).length
      };
    });
    return {
      generatedAt: new Date().toISOString(),
      schema: 'Generic',
      recordTag: recordTag,
      recordCount: n,
      datePublished: meta.datePublished || null,
      schemaVersion: meta.schemaVersion || null,
      fields: fields,
      issues: { duplicateIds: [], invalidDates: [], emptyMultiValue: {}, unexpectedElements: [] },
      distributions: {}
    };
  }

  // ---- Serialisers -----------------------------------------------------------

  function reportToJSON(report) { return JSON.stringify(report, null, 2); }

  /** Field-completeness as a CSV (handy to drop into a spreadsheet). */
  function fieldsToCSV(report) {
    var head = ['field', 'type', 'present', 'missing', 'completeness_pct', 'distinct_values'];
    var lines = [head.join(',')];
    report.fields.forEach(function (f) {
      lines.push([f.name, f.type, f.present, f.missing, (f.completeness * 100).toFixed(1), f.distinct].join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  root.QFReport = {
    buildReport: buildReport,
    reportToJSON: reportToJSON,
    fieldsToCSV: fieldsToCSV
  };
})(typeof self !== 'undefined' ? self : this);
