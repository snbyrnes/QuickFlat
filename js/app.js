/*
 * QuickFlat - UI controller.
 *
 * Wires the three tabs (Convert / Quality / Compare) to the tested logic modules
 * (QFTransform, QFReport, QFDiff, QFZip, QFXlsx) and a Web Worker parser.
 * Everything runs in the browser; no data is ever uploaded.
 */
(function () {
  'use strict';

  var PREVIEW_ROWS = 200;
  var DIFF_ROWS = 300;
  var PROFILE_KEY = 'quickflat.profile.v1';
  var SEEN_VERSION_KEY = 'quickflat.seenVersion';
  var APP_VERSION = '1.2.0';

  // Newest first. Shown in the "What's new" modal.
  var CHANGELOG = [
    {
      version: '1.2.0', date: '2026-06-17', title: 'Changelog',
      items: ['Added this “What’s new” changelog modal.']
    },
    {
      version: '1.1.0', date: '2026-06-17', title: 'Reporting, modeling & comparison',
      items: [
        'Data-quality & validation report: field completeness, duplicate keys, invalid dates, unexpected elements and distributions.',
        'Column control: select, rename and reorder columns, with a saved default and a copy-able shareable link.',
        'Change tracking: diff two published lists for products added, removed and changed.',
        'Star-schema export: a products fact table plus bridge tables, as a ZIP of CSVs or a multi-sheet XLSX.',
        'XLSX export with typed date cells.',
        'Reorganised into Convert / Quality / Compare tabs.'
      ]
    },
    {
      version: '1.0.0', date: '2026-06-17', title: 'Initial release',
      items: [
        'Browser-only, drag-and-drop HPRA human-medicines XML to flat output (nothing is uploaded).',
        'Streaming SAX parser in a Web Worker — the full ~13 MB list parses in well under a second.',
        'HPRA-aware column model with explode / join for repeating fields, ISO date column and xsi:nil handling.',
        'CSV, JSON and NDJSON downloads, with a live preview and stats.',
        'Generic fallback for any other record-list XML. Published to GitHub Pages.'
      ]
    }
  ];

  var state = {
    primary: null,                 // { records, meta, isHPRA, recordTag, recordCount, sourceName }
    base: { columns: [], rows: [] },
    view: { columns: [], rows: [] },
    columnConfig: { order: [], hidden: {}, rename: {} },
    report: null,
    cmp: { a: null, b: null, diff: null }
  };
  var pendingProfile = null;

  var el = {};
  function grab(ids) { ids.forEach(function (id) { el[id] = document.getElementById(id); }); }
  grab(['error', 'progress', 'progressBar', 'progressLabel',
    'dropzone', 'fileInput', 'browseBtn', 'demoBtn', 'status',
    'controls', 'explode', 'separator', 'isoDate', 'includeSource',
    'colPanelWrap', 'colCount', 'colList', 'copyLink', 'saveProfile', 'resetProfile', 'profileMsg',
    'dlCsv', 'dlJson', 'dlNdjson', 'dlXlsx', 'dlStarZip', 'dlStarXlsx',
    'stats', 'previewWrap', 'preview', 'previewNote',
    'qualityEmpty', 'qualityBody', 'dlReportJson', 'dlReportCsv',
    'cmpDropA', 'cmpFileA', 'cmpStatusA', 'cmpDropB', 'cmpFileB', 'cmpStatusB',
    'diffStats', 'diffBody', 'dlDiffCsv', 'dlDiffJson',
    'changelogBtn', 'changelogModal', 'changelogClose', 'changelogBody', 'appVersion']);

  // ---- Worker parse pipeline -------------------------------------------------

  function parseViaWorker(text, onProgress) {
    return new Promise(function (resolve, reject) {
      var w;
      try { w = new Worker('js/worker.js'); } catch (e) { reject(new Error('Web Workers are unavailable in this browser.')); return; }
      w.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'progress') { if (onProgress) onProgress(m.pct); }
        else if (m.type === 'done') { w.terminate(); resolve(m); }
        else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
      };
      w.onerror = function (e) { w.terminate(); reject(new Error(e.message || 'worker error')); };
      w.postMessage({ type: 'parse', text: text });
    });
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onerror = function () { reject(new Error('Could not read the file.')); };
      r.onload = function () { resolve(String(r.result)); };
      r.readAsText(file);
    });
  }

  // ---- Convert: load primary file -------------------------------------------

  function loadPrimaryFile(file) {
    var name = (file.name || 'data').replace(/\.[^.]+$/, '');
    showError(''); setStatus('Reading "' + (file.name || name) + '"…');
    readFileText(file).then(function (t) { loadPrimaryText(t, name); }).catch(function (e) { fail(e.message); });
  }

  function loadPrimaryText(text, name) {
    showError(''); setStatus('Parsing "' + name + '"…');
    showProgress(true, 0, 'Parsing XML');
    parseViaWorker(text, function (pct) { showProgress(true, pct, 'Parsing XML'); })
      .then(function (m) {
        showProgress(false);
        if (!m.records || !m.records.length) {
          fail('No records found. Expecting a root element with repeated record elements (e.g. <Products><Product>…).');
          return;
        }
        state.primary = {
          records: m.records, meta: m.meta, isHPRA: m.isHPRA,
          recordTag: m.recordTag, recordCount: m.recordCount, sourceName: name
        };
        setStatus(describe(m));
        buildControls();
        applyPendingProfile();
        el.controls.hidden = false;
        renderConvert();
        buildReport();
      })
      .catch(function (e) { fail('Could not parse the XML: ' + e.message); });
  }

  function describe(m) {
    return (m.isHPRA ? 'HPRA human-medicines list detected. '
      : 'Generic XML detected (' + (m.recordTag || 'record') + '). ') +
      m.recordCount.toLocaleString() + ' ' + (m.recordTag || 'record') + ' records.';
  }

  function loadDemo() {
    showError(''); setStatus('Loading demo file…'); showProgress(true, 0, 'Loading demo');
    fetch('sample/hpra-sample.xml')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) { loadPrimaryText(t, 'hpra-sample'); })
      .catch(function (e) { fail('Could not load the demo file (' + e.message + ').'); });
  }

  // ---- Convert: controls -----------------------------------------------------

  function buildControls() {
    var p = state.primary;
    el.explode.innerHTML = '';
    addOption(el.explode, 'none', 'One row per ' + (p.recordTag || 'record') + ' (no explode)');
    if (p.isHPRA) {
      QFTransform.HPRA_MULTI.forEach(function (m) { addOption(el.explode, m.col, 'Explode by ' + m.col); });
      el.explode.value = 'ActiveSubstance';
      el.explode.disabled = false;
      el.explode.title = '';
    } else {
      el.explode.value = 'none';
      el.explode.disabled = true;
      el.explode.title = 'Explode is available for recognised HPRA lists only.';
    }
  }

  function addOption(sel, value, label) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label; sel.appendChild(o);
  }

  function currentOpts() {
    return {
      explode: el.explode.value,
      separator: el.separator.value.length ? el.separator.value : ' | ',
      addISODate: el.isoDate.checked,
      includeSource: el.includeSource.checked,
      isHPRA: state.primary.isHPRA
    };
  }

  // ---- Convert: render -------------------------------------------------------

  function renderConvert() {
    if (!state.primary) return;
    var t0 = performance.now();
    state.base = QFTransform.buildRows(state.primary.records, state.primary.meta, currentOpts());
    var ms = Math.round(performance.now() - t0);
    reproject(true);
    renderStats(ms);
  }

  // Re-apply the column configuration to the current base table.
  function reproject(rebuildPanel) {
    state.view = QFTransform.applyColumnConfig(state.base.columns, state.base.rows, state.columnConfig);
    if (rebuildPanel) buildColumnPanel();
    renderPreview();
    updateDownloadState();
    el.colCount.textContent = '(' + state.view.columns.length + ' of ' + state.base.columns.length + ')';
  }

  function renderStats(ms) {
    var p = state.primary;
    var rows = [
      ['Source records', p.records.length.toLocaleString()],
      ['Output rows', state.view.rows.length.toLocaleString()],
      ['Columns', String(state.view.columns.length)],
      ['Schema', p.isHPRA ? 'HPRA human medicines' : 'Generic'],
      ['Published', p.meta.datePublished || '—'],
      ['Transform', ms + ' ms']
    ];
    el.stats.innerHTML = rows.map(statCard).join('');
  }

  function statCard(r) {
    return '<div class="stat"><span class="stat-val">' + esc(r[1]) +
      '</span><span class="stat-key">' + esc(r[0]) + '</span></div>';
  }

  function renderPreview() {
    el.preview.innerHTML = tableHTML(state.view.columns, state.view.rows.slice(0, PREVIEW_ROWS));
    el.previewWrap.hidden = false;
    el.previewNote.textContent = state.view.rows.length > PREVIEW_ROWS
      ? 'Showing first ' + PREVIEW_ROWS + ' of ' + state.view.rows.length.toLocaleString() + ' rows.'
      : 'Showing all ' + state.view.rows.length.toLocaleString() + ' rows.';
  }

  function tableHTML(cols, rows) {
    return '<table><thead><tr>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr>' + cols.map(function (c) {
          var v = row[c];
          return '<td' + (v === null || v === undefined ? ' class="null"' : '') + '>' +
            (v === null || v === undefined ? '∅' : esc(String(v))) + '</td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }

  // ---- Convert: column configuration panel (#4) ------------------------------

  function orderedBaseColumns() {
    var cfg = state.columnConfig;
    var known = {}; state.base.columns.forEach(function (c) { known[c] = true; });
    var seen = {}, out = [];
    (cfg.order || []).forEach(function (c) { if (known[c] && !seen[c]) { seen[c] = true; out.push(c); } });
    state.base.columns.forEach(function (c) { if (!seen[c]) { seen[c] = true; out.push(c); } });
    return out;
  }

  function buildColumnPanel() {
    var cols = orderedBaseColumns();
    var cfg = state.columnConfig;
    el.colList.innerHTML = cols.map(function (c, i) {
      var hidden = !!cfg.hidden[c];
      var rn = cfg.rename[c] || '';
      return '<div class="col-row" data-col="' + esc(c) + '">' +
        '<label class="check"><input type="checkbox" data-act="vis"' + (hidden ? '' : ' checked') + '/></label>' +
        '<span class="col-orig" title="' + esc(c) + '">' + esc(c) + '</span>' +
        '<input class="col-rename" data-act="rename" type="text" placeholder="' + esc(c) + '" value="' + esc(rn) + '"/>' +
        '<span class="col-move">' +
        '<button type="button" class="iconbtn" data-act="up" ' + (i === 0 ? 'disabled' : '') + '>▲</button>' +
        '<button type="button" class="iconbtn" data-act="down" ' + (i === cols.length - 1 ? 'disabled' : '') + '>▼</button>' +
        '</span></div>';
    }).join('');
  }

  function onColListEvent(e) {
    var target = e.target;
    var act = target.getAttribute('data-act');
    if (!act) return;
    var rowEl = target.closest('.col-row');
    if (!rowEl) return;
    var col = rowEl.getAttribute('data-col');
    var cfg = state.columnConfig;

    if (act === 'vis' && e.type === 'change') {
      if (target.checked) delete cfg.hidden[col]; else cfg.hidden[col] = true;
      reproject(false);
    } else if (act === 'rename' && e.type === 'input') {
      var v = target.value.trim();
      if (v) cfg.rename[col] = v; else delete cfg.rename[col];
      reproject(false); // do not rebuild panel (keep input focus)
    } else if ((act === 'up' || act === 'down') && e.type === 'click') {
      var order = orderedBaseColumns();
      var idx = order.indexOf(col);
      var swap = act === 'up' ? idx - 1 : idx + 1;
      if (swap < 0 || swap >= order.length) return;
      var tmp = order[idx]; order[idx] = order[swap]; order[swap] = tmp;
      cfg.order = order;
      reproject(true);
    }
  }

  // ---- Profiles (#4) ---------------------------------------------------------

  function currentProfile() {
    return {
      explode: el.explode.value,
      separator: el.separator.value,
      isoDate: el.isoDate.checked,
      includeSource: el.includeSource.checked,
      columnConfig: state.columnConfig
    };
  }

  function applyProfile(p) {
    if (!p) return;
    if (p.separator != null) el.separator.value = p.separator;
    if (typeof p.isoDate === 'boolean') el.isoDate.checked = p.isoDate;
    if (typeof p.includeSource === 'boolean') el.includeSource.checked = p.includeSource;
    if (p.explode && optionExists(el.explode, p.explode)) el.explode.value = p.explode;
    if (p.columnConfig) {
      state.columnConfig = {
        order: p.columnConfig.order || [],
        hidden: p.columnConfig.hidden || {},
        rename: p.columnConfig.rename || {}
      };
    }
  }

  function applyPendingProfile() {
    if (pendingProfile) { applyProfile(pendingProfile); pendingProfile = null; }
  }

  function optionExists(sel, val) {
    return Array.prototype.some.call(sel.options, function (o) { return o.value === val; });
  }

  function loadStoredProfile() {
    var hash = location.hash || '';
    var m = hash.match(/cfg=([^&]+)/);
    if (m) { try { return JSON.parse(b64ToUnicode(decodeURIComponent(m[1]))); } catch (e) {} }
    try {
      var s = localStorage.getItem(PROFILE_KEY);
      if (s) return JSON.parse(s);
    } catch (e) {}
    return null;
  }

  function copyShareLink() {
    var enc = encodeURIComponent(unicodeToB64(JSON.stringify(currentProfile())));
    var url = location.origin + location.pathname + '#cfg=' + enc;
    var done = function () { flashProfile('Link copied to clipboard'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, function () { promptCopy(url); });
    } else { promptCopy(url); }
    try { history.replaceState(null, '', '#cfg=' + enc); } catch (e) {}
  }
  function promptCopy(url) { window.prompt('Copy this shareable link:', url); }

  function saveDefaultProfile() {
    try { localStorage.setItem(PROFILE_KEY, JSON.stringify(currentProfile())); flashProfile('Saved as your default'); }
    catch (e) { flashProfile('Could not save (storage blocked)'); }
  }

  function resetProfile() {
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
    state.columnConfig = { order: [], hidden: {}, rename: {} };
    el.separator.value = ' | '; el.isoDate.checked = true; el.includeSource.checked = true;
    if (state.primary) { buildControls(); renderConvert(); }
    flashProfile('Reset to defaults');
  }

  function flashProfile(msg) {
    el.profileMsg.textContent = msg;
    clearTimeout(flashProfile._t);
    flashProfile._t = setTimeout(function () { el.profileMsg.textContent = ''; }, 2500);
  }

  function unicodeToB64(s) { return btoa(unescape(encodeURIComponent(s))); }
  function b64ToUnicode(s) { return decodeURIComponent(escape(atob(s))); }

  // ---- Convert: downloads ----------------------------------------------------

  function baseName() {
    var mode = el.explode.value !== 'none' ? '_by' + el.explode.value : '_flat';
    return state.primary.sourceName + mode;
  }

  function updateDownloadState() {
    var has = state.view.rows.length > 0;
    var hpra = state.primary && state.primary.isHPRA && has;
    [el.dlCsv, el.dlJson, el.dlNdjson, el.dlXlsx].forEach(function (b) { b.disabled = !has; });
    el.dlStarZip.disabled = !hpra; el.dlStarXlsx.disabled = !hpra;
  }

  function convertDownload(kind) {
    var v = state.view;
    if (!v.rows.length) return;
    if (kind === 'csv') saveBlob(QFTransform.toCSV(v.columns, v.rows), baseName() + '.csv', 'text/csv');
    else if (kind === 'json') saveBlob(QFTransform.toJSON(v.columns, v.rows), baseName() + '.json', 'application/json');
    else if (kind === 'ndjson') saveBlob(QFTransform.toNDJSON(v.columns, v.rows), baseName() + '.ndjson', 'application/x-ndjson');
    else if (kind === 'xlsx') saveBlob(QFXlsx.buildWorkbook([{ name: 'data', columns: v.columns, rows: v.rows }]),
      baseName() + '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  function starDownload(kind) {
    var p = state.primary;
    if (!p || !p.isHPRA) return;
    var tables = QFTransform.buildStarSchema(p.records, p.meta, {
      addISODate: el.isoDate.checked, includeSource: el.includeSource.checked
    });
    if (kind === 'zip') {
      var files = tables.map(function (t) { return { name: t.name + '.csv', data: QFTransform.toCSV(t.columns, t.rows) }; });
      saveBlob(QFZip.makeZip(files), p.sourceName + '_star.zip', 'application/zip');
    } else {
      saveBlob(QFXlsx.buildWorkbook(tables), p.sourceName + '_star.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
  }

  function saveBlob(data, filename, mime) {
    var blob = data instanceof Uint8Array
      ? new Blob([data], { type: mime })
      : new Blob([data], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // ---- Quality report (#2) ---------------------------------------------------

  function buildReport() {
    var p = state.primary;
    if (!p) return;
    state.report = QFReport.buildReport(p.records, p.meta, p.recordTag, p.isHPRA);
    el.dlReportJson.disabled = false; el.dlReportCsv.disabled = false;
    renderReport();
  }

  function pct(x) { return (x * 100).toFixed(x === 1 || x === 0 ? 0 : 1) + '%'; }

  function renderReport() {
    var r = state.report;
    if (!r) return;
    el.qualityEmpty.hidden = true;
    el.qualityBody.hidden = false;

    var html = '';
    html += '<section class="stats">' +
      statCard(['Schema', r.schema]) + statCard(['Records', r.recordCount.toLocaleString()]) +
      statCard(['Published', r.datePublished || '—']) +
      statCard(['Duplicate IDs', String(r.issues.duplicateIds.length)]) +
      statCard(['Invalid dates', String(r.issues.invalidDates.length)]) +
      statCard(['Unexpected fields', String(r.issues.unexpectedElements.length)]) +
      '</section>';

    // Field completeness
    html += '<h3 class="rep-h">Field completeness</h3><div class="preview"><table><thead><tr>' +
      '<th>Field</th><th>Type</th><th>Complete</th><th>Present</th><th>Missing</th><th>Distinct</th></tr></thead><tbody>' +
      r.fields.map(function (f) {
        return '<tr><td>' + esc(f.name) + '</td><td>' + f.type + '</td>' +
          '<td>' + bar(f.completeness) + '</td>' +
          '<td>' + f.present.toLocaleString() + '</td><td>' + f.missing.toLocaleString() + '</td>' +
          '<td>' + f.distinct.toLocaleString() + (f.totalValues != null ? ' (' + f.totalValues.toLocaleString() + ' values)' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    // Issues
    if (r.issues.duplicateIds.length) {
      html += '<h3 class="rep-h">Duplicate ' + esc(QFTransform.HPRA_KEY) + ' (' + r.issues.duplicateIds.length + ')</h3>' +
        '<p class="muted small">' + r.issues.duplicateIds.slice(0, 20).map(function (d) {
          return esc(d.id) + ' ×' + d.occurrences;
        }).join(' · ') + '</p>';
    }
    if (r.issues.invalidDates.length) {
      html += '<h3 class="rep-h">Invalid / ambiguous AuthorisedDate (' + r.issues.invalidDates.length + ')</h3>' +
        '<p class="muted small">' + r.issues.invalidDates.slice(0, 20).map(function (d) {
          return esc(d.DrugIDPK) + ': "' + esc(d.value) + '"';
        }).join(' · ') + '</p>';
    }
    if (r.issues.unexpectedElements.length) {
      html += '<h3 class="rep-h">Unexpected elements</h3>' +
        '<p class="muted small">' + r.issues.unexpectedElements.map(function (u) {
          return esc(u.value) + ' ×' + u.count;
        }).join(' · ') + '</p>';
    }

    // Distributions
    var d = r.distributions;
    if (d && d.MarketInfo) {
      html += '<h3 class="rep-h">Distributions</h3><div class="dist-grid">' +
        distBlock('Market status', mapToList(d.MarketInfo)) +
        distBlock('Registration status', mapToList(d.RegistrationStatus)) +
        distBlock('Product type', mapToList(d.ProductType)) +
        distBlock('Top PA holders', d.topPAHolders) +
        distBlock('ATC (1st level)', d.atcFirstLevel) +
        distBlock('Dispensing status', d.DispensingLegalStatus) +
        '</div>';
    }

    el.qualityBody.innerHTML = html;
  }

  function mapToList(map) {
    return Object.keys(map).map(function (k) { return { value: k, count: map[k] }; })
      .sort(function (a, b) { return b.count - a.count; });
  }

  function distBlock(title, items) {
    if (!items || !items.length) return '';
    var max = items.reduce(function (m, i) { return Math.max(m, i.count); }, 0);
    return '<div class="dist"><h4>' + esc(title) + '</h4>' +
      items.slice(0, 12).map(function (i) {
        var w = max ? Math.round((i.count / max) * 100) : 0;
        return '<div class="dist-row"><span class="dist-label" title="' + esc(i.value) + '">' + esc(i.value) + '</span>' +
          '<span class="dist-track"><span class="dist-fill" style="width:' + w + '%"></span></span>' +
          '<span class="dist-count">' + i.count.toLocaleString() + '</span></div>';
      }).join('') + '</div>';
  }

  function bar(frac) {
    var p = Math.round(frac * 100);
    return '<span class="cbar"><span class="cbar-fill" style="width:' + p + '%"></span></span><span class="cbar-num">' + pct(frac) + '</span>';
  }

  // ---- Compare (#1) ----------------------------------------------------------

  function loadCmpFile(slot, file) {
    var name = (file.name || slot).replace(/\.[^.]+$/, '');
    var statusEl = slot === 'a' ? el.cmpStatusA : el.cmpStatusB;
    statusEl.textContent = 'Reading "' + (file.name || name) + '"…';
    readFileText(file)
      .then(function (t) {
        statusEl.textContent = 'Parsing…';
        return parseViaWorker(t);
      })
      .then(function (m) {
        if (!m.records || !m.records.length) { statusEl.textContent = 'No records found.'; return; }
        state.cmp[slot] = { records: m.records, meta: m.meta, isHPRA: m.isHPRA, recordTag: m.recordTag, name: name };
        statusEl.innerHTML = '<strong>' + esc(name) + '</strong> · ' + m.recordCount.toLocaleString() +
          ' records' + (m.meta.datePublished ? ' · ' + esc(m.meta.datePublished) : '');
        if (state.cmp.a && state.cmp.b) computeDiff();
      })
      .catch(function (e) { statusEl.textContent = 'Error: ' + e.message; });
  }

  function computeDiff() {
    var a = state.cmp.a, b = state.cmp.b;
    var oldB = QFTransform.buildRows(a.records, a.meta, { explode: 'none', isHPRA: a.isHPRA });
    var newB = QFTransform.buildRows(b.records, b.meta, { explode: 'none', isHPRA: b.isHPRA });
    var key = (a.isHPRA && b.isHPRA) ? QFTransform.HPRA_KEY : (newB.columns[0] || oldB.columns[0]);
    var label = (a.isHPRA && b.isHPRA) ? 'ProductName' : (newB.columns[1] || newB.columns[0]);
    state.cmp.diff = QFDiff.buildDiff(oldB.rows, newB.rows, { key: key, labelCol: label });
    state.cmp.diff._labelCol = label;
    renderDiff();
    el.dlDiffCsv.disabled = false; el.dlDiffJson.disabled = false;
  }

  function renderDiff() {
    var diff = state.cmp.diff, s = diff.summary, label = diff.diffLabel || diff._labelCol;
    el.diffStats.innerHTML =
      statCard(['Added', s.added.toLocaleString()]) +
      statCard(['Removed', s.removed.toLocaleString()]) +
      statCard(['Changed', s.changed.toLocaleString()]) +
      statCard(['Unchanged', s.unchanged.toLocaleString()]) +
      statCard(['Baseline rows', s.oldCount.toLocaleString()]) +
      statCard(['Updated rows', s.newCount.toLocaleString()]);

    var html = '';
    html += diffSection('Added (' + s.added + ')', diff.added.slice(0, DIFF_ROWS), function (r) {
      return '<tr><td>' + esc(r[diff.key]) + '</td><td>' + esc(strOr(r[label])) + '</td></tr>';
    }, '<th>' + esc(diff.key) + '</th><th>Product</th>', diff.added.length);

    html += diffSection('Removed (' + s.removed + ')', diff.removed.slice(0, DIFF_ROWS), function (r) {
      return '<tr><td>' + esc(r[diff.key]) + '</td><td>' + esc(strOr(r[label])) + '</td></tr>';
    }, '<th>' + esc(diff.key) + '</th><th>Product</th>', diff.removed.length);

    var changedRows = [];
    diff.changed.forEach(function (c) {
      c.changes.forEach(function (ch) {
        changedRows.push('<tr><td>' + esc(c.key) + '</td><td>' + esc(strOr(c.label)) + '</td><td>' + esc(ch.field) +
          '</td><td class="old">' + esc(strOr(ch.old)) + '</td><td class="new">' + esc(strOr(ch.new)) + '</td></tr>');
        if (changedRows.length > DIFF_ROWS * 2) return;
      });
    });
    html += '<details class="diff-sec" open><summary>Changed (' + s.changed + ' products)</summary>' +
      '<div class="preview"><table><thead><tr><th>' + esc(diff.key) +
      '</th><th>Product</th><th>Field</th><th>Old</th><th>New</th></tr></thead><tbody>' +
      changedRows.join('') + '</tbody></table></div></details>';

    el.diffBody.innerHTML = html;
  }

  function diffSection(title, rows, rowFn, head, total) {
    return '<details class="diff-sec"' + (rows.length ? ' open' : '') + '><summary>' + esc(title) +
      (total > rows.length ? ' — showing first ' + rows.length : '') + '</summary>' +
      '<div class="preview"><table><thead><tr>' + head + '</tr></thead><tbody>' +
      rows.map(rowFn).join('') + '</tbody></table></div></details>';
  }

  function strOr(v) { return v === null || v === undefined ? '' : String(v); }

  function diffDownload(kind) {
    var diff = state.cmp.diff;
    if (!diff) return;
    var nm = (state.cmp.a.name || 'old') + '_vs_' + (state.cmp.b.name || 'new');
    if (kind === 'csv') saveBlob(QFDiff.diffToCSV(diff, diff._labelCol), nm + '_changelog.csv', 'text/csv');
    else saveBlob(QFDiff.diffToJSON(diff), nm + '_diff.json', 'application/json');
  }

  // ---- Changelog modal -------------------------------------------------------

  var modalReturnFocus = null;

  function renderChangelog() {
    el.appVersion.textContent = 'v' + APP_VERSION;
    el.changelogBody.innerHTML = '<ul class="cl-list">' + CHANGELOG.map(function (e) {
      return '<li class="cl-entry">' +
        '<div class="cl-meta"><span class="cl-ver">v' + esc(e.version) + '</span>' +
        '<span class="cl-date">' + esc(e.date) + '</span></div>' +
        '<h3 class="cl-title">' + esc(e.title) + '</h3>' +
        '<ul class="cl-items">' + e.items.map(function (it) { return '<li>' + esc(it) + '</li>'; }).join('') +
        '</ul></li>';
    }).join('') + '</ul>';
  }

  function openChangelog() {
    renderChangelog();
    el.changelogModal.hidden = false;
    document.body.classList.add('modal-open');
    modalReturnFocus = document.activeElement;
    el.changelogClose.focus();
    document.addEventListener('keydown', onModalKey);
    markVersionSeen();
  }

  function closeChangelog() {
    el.changelogModal.hidden = true;
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onModalKey);
    if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
  }

  function onModalKey(e) {
    if (e.key === 'Escape') { closeChangelog(); return; }
    if (e.key !== 'Tab') return;
    // Minimal focus trap.
    var f = el.changelogModal.querySelectorAll('button, a[href]');
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function markVersionSeen() {
    try { localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION); } catch (e) {}
    el.changelogBtn.classList.remove('has-new');
  }

  function flagIfNewVersion() {
    var seen = null;
    try { seen = localStorage.getItem(SEEN_VERSION_KEY); } catch (e) {}
    if (seen !== APP_VERSION) el.changelogBtn.classList.add('has-new');
  }

  // ---- Tabs ------------------------------------------------------------------

  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    ['convert', 'quality', 'compare'].forEach(function (t) {
      document.getElementById('tab-' + t).hidden = (t !== name);
    });
  }

  // ---- UI helpers ------------------------------------------------------------

  function setStatus(m) { el.status.textContent = m; }
  function showProgress(show, p, label) {
    el.progress.hidden = !show;
    if (show) { el.progressBar.style.width = (p || 0) + '%'; el.progressLabel.textContent = (label || '') + (p != null ? ' ' + p + '%' : ''); }
  }
  function showError(m) { el.error.textContent = m || ''; el.error.hidden = !m; }
  function fail(m) { showProgress(false); setStatus(''); showError(m); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // ---- Wiring ----------------------------------------------------------------

  function stop(e) { e.preventDefault(); e.stopPropagation(); }

  function wireDrop(zone, input, onFile) {
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { stop(e); zone.classList.add('over'); });
    });
    ['dragleave', 'dragend'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { stop(e); zone.classList.remove('over'); });
    });
    zone.addEventListener('drop', function (e) {
      stop(e); zone.classList.remove('over');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
    zone.addEventListener('click', function (e) { if (e.target.closest('.link')) return; input.click(); });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', function () { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
  }

  wireDrop(el.dropzone, el.fileInput, loadPrimaryFile);
  wireDrop(el.cmpDropA, el.cmpFileA, function (f) { loadCmpFile('a', f); });
  wireDrop(el.cmpDropB, el.cmpFileB, function (f) { loadCmpFile('b', f); });

  el.browseBtn.addEventListener('click', function (e) { e.stopPropagation(); el.fileInput.click(); });
  el.demoBtn.addEventListener('click', function (e) { e.stopPropagation(); loadDemo(); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-browse]'), function (btn) {
    btn.addEventListener('click', function (e) { e.stopPropagation(); document.getElementById(btn.getAttribute('data-browse')).click(); });
  });

  [el.explode, el.isoDate, el.includeSource].forEach(function (c) { c.addEventListener('change', renderConvert); });
  el.separator.addEventListener('input', renderConvert);

  el.colList.addEventListener('change', onColListEvent);
  el.colList.addEventListener('input', onColListEvent);
  el.colList.addEventListener('click', onColListEvent);

  el.copyLink.addEventListener('click', copyShareLink);
  el.saveProfile.addEventListener('click', saveDefaultProfile);
  el.resetProfile.addEventListener('click', resetProfile);

  el.dlCsv.addEventListener('click', function () { convertDownload('csv'); });
  el.dlJson.addEventListener('click', function () { convertDownload('json'); });
  el.dlNdjson.addEventListener('click', function () { convertDownload('ndjson'); });
  el.dlXlsx.addEventListener('click', function () { convertDownload('xlsx'); });
  el.dlStarZip.addEventListener('click', function () { starDownload('zip'); });
  el.dlStarXlsx.addEventListener('click', function () { starDownload('xlsx'); });

  el.dlReportJson.addEventListener('click', function () { saveBlob(QFReport.reportToJSON(state.report), state.primary.sourceName + '_quality.json', 'application/json'); });
  el.dlReportCsv.addEventListener('click', function () { saveBlob(QFReport.fieldsToCSV(state.report), state.primary.sourceName + '_field_completeness.csv', 'text/csv'); });

  el.dlDiffCsv.addEventListener('click', function () { diffDownload('csv'); });
  el.dlDiffJson.addEventListener('click', function () { diffDownload('json'); });

  Array.prototype.forEach.call(document.querySelectorAll('.tab-btn'), function (b) {
    b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
  });

  el.changelogBtn.addEventListener('click', openChangelog);
  el.changelogModal.addEventListener('click', function (e) {
    if (e.target.hasAttribute('data-close')) closeChangelog();
  });

  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  // Load any saved/shared profile so it applies on first file load.
  pendingProfile = loadStoredProfile();
  flagIfNewVersion();
})();
