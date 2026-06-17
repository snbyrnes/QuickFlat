/*
 * Headless end-to-end UI test (Playwright/Chromium).
 * Expects a static server already running at BASE (default http://localhost:8731).
 *   node test/ui.cjs
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:8731';
const SAMPLE = path.resolve(__dirname, '..', 'sample', 'hpra-sample.xml');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'load' });

  // --- Convert: load demo ---
  await page.click('#demoBtn');
  await page.waitForSelector('#preview table tbody tr', { timeout: 15000 });
  const headerCols = await page.$$eval('#preview thead th', (th) => th.map((t) => t.textContent));
  check('convert: preview renders with HPRA columns', headerCols.includes('ActiveSubstance') && headerCols.includes('DrugIDPK'), headerCols.slice(0, 4).join(','));
  const rowCount = await page.$$eval('#preview tbody tr', (tr) => tr.length);
  check('convert: preview has rows', rowCount > 0, 'rows=' + rowCount);
  const statText = await page.textContent('#stats');
  check('convert: stats show schema', /HPRA human medicines/.test(statText));

  // --- #4 column config: hide a column ---
  await page.click('#colPanelWrap > summary');
  await page.waitForSelector('.col-row');
  // Uncheck PAHolder
  const paRow = page.locator('.col-row[data-col="PAHolder"]');
  await paRow.locator('input[data-act="vis"]').uncheck();
  let afterHide = await page.$$eval('#preview thead th', (th) => th.map((t) => t.textContent));
  check('#4 hide column removes it from preview', !afterHide.includes('PAHolder'));
  // Rename ProductName -> Product
  const pnRow = page.locator('.col-row[data-col="ProductName"]');
  await pnRow.locator('input[data-act="rename"]').fill('Product');
  await page.waitForTimeout(150);
  let afterRename = await page.$$eval('#preview thead th', (th) => th.map((t) => t.textContent));
  check('#4 rename column updates preview header', afterRename.includes('Product') && !afterRename.includes('ProductName'));

  // --- #4 profiles: save + copy link don't error ---
  await page.click('#saveProfile');
  check('#4 save profile shows confirmation', /Saved/.test(await page.textContent('#profileMsg')));

  // --- downloads (CSV / JSON / NDJSON / XLSX / star ZIP / star XLSX) ---
  async function dl(sel) {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click(sel)]);
    const fp = await download.path();
    const size = fp ? fs.statSync(fp).size : 0;
    return size;
  }
  check('download CSV non-empty', (await dl('#dlCsv')) > 100);
  check('download JSON non-empty', (await dl('#dlJson')) > 100);
  check('download NDJSON non-empty', (await dl('#dlNdjson')) > 100);
  check('download XLSX non-empty', (await dl('#dlXlsx')) > 500);
  check('download star ZIP non-empty', (await dl('#dlStarZip')) > 300);
  check('download star XLSX non-empty', (await dl('#dlStarXlsx')) > 500);

  // --- #2 Quality tab ---
  await page.click('.tab-btn[data-tab="quality"]');
  await page.waitForSelector('#qualityBody:not([hidden]) table tbody tr', { timeout: 5000 });
  const repFields = await page.$$eval('#qualityBody table tbody tr', (tr) => tr.length);
  check('#2 quality report renders field rows', repFields > 5, 'rows=' + repFields);
  check('#2 quality shows distributions', (await page.$$('.dist')).length > 0);
  check('#2 report download enabled', !(await page.locator('#dlReportJson').isDisabled()));

  // --- #1 Compare tab ---
  await page.click('.tab-btn[data-tab="compare"]');
  await page.setInputFiles('#cmpFileA', SAMPLE);
  await page.setInputFiles('#cmpFileB', SAMPLE);
  await page.waitForSelector('#diffStats .stat', { timeout: 8000 });
  const diffStats = await page.textContent('#diffStats');
  check('#1 diff renders summary cards', /Added/.test(diffStats) && /Changed/.test(diffStats));
  // Same file vs itself: 0 added, 0 removed, 0 changed
  const unchangedCard = await page.$$eval('#diffStats .stat', (cards) => {
    const find = (k) => { const c = cards.find((x) => x.textContent.includes(k)); return c ? c.querySelector('.stat-val').textContent : null; };
    return { added: find('Added'), removed: find('Removed'), changed: find('Changed') };
  });
  check('#1 identical files => 0 added/removed/changed', unchangedCard.added === '0' && unchangedCard.removed === '0' && unchangedCard.changed === '0', JSON.stringify(unchangedCard));
  check('#1 diff downloads enabled', !(await page.locator('#dlDiffCsv').isDisabled()));

  // --- Changelog modal ---
  await page.click('#changelogBtn');
  await page.waitForSelector('#changelogModal:not([hidden]) .cl-entry', { timeout: 4000 });
  const versions = await page.$$eval('#changelogModal .cl-ver', (s) => s.map((x) => x.textContent));
  check('changelog: shows three releases', versions.join(',') === 'v1.2.0,v1.1.0,v1.0.0', versions.join(','));
  check('changelog: includes initial + this release', (await page.textContent('#changelogModal')).includes('Initial release') && (await page.textContent('#changelogModal')).includes('changelog modal'));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#changelogModal', { state: 'hidden', timeout: 3000 });
  check('changelog: closes on Escape', true);

  check('no console/page errors during session', errors.length === 0, errors.slice(0, 5).join(' || '));

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
