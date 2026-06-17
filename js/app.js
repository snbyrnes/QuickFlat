/*
 * QuickFlat - UI controller.
 *
 * Wires drag/drop + file picking to the worker, renders a live preview and
 * stats, and produces CSV / JSON / NDJSON downloads. Everything runs in the
 * browser; no data is ever uploaded.
 */
(function () {
  'use strict';

  var PREVIEW_ROWS = 200;

  var state = {
    records: null,
    meta: null,
    isHPRA: false,
    recordTag: null,
    sourceName: 'data',
    columns: [],
    rows: []
  };

  var el = {};
  ['dropzone', 'fileInput', 'browseBtn', 'demoBtn', 'progress', 'progressBar', 'progressLabel',
   'status', 'controls', 'explode', 'separator', 'isoDate', 'includeSource', 'stats',
   'preview', 'previewWrap', 'previewNote', 'dlCsv', 'dlJson', 'dlNdjson', 'error'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  // ---- File intake -----------------------------------------------------------

  function onFiles(files) {
    if (!files || !files.length) return;
    var file = files[0];
    var name = (file.name || 'data').replace(/\.[^.]+$/, '');
    readFile(file, name);
  }

  function readFile(file, name) {
    showError('');
    setStatus('Reading "' + (file.name || name) + '"…');
    showProgress(true, 0, 'Reading file');
    var reader = new FileReader();
    reader.onerror = function () { fail('Could not read that file.'); };
    reader.onload = function () { parse(String(reader.result), name); };
    reader.readAsText(file);
  }

  function loadDemo() {
    showError('');
    setStatus('Loading demo file…');
    showProgress(true, 0, 'Loading demo');
    fetch('sample/hpra-sample.xml')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (text) { parse(text, 'hpra-sample'); })
      .catch(function (e) { fail('Could not load the demo file (' + e.message + ').'); });
  }

  // ---- Parsing (worker) ------------------------------------------------------

  function parse(text, name) {
    state.sourceName = name;
    showProgress(true, 0, 'Parsing XML');
    var worker;
    try {
      worker = new Worker('js/worker.js');
    } catch (e) {
      fail('Web Workers are unavailable in this browser.');
      return;
    }
    worker.onmessage = function (e) {
      var m = e.data;
      if (m.type === 'progress') {
        showProgress(true, m.pct, 'Parsing XML');
      } else if (m.type === 'done') {
        worker.terminate();
        onParsed(m);
      } else if (m.type === 'error') {
        worker.terminate();
        fail('Could not parse the XML: ' + m.message);
      }
    };
    worker.onerror = function (e) {
      worker.terminate();
      fail('Parser error: ' + (e.message || 'unknown'));
    };
    worker.postMessage({ type: 'parse', text: text });
  }

  function onParsed(m) {
    state.records = m.records;
    state.meta = m.meta;
    state.isHPRA = m.isHPRA;
    state.recordTag = m.recordTag;

    showProgress(false);
    if (!m.records || !m.records.length) {
      fail('No records were found. Expecting a root element containing repeated record elements (e.g. <Products><Product>…).');
      return;
    }

    setStatus(
      (m.isHPRA ? 'HPRA human-medicines list detected. ' : 'Generic XML detected (' +
        (m.recordTag || 'record') + '). ') +
      m.recordCount.toLocaleString() + ' ' + (m.recordTag || 'record') + ' records.'
    );

    buildControls();
    el.controls.hidden = false;
    render();
  }

  // ---- Controls --------------------------------------------------------------

  function buildControls() {
    var explode = el.explode;
    explode.innerHTML = '';
    addOption(explode, 'none', 'One row per ' + (state.recordTag || 'record') + ' (no explode)');
    if (state.isHPRA) {
      QFTransform.HPRA_MULTI.forEach(function (m) {
        addOption(explode, m.col, 'Explode by ' + m.col);
      });
      explode.value = 'ActiveSubstance';
      explode.disabled = false;
      el.explode.title = '';
    } else {
      explode.value = 'none';
      explode.disabled = true;
      el.explode.title = 'Explode is available for recognised HPRA lists only.';
    }
  }

  function addOption(sel, value, label) {
    var o = document.createElement('option');
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  }

  function currentOpts() {
    return {
      explode: el.explode.value,
      separator: el.separator.value.length ? el.separator.value : ' | ',
      addISODate: el.isoDate.checked,
      includeSource: el.includeSource.checked,
      isHPRA: state.isHPRA
    };
  }

  // ---- Render ----------------------------------------------------------------

  function render() {
    if (!state.records) return;
    var t0 = performance.now();
    var out = QFTransform.buildRows(state.records, state.meta, currentOpts());
    state.columns = out.columns;
    state.rows = out.rows;
    var ms = Math.round(performance.now() - t0);

    renderStats(ms);
    renderPreview();
    [el.dlCsv, el.dlJson, el.dlNdjson].forEach(function (b) { b.disabled = state.rows.length === 0; });
  }

  function renderStats(ms) {
    var rows = [
      ['Source records', state.records.length.toLocaleString()],
      ['Output rows', state.rows.length.toLocaleString()],
      ['Columns', String(state.columns.length)],
      ['Schema', state.isHPRA ? 'HPRA human medicines' : 'Generic'],
      ['Published', state.meta.datePublished || '—'],
      ['Transform', ms + ' ms']
    ];
    el.stats.innerHTML = rows.map(function (r) {
      return '<div class="stat"><span class="stat-val">' + esc(r[1]) +
        '</span><span class="stat-key">' + esc(r[0]) + '</span></div>';
    }).join('');
  }

  function renderPreview() {
    var cols = state.columns;
    var rows = state.rows.slice(0, PREVIEW_ROWS);
    var html = '<table><thead><tr>' +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') +
      '</tr></thead><tbody>' +
      rows.map(function (row) {
        return '<tr>' + cols.map(function (c) {
          var v = row[c];
          return '<td' + (v === null ? ' class="null"' : '') + '>' +
            (v === null ? '∅' : esc(String(v))) + '</td>';
        }).join('') + '</tr>';
      }).join('') +
      '</tbody></table>';
    el.preview.innerHTML = html;
    el.previewWrap.hidden = false;
    el.previewNote.textContent = state.rows.length > PREVIEW_ROWS
      ? 'Showing first ' + PREVIEW_ROWS + ' of ' + state.rows.length.toLocaleString() + ' rows.'
      : 'Showing all ' + state.rows.length.toLocaleString() + ' rows.';
  }

  // ---- Downloads -------------------------------------------------------------

  function baseName() {
    var mode = el.explode.value !== 'none' ? '_by' + el.explode.value : '_flat';
    return state.sourceName + mode;
  }

  function download(kind) {
    if (!state.rows.length) return;
    var data, mime, ext;
    if (kind === 'csv') {
      data = QFTransform.toCSV(state.columns, state.rows); mime = 'text/csv'; ext = 'csv';
    } else if (kind === 'json') {
      data = QFTransform.toJSON(state.columns, state.rows); mime = 'application/json'; ext = 'json';
    } else {
      data = QFTransform.toNDJSON(state.columns, state.rows); mime = 'application/x-ndjson'; ext = 'ndjson';
    }
    var blob = new Blob([data], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = baseName() + '.' + ext;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---- UI helpers ------------------------------------------------------------

  function setStatus(msg) { el.status.textContent = msg; }

  function showProgress(show, pct, label) {
    el.progress.hidden = !show;
    if (show) {
      el.progressBar.style.width = (pct || 0) + '%';
      el.progressLabel.textContent = (label || '') + (pct != null ? ' ' + pct + '%' : '');
    }
  }

  function showError(msg) {
    el.error.textContent = msg || '';
    el.error.hidden = !msg;
  }

  function fail(msg) {
    showProgress(false);
    setStatus('');
    showError(msg);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- Wiring ----------------------------------------------------------------

  function stop(e) { e.preventDefault(); e.stopPropagation(); }

  ['dragenter', 'dragover'].forEach(function (ev) {
    el.dropzone.addEventListener(ev, function (e) { stop(e); el.dropzone.classList.add('over'); });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    el.dropzone.addEventListener(ev, function (e) { stop(e); el.dropzone.classList.remove('over'); });
  });
  el.dropzone.addEventListener('drop', function (e) {
    stop(e); el.dropzone.classList.remove('over');
    onFiles(e.dataTransfer && e.dataTransfer.files);
  });
  el.dropzone.addEventListener('click', function () { el.fileInput.click(); });
  el.dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.fileInput.click(); }
  });
  el.browseBtn.addEventListener('click', function (e) { e.stopPropagation(); el.fileInput.click(); });
  el.fileInput.addEventListener('change', function () { onFiles(el.fileInput.files); el.fileInput.value = ''; });
  el.demoBtn.addEventListener('click', function (e) { e.stopPropagation(); loadDemo(); });

  [el.explode, el.separator, el.isoDate, el.includeSource].forEach(function (c) {
    c.addEventListener('change', render);
  });
  el.separator.addEventListener('input', render);

  el.dlCsv.addEventListener('click', function () { download('csv'); });
  el.dlJson.addEventListener('click', function () { download('json'); });
  el.dlNdjson.addEventListener('click', function () { download('ndjson'); });

  // Prevent the browser from navigating away if a file is dropped outside the zone.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
})();
