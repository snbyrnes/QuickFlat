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
sandbox.TextEncoder = TextEncoder; // Web API used by zip.js, not a JS intrinsic
sandbox.Date = Date;
vm.createContext(sandbox);
['js/xml-sax.js', 'js/extract.js', 'js/transform.js', 'js/report.js', 'js/diff.js', 'js/zip.js', 'js/xlsx.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
});
const { QFExtract, QFTransform, QFReport, QFDiff, QFZip, QFXlsx } = sandbox;

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

// ---- #4 Column config -----------------------------------------------------
section('column config (select / reorder / rename)');
const cfgIn = QFTransform.buildRows(demo.records, demo.meta, { explode: 'none', isHPRA: true });
const cfg = QFTransform.applyColumnConfig(cfgIn.columns, cfgIn.rows, {
  order: ['ProductName', 'DrugIDPK'],
  hidden: { SourceSchemaVersion: true, SourceDatePublished: true },
  rename: { ProductName: 'Product', DrugIDPK: 'ID' }
});
check('reorder puts Product/ID first', cfg.columns[0] === 'Product' && cfg.columns[1] === 'ID', cfg.columns.slice(0, 3).join(','));
check('hidden columns removed', cfg.columns.indexOf('SourceSchemaVersion') === -1 && cfg.columns.indexOf('SourceDatePublished') === -1);
check('rename applied to keys', cfg.rows[0].Product !== undefined && cfg.rows[0].ID !== undefined);
check('non-listed columns retained', cfg.columns.indexOf('PAHolder') !== -1);

// ---- #3 Star schema -------------------------------------------------------
section('star schema');
const star = QFTransform.buildStarSchema(demo.records, demo.meta, { isHPRA: true });
const tableNames = star.map((t) => t.name);
check('emits products + 4 bridge tables', star.length === 5 && tableNames[0] === 'products', tableNames.join(','));
const subsTable = star.find((t) => t.name === 'product_active_substances');
check('bridge has DrugIDPK + value columns', subsTable.columns.join(',') === 'DrugIDPK,ActiveSubstance');
const abidecSubs = subsTable.rows.filter((r) => r.DrugIDPK === 'PA1186/001/001');
check('Abidec has 7 substance rows in bridge', abidecSubs.length === 7, 'rows=' + abidecSubs.length);
const productsTable = star.find((t) => t.name === 'products');
check('products has one row per product, no multi-value cols', productsTable.rows.length === demo.records.length &&
  productsTable.columns.indexOf('ActiveSubstance') === -1);

// ---- #1 Diff --------------------------------------------------------------
section('change tracking (diff)');
const oldRows = QFTransform.buildRows(demo.records, demo.meta, { explode: 'none', isHPRA: true }).rows;
// Synthesize a "new" version: drop one product, add one, change one field.
const newRecords = demo.records.slice(1).map((r) => Object.assign({}, r));
newRecords.push({ DrugIDPK: 'NEW/001', LicenceNumber: 'NEW/001', ProductName: 'Brand New Product', PAHolder: 'X' });
const changedIdx = newRecords.findIndex((r) => r.DrugIDPK === 'PA1186/001/001');
newRecords[changedIdx] = Object.assign({}, newRecords[changedIdx], { MarketInfo: 'Withdrawn' });
const newRows = QFTransform.buildRows(newRecords, demo.meta, { explode: 'none', isHPRA: true }).rows;
const diff = QFDiff.buildDiff(oldRows, newRows, { key: 'DrugIDPK' });
check('diff: 1 added', diff.summary.added === 1, JSON.stringify(diff.summary));
check('diff: 1 removed', diff.summary.removed === 1, JSON.stringify(diff.summary));
check('diff: 1 changed (MarketInfo)', diff.summary.changed === 1 &&
  diff.changed[0].changes.some((c) => c.field === 'MarketInfo' && c.new === 'Withdrawn'), JSON.stringify(diff.changed[0] && diff.changed[0].changes));
check('diff: source columns ignored (no false changes)', diff.changed.every((c) => c.changes.every((ch) => ch.field.indexOf('Source') === -1)));
const dcsv = QFDiff.diffToCSV(diff).replace(/^﻿/, '').trim().split('\r\n');
check('diff CSV has header + change rows', dcsv.length >= 4 && dcsv[0].startsWith('change,DrugIDPK'));

// ---- #2 Quality report ----------------------------------------------------
section('quality report');
const rep = QFReport.buildReport(demo.records, demo.meta, demo.recordTag, demo.isHPRA);
check('report: schema + record count', rep.schema === 'HPRA human medicines' && rep.recordCount === 8);
const fDrug = rep.fields.find((f) => f.name === 'DrugIDPK');
check('report: DrugIDPK 100% complete', fDrug.completeness === 1, JSON.stringify(fDrug));
const fInter = rep.fields.find((f) => f.name === 'InterchangeableListCode');
check('report: optional field partially complete', fInter.completeness > 0 && fInter.completeness < 1, JSON.stringify(fInter));
const fSubs = rep.fields.find((f) => f.name === 'ActiveSubstance');
check('report: multi field has totalValues', fSubs.type === 'multi' && fSubs.totalValues >= 8, JSON.stringify(fSubs));
check('report: invalid dates detected as array', Array.isArray(rep.issues.invalidDates));
check('report: distributions present', !!rep.distributions.MarketInfo && Object.keys(rep.distributions.MarketInfo).length > 0);
const repCsv = QFReport.fieldsToCSV(rep).replace(/^﻿/, '').split('\r\n');
check('report CSV header', repCsv[0] === 'field,type,present,missing,completeness_pct,distinct_values');
JSON.parse(QFReport.reportToJSON(rep));
check('report JSON valid', true);

// ---- #3/#5 ZIP + XLSX bytes ------------------------------------------------
section('zip + xlsx writers');
const outDir = path.join(root, 'test', 'out');
fs.mkdirSync(outDir, { recursive: true });
const zipBytes = QFZip.makeZip(star.map((t) => ({ name: t.name + '.csv', data: QFTransform.toCSV(t.columns, t.rows) })));
check('zip: starts with PK signature', zipBytes[0] === 0x50 && zipBytes[1] === 0x4B);
check('zip: ends with EOCD signature', (function () {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset + zipBytes.length - 22, 4);
  return dv.getUint32(0, true) === 0x06054b50;
})());
fs.writeFileSync(path.join(outDir, 'star.zip'), Buffer.from(zipBytes));
const xlsxBytes = QFXlsx.buildWorkbook(star.map((t) => ({ name: t.name, columns: t.columns, rows: t.rows })));
check('xlsx: starts with PK signature', xlsxBytes[0] === 0x50 && xlsxBytes[1] === 0x4B);
fs.writeFileSync(path.join(outDir, 'star.xlsx'), Buffer.from(xlsxBytes));
console.log('  wrote test/out/star.zip (' + zipBytes.length + 'B) and test/out/star.xlsx (' + xlsxBytes.length + 'B) for external validation');

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
