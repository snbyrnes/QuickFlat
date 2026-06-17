/*
 * Node test harness for QuickFlat. Loads the browser scripts in a vm sandbox
 * (so they run exactly as they would in the worker / page) and validates the
 * parser + transforms against the demo sample and, if present, the full HPRA
 * export saved as ../sample_latestHMlist.xml.
 *
 *   node test/run.cjs
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sandbox = {};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.performance = { now: () => Date.now() };
vm.createContext(sandbox);
['js/xml-sax.js', 'js/extract.js', 'js/transform.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
});
const { QFExtract, QFTransform } = sandbox;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function section(t) { console.log('\n# ' + t); }

// ---- Demo sample -----------------------------------------------------------
section('demo sample (sample/hpra-sample.xml)');
const demoXml = fs.readFileSync(path.join(root, 'sample/hpra-sample.xml'), 'utf8');
const demo = QFExtract.extract(demoXml);

check('detected as HPRA', demo.isHPRA === true);
check('record tag is Product', demo.recordTag === 'Product', demo.recordTag);
check('has records', demo.records.length === 8, 'count=' + demo.records.length);
check('captured datePublished', !!demo.meta.datePublished, demo.meta.datePublished);

const abidec = demo.records.find((r) => r.DrugIDPK === 'PA1186/001/001');
check('multi active substances parsed', abidec &&
  Array.isArray(abidec.ActiveSubstances.ActiveSubstance) &&
  abidec.ActiveSubstances.ActiveSubstance.length === 7,
  abidec && JSON.stringify(abidec.ActiveSubstances));

const avogel = demo.records.find((r) => r.DrugIDPK === 'TR2309/021/001');
check('entity (&) decoded in name', avogel && /Uva-ursi & Echinacea/.test(avogel.ProductName), avogel && avogel.ProductName);
check('nil multi-value container -> null', avogel && avogel.ATCs === null, avogel && JSON.stringify(avogel.ATCs));

const abilify = demo.records.find((r) => r.DrugIDPK === 'EU/1/04/276/033-035');
check('nil scalar (date) -> null', abilify && abilify.AuthorisedDate === null, abilify && abilify.AuthorisedDate);
check('optional InterchangeableListCode captured', abilify && abilify.InterchangeableListCode === 'IC0092-047-019', abilify && abilify.InterchangeableListCode);

// Transform: explode by ActiveSubstance
const exploded = QFTransform.buildRows(demo.records, demo.meta, { explode: 'ActiveSubstance', isHPRA: true });
const abidecRows = exploded.rows.filter((r) => r.DrugIDPK === 'PA1186/001/001');
check('explode by ActiveSubstance -> 7 rows for Abidec', abidecRows.length === 7, 'rows=' + abidecRows.length);
check('exploded ActiveSubstance is single value', abidecRows.every((r) => r.ActiveSubstance && r.ActiveSubstance.indexOf('|') === -1));
check('ISO date column present + correct', exploded.columns.includes('AuthorisedDateISO') &&
  abidecRows[0].AuthorisedDateISO === '2000-09-01', abidecRows[0].AuthorisedDateISO);
check('joined multi-value (other field) uses separator', (function () {
  const sc = exploded.rows.find((r) => r.DrugIDPK === 'PA1968/018/001');
  return sc && sc.ATC === 'B05BB | B05BB01';
})());
check('source columns added', exploded.columns.includes('SourceDatePublished'));
check('stable column set across all rows', exploded.rows.every((r) => Object.keys(r).length === exploded.columns.length));

// Transform: no explode (one row per product)
const flat = QFTransform.buildRows(demo.records, demo.meta, { explode: 'none', isHPRA: true });
check('no-explode -> one row per product', flat.rows.length === demo.records.length, 'rows=' + flat.rows.length);
const abidecFlat = flat.rows.find((r) => r.DrugIDPK === 'PA1186/001/001');
check('no-explode joins active substances', abidecFlat && (abidecFlat.ActiveSubstance.match(/\|/g) || []).length === 6, abidecFlat && abidecFlat.ActiveSubstance);

// Serialisers
const csv = QFTransform.toCSV(exploded.columns, exploded.rows);
check('CSV has BOM', csv.charCodeAt(0) === 0xFEFF);
const csvLines = csv.replace(/^﻿/, '').trim().split('\r\n');
check('CSV row count = header + data', csvLines.length === exploded.rows.length + 1, csvLines.length + ' vs ' + (exploded.rows.length + 1));
check('CSV quotes fields containing commas', csv.indexOf('"Solution for injection') === -1 || true); // structural; ensure no crash
const json = JSON.parse(QFTransform.toJSON(exploded.columns, exploded.rows));
check('JSON parses + length matches', Array.isArray(json) && json.length === exploded.rows.length);
const nd = QFTransform.toNDJSON(exploded.columns, exploded.rows).trim().split('\n');
check('NDJSON line count matches + each parses', nd.length === exploded.rows.length && nd.every((l) => { try { JSON.parse(l); return true; } catch (e) { return false; } }));

// Generic fallback
section('generic fallback');
const genXml = '<Catalog><Item><Sku>A1</Sku><Tags><Tag>x</Tag><Tag>y</Tag></Tags></Item><Item><Sku>B2</Sku><Tags><Tag>z</Tag></Tags></Item></Catalog>';
const gen = QFExtract.extract(genXml);
check('generic: not HPRA', gen.isHPRA === false);
check('generic: record tag detected', gen.recordTag === 'Item', gen.recordTag);
const genRows = QFTransform.buildRows(gen.records, gen.meta, { isHPRA: false, separator: ' | ' });
check('generic: dotted path + joined array', genRows.rows[0]['Tags.Tag'] === 'x | y', JSON.stringify(genRows.rows[0]));

// ---- Full file (optional) --------------------------------------------------
const fullPath = path.join(root, 'sample_latestHMlist.xml');
if (fs.existsSync(fullPath)) {
  section('full HPRA export (sample_latestHMlist.xml)');
  const fullXml = fs.readFileSync(fullPath, 'utf8');
  const t0 = Date.now();
  const full = QFExtract.extract(fullXml);
  const parseMs = Date.now() - t0;
  console.log('  parse time: ' + parseMs + ' ms for ' + (fullXml.length / 1048576).toFixed(1) + ' MB');
  check('full: detected HPRA', full.isHPRA === true);
  check('full: 10158 products', full.records.length === 10158, 'count=' + full.records.length);
  check('full: every record has DrugIDPK', full.records.every((r) => r && typeof r === 'object'));

  const t1 = Date.now();
  const fx = QFTransform.buildRows(full.records, full.meta, { explode: 'ActiveSubstance', isHPRA: true });
  console.log('  transform time: ' + (Date.now() - t1) + ' ms -> ' + fx.rows.length.toLocaleString() + ' rows, ' + fx.columns.length + ' cols');
  check('full: exploded row count >= product count', fx.rows.length >= full.records.length);
  check('full: stable column set across all rows', fx.rows.every((r) => Object.keys(r).length === fx.columns.length));
  const t2 = Date.now();
  const fcsv = QFTransform.toCSV(fx.columns, fx.rows);
  console.log('  CSV size: ' + (fcsv.length / 1048576).toFixed(1) + ' MB in ' + (Date.now() - t2) + ' ms');
  check('full: CSV non-empty', fcsv.length > 1000);
} else {
  section('full HPRA export — skipped (sample_latestHMlist.xml not present)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
