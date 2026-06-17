/*
 * QuickFlat - minimal XLSX writer.
 *
 * Builds a real .xlsx (an Office Open XML package zipped with QFZip) from one or
 * more sheets. Uses inline strings (no shared-strings table) for simplicity, and
 * types pure yyyy-mm-dd values as real Excel dates so Power BI / QuickSight skip
 * CSV type-guessing. No external dependency.
 */
(function (root) {
  'use strict';

  var EPOCH = Date.UTC(1899, 11, 30); // Excel's day 0 (1900 date system, with leap bug offset)

  function xmlEsc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // strip control chars that are illegal in XML 1.0
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function colLetter(i) {
    var s = '';
    i += 1;
    while (i > 0) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - r - 1) / 26; }
    return s;
  }

  var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function dateSerial(y, m, d) {
    return Math.round((Date.UTC(y, m - 1, d) - EPOCH) / 86400000);
  }

  function sanitizeSheetName(name, used) {
    var n = String(name).replace(/[\[\]\*\?\/\\:]/g, '_').slice(0, 31) || 'Sheet';
    var base = n, i = 1;
    while (used[n.toLowerCase()]) { n = base.slice(0, 28) + '_' + (++i); }
    used[n.toLowerCase()] = true;
    return n;
  }

  function sheetXml(sheet) {
    var cols = sheet.columns, rows = sheet.rows;
    var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetData>'];

    // Header row.
    out.push('<row r="1">');
    for (var c = 0; c < cols.length; c++) {
      out.push('<c r="' + colLetter(c) + '1" t="inlineStr"><is><t xml:space="preserve">' +
        xmlEsc(cols[c]) + '</t></is></c>');
    }
    out.push('</row>');

    for (var i = 0; i < rows.length; i++) {
      var rnum = i + 2;
      out.push('<row r="' + rnum + '">');
      for (var j = 0; j < cols.length; j++) {
        var v = rows[i][cols[j]];
        if (v === null || v === undefined || v === '') continue;
        var ref = colLetter(j) + rnum;
        var m = (typeof v === 'string') && ISO_DATE.exec(v);
        if (m) {
          out.push('<c r="' + ref + '" s="1"><v>' + dateSerial(+m[1], +m[2], +m[3]) + '</v></c>');
        } else {
          out.push('<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' +
            xmlEsc(v) + '</t></is></c>');
        }
      }
      out.push('</row>');
    }
    out.push('</sheetData></worksheet>');
    return out.join('');
  }

  /** buildWorkbook([{ name, columns, rows }]) -> Uint8Array (.xlsx bytes) */
  function buildWorkbook(sheets) {
    var used = {};
    sheets = sheets.map(function (s) {
      return { name: sanitizeSheetName(s.name, used), columns: s.columns, rows: s.rows };
    });

    var files = [];
    files.push({
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function (s, i) {
          return '<Override PartName="/xl/worksheets/sheet' + (i + 1) +
            '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
        }).join('') +
        '</Types>'
    });

    files.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    });

    files.push({
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function (s, i) {
          return '<sheet name="' + xmlEsc(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
        }).join('') +
        '</sheets></workbook>'
    });

    files.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function (s, i) {
          return '<Relationship Id="rId' + (i + 1) +
            '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
        }).join('') +
        '<Relationship Id="rId' + (sheets.length + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>'
    });

    // One cell style (s="1") = ISO date format yyyy-mm-dd (numFmtId 14).
    files.push({
      name: 'xl/styles.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
        '<borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '</cellXfs></styleSheet>'
    });

    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) });
    });

    return root.QFZip.makeZip(files);
  }

  root.QFXlsx = { buildWorkbook: buildWorkbook };
})(typeof self !== 'undefined' ? self : this);
