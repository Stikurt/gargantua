/** Warriors inventory through the installed Android UI only.
 * No install, server configuration, direct book API, native enqueue or storage writes.
 * The foreground DownloadService is deliberately left running after disconnect.
 *
 * node scripts/download-warriors-android.mjs --plan true
 * node scripts/download-warriors-android.mjs --serial YOUR_DEVICE --limit 3
 * node scripts/download-warriors-android.mjs --serial YOUR_DEVICE --resume true
 *   --sections discover,assign,queue --state .local/warriors-android/state.json
 * --batch-size 8 assigns and queues discovered books after every eight units,
 * while the native download service continues during the remaining searches.
 * --discover-ids ID1,ID2 retries only those discoveries while retaining the full
 * reading list for the folder, reading order and completion inventory (no --limit).
 * --limit counts bibliography queue units, not individual fallback novellas.
 * --sections discover|assign|queue also accepts comma-separated stages.
 * --home true presses Home after queuing; it never force-stops the application.
 * Missing/unreadable texts remain explicit inventory outcomes, not fake successes.
 * Raw reports and device details stay in .local and must not be published verbatim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export function normalizeWarriorsText(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
export function isErinHunter(value) {
  return ['эрин хантер', 'хантер эрин', 'erin hunter', 'hunter erin'].includes(normalizeWarriorsText(value));
}
export function warriorsAliases(unit, record) {
  return [...new Set([...(unit?.queryTitles || []), record?.canonicalRussianTitle, ...(record?.russianSearchTitles || [])].filter(value => typeof value === 'string' && /[а-яё]/iu.test(value)).map(value => value.trim()).filter(Boolean))];
}
export function matchesWarriorsTitle(title, unit, record) {
  const groupOrder = Number.isSafeInteger(record?.readingGroup?.order) && record.readingGroup.order > 0 ? record.readingGroup.order : null;
  const variants = value => {
    let normalized = normalizeWarriorsText(value);
    if (groupOrder !== null) {
      const marker = /(?:^|\s)(?:книга|том|часть)\s*([0-9]+)(?=\s|$)/gu;
      const markers = [...normalized.matchAll(marker)];
      // A source may insert an explicit Russian volume marker into an otherwise
      // exact title. Only this record's own volume number can be discarded.
      if (markers.some(match => Number(match[1]) !== groupOrder)) return new Set();
      normalized = normalized.replace(marker, ' ').replace(/\s+/gu, ' ').trim();
    }
    const result = new Set([normalized]);
    const wrappers = ['Коты-воители', 'Warrior Cats', 'Warriors', 'Эрин Хантер', 'Erin Hunter', ...(record?.arc?.russian?.split('/') || [])].map(normalizeWarriorsText).filter(Boolean).sort((a, b) => b.length - a.length);
    for (let pass = 0; pass < 3; pass++) for (const wrapper of wrappers) {
      if (normalized.startsWith(wrapper + ' ')) { normalized = normalized.slice(wrapper.length + 1); result.add(normalized); }
      if (normalized.endsWith(' ' + wrapper)) { normalized = normalized.slice(0, -wrapper.length - 1); result.add(normalized); }
    }
    return result;
  };
  const actual = variants(title);
  const canonical = groupOrder !== null && record?.canonicalRussianTitle ? [...variants(record.canonicalRussianTitle)] : [];
  return warriorsAliases(unit, record).some(alias => {
    const aliases = [...variants(alias)];
    // A common series-only alias (e.g. "Миссия Огнезвезда") cannot identify
    // either of its two Russian volumes without the meaningful subtitle.
    if (canonical.length && aliases.some(short => short && canonical.some(full => full.startsWith(short + ' ')))) return false;
    return aliases.some(value => value && actual.has(value));
  });
}
export function warriorsUnits(list, limit = Infinity) {
  assert(Array.isArray(list?.books) && Array.isArray(list?.recommendedFirstReadOrder), 'Reading list books/recommendedFirstReadOrder required');
  const records = new Map(list.books.map(record => [record.id, record]));
  return list.recommendedFirstReadOrder.slice(0, limit).map(unit => {
    assert(records.has(unit.bookId), 'Queue unit missing bibliography record: ' + unit.bookId);
    return { ...unit, record: records.get(unit.bookId), fallbacks: (unit.fallbackBookIds || []).map(id => { assert(records.has(id), 'Fallback missing: ' + id); return { bookId: id, title: records.get(id).canonicalRussianTitle || records.get(id).englishTitle, kind: records.get(id).kind, queryTitles: records.get(id).russianSearchTitles || [], record: records.get(id), parentId: unit.bookId, order: unit.order }; }) };
  });
}

/** A discovery filter never narrows the full selection/order inventory. */
export function warriorsDiscoveryTargets(units, requestedIds) {
  if (requestedIds === undefined) return units;
  assert(Array.isArray(requestedIds) && requestedIds.length > 0 && requestedIds.every(id => typeof id === 'string' && id.trim() === id && id.length > 0), '--discover-ids must contain nonempty comma-separated IDs');
  assert(new Set(requestedIds).size === requestedIds.length, '--discover-ids must not repeat IDs');
  const known = new Set(units.flatMap(unit => [unit.bookId, ...unit.fallbacks.map(fallback => fallback.bookId)]));
  assert(requestedIds.every(id => known.has(id)), 'Unknown --discover-ids: ' + requestedIds.filter(id => !known.has(id)).join(', '));
  const requested = new Set(requestedIds), targets = [];
  for (const unit of units) {
    // The full collection remains preferable when both parent and a contained
    // novella are requested. Its normal absent-parent fallback policy applies.
    if (requested.has(unit.bookId)) targets.push(unit);
    else for (const fallback of unit.fallbacks) if (requested.has(fallback.bookId)) targets.push({ ...fallback, fallbacks: [] });
  }
  return targets;
}

const editionKey = value => value.source + ':' + value.id;
function nativeJobIdentity(job) {
  if (job.book?.source && job.book?.id !== undefined) return editionKey(job.book);
  try { return JSON.parse(decodeURIComponent(job.id))[0]; } catch { return null; }
}
function completeNativeJob(job) { return job.status === 'complete' && job.total > 0 && job.downloaded === job.total; }

/** Prefer already committed complete editions without changing tie order. */
export function prioritizeCachedWarriorsCandidates(candidates, nativeJobs = []) {
  const complete = new Set(nativeJobs.filter(completeNativeJob).map(nativeJobIdentity));
  return [...candidates.filter(value => complete.has(editionKey(value))), ...candidates.filter(value => !complete.has(editionKey(value)))];
}

/** Preserve already active native work and its source retry deadline. */
export function retainedWarriorsNativeJob(nativeJobs, edition) {
  const matching = nativeJobs.filter(job => nativeJobIdentity(job) === editionKey(edition));
  return matching.find(completeNativeJob) || matching.find(job => ['queued', 'downloading', 'waiting'].includes(job.status) && job.total > 0);
}

/** Await UI discovery and each optional batch before starting more queries. */
export async function discoverWarriorsBatches(units, { batchSize, discover, afterBatch } = {}) {
  assert(Array.isArray(units) && typeof discover === 'function', 'Discovery units/callback required');
  assert(batchSize === undefined || Number.isSafeInteger(batchSize) && batchSize > 0, '--batch-size must be a positive integer');
  const size = batchSize ?? Math.max(1, units.length);
  for (const [index, unit] of units.entries()) {
    await discover(unit);
    if (afterBatch && ((index + 1) % size === 0 || index + 1 === units.length)) await afterBatch({ completedUnits: index + 1, totalUnits: units.length, batchUnits: (index % size) + 1 });
  }
}

/** Match only a catalogue's complete name, never a prefix or its book count. */
export function warriorsTargetFolder(folders, folderId, folderName) {
  const name = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru');
  assert(Array.isArray(folders) && name(folderName), 'Catalogue tiles and a nonempty folder name are required');
  const matching = folders.filter(folder => folder?.id && !['all', 'unfiled'].includes(folder.id) && name(folder.name) === name(folderName));
  assert(matching.length <= 1, 'Multiple catalogues have the requested name; do not choose one implicitly');
  return matching.find(folder => folder.id === folderId) || matching[0] || null;
}

/** A resumed batch adds only missing references; unrelated editions stay visible. */
export function warriorsFolderAssignmentPlan(records, currentKeys) {
  assert(Array.isArray(records) && Array.isArray(currentKeys), 'Selected records and actual catalogue keys are required');
  assert(records.every(record => record?.selected?.source && record.selected.id !== undefined && record.selected.id !== null), 'Every assignment needs a selected edition');
  const expected = records.map(record => editionKey(record.selected));
  assert(new Set(expected).size === expected.length, 'Selected editions must be distinct before assigning a catalogue');
  assert(currentKeys.every(value => typeof value === 'string' && value.length) && new Set(currentKeys).size === currentKeys.length, 'Actual catalogue keys must be distinct');
  const present = new Set(currentKeys), desired = new Set(expected);
  return { expected, missing: expected.filter(key => !present.has(key)), existing: expected.filter(key => present.has(key)), extras: currentKeys.filter(key => !desired.has(key)) };
}

/** One exact adjacent Up operation; callers await its entire expected result. */
export function nextWarriorsOrderMove(actual, expected) {
  assert(Array.isArray(actual) && Array.isArray(expected) && actual.every(value => typeof value === 'string' && value.length) && expected.every(value => typeof value === 'string' && value.length), 'Actual and expected order keys are required');
  assert(new Set(actual).size === actual.length && new Set(expected).size === expected.length, 'Order keys must be distinct');
  assert(actual.length === expected.length && expected.every(key => actual.includes(key)), 'Catalogue identities changed; do not reorder unexpected or missing books');
  const target = expected.findIndex((key, index) => actual[index] !== key);
  if (target < 0) return null;
  const key = expected[target], from = actual.indexOf(key), to = from - 1, after = [...actual];
  assert(from > target && to >= 0, 'The first unmatched book must move upwards');
  [after[to], after[from]] = [after[from], after[to]];
  return { key, from, to, target, after };
}

/** Ignore only the target's reference/order edits and the current UI location. */
export function warriorsOrganizationOutsideFolder(value, folderId) {
  const sorted = input => Array.isArray(input) ? input.map(sorted) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(input[key])])) : input;
  const otherFolders = map => Object.fromEntries(Object.entries(map || {}).filter(([id]) => id !== folderId));
  return sorted({ folders: value?.folders || [], order: value?.order || [], assignments: value?.assignments || {}, folderReferences: otherFolders(value?.folderReferences), folderOrders: otherFolders(value?.folderOrders) });
}

export async function downloadWarriorsAndroid(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index++) { assert(argv[index].startsWith('--') && argv[index + 1] && !argv[index + 1].startsWith('--'), 'Expected --option value'); args.set(argv[index].slice(2), argv[++index]); }
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url))), local = path.join(root, '.local') + path.sep;
  const readingFile = path.resolve(args.get('reading-list') || path.join(root, 'docs/gargantua/WARRIORS_READING_LIST.json'));
  const readingBytes = await fs.readFile(readingFile), reading = JSON.parse(readingBytes), limit = args.has('limit') ? Number(args.get('limit')) : Infinity;
  assert(limit === Infinity || Number.isSafeInteger(limit) && limit > 0, '--limit must be positive');
  assert(!args.has('discover-ids') || !args.has('limit'), '--discover-ids retains the full reading list; do not combine it with --limit');
  const units = warriorsUnits(reading, limit), sections = (args.get('sections') || 'discover,assign,queue').split(/[|,]/u);
  assert(sections.length && new Set(sections).size === sections.length && sections.every(value => ['discover', 'assign', 'queue'].includes(value)), 'Invalid sections');
  const batchSize = args.has('batch-size') ? Number(args.get('batch-size')) : undefined;
  assert(batchSize === undefined || Number.isSafeInteger(batchSize) && batchSize > 0, '--batch-size must be a positive integer');
  const requestedDiscoveryIds = args.has('discover-ids') ? args.get('discover-ids').split(',').map(id => id.trim()) : undefined;
  const discoveryTargets = warriorsDiscoveryTargets(units, requestedDiscoveryIds);
  const folderName = args.get('folder') || 'Коты-воители — Эрин Хантер';
  const plan = { scope: 'REAL_ANDROID_UI_WARRIORS_DISCOVERY_FOLDER_ORDER_QUEUE', bibliographyRecords: reading.books.length, recommendedUnits: reading.recommendedFirstReadOrder.length, selectedUnits: units.length, discoveryScope: requestedDiscoveryIds ? 'TARGETED_IDS_ONLY' : 'ALL_SELECTED_UNITS', requestedDiscoveryIds: requestedDiscoveryIds || null, discoveryTargetIds: discoveryTargets.map(unit => unit.bookId), discoveryTargets: discoveryTargets.length, inventoryScope: requestedDiscoveryIds ? 'FULL_READING_LIST_PERSISTED_SELECTIONS_NOT_ALL_RECHECKED_THIS_RUN' : 'SELECTED_READING_LIST_UNITS', sections, folderName, batchSize: batchSize ?? null, discoveryPolicy: 'Saved selections stay unchanged; otherwise prefer matching editions with a fully complete committed native job before other candidates.', batchingPolicy: batchSize ? 'Discover targets in batches, then assign all selected books and enqueue newly observed selections; finally verify complete selected order again.' : 'Discover all requested targets before assigning and queuing.', sources: ['libcat', 'litlife'], authorPolicy: 'Exact Erin Hunter full name (RU/EN, either order) plus exact meaningful Russian title; no englishWorkKey dedup of split Russian volumes.', collectionPolicy: 'Prefer full named collection; if absent try its fallback novellas without counting both.', libraryUi: '0.9 catalogue home/tiles; checkbox selection and one bulk Add dialog for missing references; separate order mode with exact adjacent-swap waits.', mutations: 'Visible UI search/save/catalogue creation/checkbox bulk Add/order/download buttons only. Never Move or remove existing references. Does not install/configure/clear/force-stop the application.', completionPolicy: 'Queue completion is not full-book download; native durable progress is reported separately.' };
  if (args.get('plan') === 'true') { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return plan; }
  const serial = args.get('serial'); assert(serial, 'Pass --serial explicitly; no phone is selected implicitly.');
  const timeout = Number(args.get('timeout') || 120000), delayMs = Number(args.get('delay') || 500);
  assert(Number.isSafeInteger(timeout) && timeout >= 10000 && timeout <= 300000 && Number.isSafeInteger(delayMs) && delayMs >= 100, 'Invalid timeout/delay');
  const stateFile = path.resolve(args.get('state') || path.join(root, '.local/warriors-android/state.json'));
  const output = path.resolve(args.get('output') || path.join(root, '.local/test-results', 'warriors-android-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID().slice(0, 8)));
  assert(stateFile.startsWith(local) && output.startsWith(local), 'State and raw reports must stay inside workspace .local.');
  const digest = value => createHash('sha256').update(value).digest('hex'), bibliographySha256 = digest(readingBytes);
  let state;
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); assert(args.get('resume') === 'true', 'State exists: pass --resume true or another --state path'); assert(state.schemaVersion === 1, 'Unknown state format'); } catch (error) { if (error.code !== 'ENOENT') throw error; assert(args.get('resume') !== 'true' || !sections.some(value => value !== 'discover'), 'No saved inventory for assign/queue resume'); state = { schemaVersion: 1, createdAt: new Date().toISOString(), folderName, folderId: null, records: {} }; }
  state.bibliographySha256 = bibliographySha256; state.folderName = folderName;
  await fs.mkdir(path.dirname(stateFile), { recursive: true }); await fs.mkdir(output, { recursive: false });
  const execute = promisify(execFile), pkg = 'local.gargantua.mvp.debug', activity = pkg + '/local.gargantua.mvp.MainActivity';
  const report = { schemaVersion: 1, ...plan, serial, package: pkg, startedAt: new Date().toISOString(), bibliographySha256, readingFile, stateFile, directBookApiCalls: 0, storageWritesByScript: 0, nativeEnqueueCallsByScript: 0, fixture: false, checks: [], events: [], pageErrors: [], console: [], discoveryVisitedIds: [], selections: [], downloadsComplete: false };
  let browser, page, port;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function adb(...command) { return (await execute('adb', ['-s', serial, ...command], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000, encoding: 'utf8' })).stdout.trim(); }
  async function until(label, read, wait = timeout) { const end = Date.now() + wait; let error; while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (caught) { if (caught.stopInventory) throw caught; error = caught; } await sleep(150); } throw Error(label + (error ? ': ' + error.message : '')); }
  function check(name, ok, detail) { report.checks.push({ name, ok: Boolean(ok), detail }); assert(ok, name); }
  async function checkpoint() { state.updatedAt = new Date().toISOString(); const temp = stateFile + '.partial'; await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n'); await fs.rename(temp, stateFile); }
  function event(name, detail) { report.events.push({ at: new Date().toISOString(), name, ...detail }); process.stdout.write(JSON.stringify({ event: name, ...detail }) + '\n'); }
  const bookKey = editionKey;
  const card = (kind, value) => page.locator(`[data-testid="${kind}"][data-source=${JSON.stringify(value.source)}][data-book-id=${JSON.stringify(String(value.id))}]`);
  const entry = value => page.locator(`[data-testid="library-book-entry"][data-book-key=${JSON.stringify(bookKey(value))}]`);
  async function closeOverlays() {
    for (const name of ['library-action-close', 'close-download-panel', 'library-folder-close', 'close-reader', 'close-book']) if (await page.getByTestId(name).isVisible().catch(() => false)) { await page.getByTestId(name).click(); await page.getByTestId(name).waitFor({ state: 'hidden' }); }
  }
  // Existing IndexedDB is observed in a read-only transaction; all catalogue
  // mutations below still go through the visible client controls.
  async function organization() { return page.evaluate(() => new Promise((resolve, reject) => { const open = indexedDB.open('gargantua-mvp'); open.onupgradeneeded = () => { open.transaction.abort(); reject(Error('Existing library database required')); }; open.onerror = () => reject(Error('Cannot observe catalogue organization')); open.onsuccess = () => { const db = open.result; let transaction; try { transaction = db.transaction('items', 'readonly'); } catch (error) { db.close(); reject(error); return; } const request = transaction.objectStore('items').get('library:organization:v1'); request.onsuccess = () => resolve(request.result || { view: 'home', selectedFolder: 'all', folders: [] }); request.onerror = () => reject(Error('Cannot read catalogue organization')); transaction.oncomplete = () => db.close(); transaction.onabort = () => { db.close(); reject(Error('Read-only organization observation aborted')); }; }; })); }
  async function settled() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
  async function finishLibraryTools() { const done = page.getByTestId('library-mode-done'); if (await done.isVisible().catch(() => false)) { await done.click(); await done.waitFor({ state: 'hidden' }); } const menu = page.getByTestId('library-menu-toggle'); if (await menu.count() && await menu.getAttribute('aria-expanded') === 'true') await menu.click(); }
  async function libraryReady() { await until('Library has not restored its persisted view', async () => await page.getByTestId('library-catalogs-tab').isEnabled() && (await page.getByTestId('library-folder-grid').count() === 1 || await page.getByTestId('library-search-input').isVisible())); }
  async function catalogueHome() { await libraryReady(); await finishLibraryTools(); if (!await page.getByTestId('library-home').isVisible().catch(() => false)) await page.getByTestId('library-catalogs-tab').click(); await until('Catalogue home did not settle', async () => await page.getByTestId('library-home').isVisible() && await page.getByTestId('library-folder-grid').count() === 1 && await page.getByTestId('library-folder-create').isEnabled() && (await organization()).view === 'home'); await settled(); }
  async function selectFolder(id) {
    await libraryReady(); await finishLibraryTools();
    if (id === 'all') await page.getByTestId('library-all-books').click();
    else { await catalogueHome(); if (id === 'unfiled') await page.getByTestId('library-unfiled-books').click(); else await page.locator(`[data-testid="library-folder-tile"][data-folder-id=${JSON.stringify(id)}]`).click(); }
    await until('Catalogue selection did not settle: ' + id, async () => { const value = await organization(), entries = page.getByTestId('library-book-entry'); return value.view === 'folder' && value.selectedFolder === id && await page.getByTestId('library-search-input').isVisible() && await page.getByTestId('library-menu-toggle').isEnabled() && (!await entries.count() || await entries.first().getAttribute('data-folder-id') === id); });
    await settled();
  }
  async function library(id = 'all') { await closeOverlays(); await page.getByTestId('library-tab').click(); await page.getByTestId('library-all-books').waitFor(); await selectFolder(id); const filter = page.getByTestId('library-search-input'); if (await filter.inputValue()) await filter.fill(''); await settled(); }
  async function scanLibrary() { await library(); return page.getByTestId('library-book').evaluateAll(nodes => nodes.map(node => ({ source: node.dataset.source, id: node.dataset.bookId, title: node.querySelector('h3')?.textContent?.trim() || '', author: node.querySelector('.mvp-card-author')?.textContent?.trim() || '' }))); }
  async function openCard(value, fromLibrary) {
    if (fromLibrary) { await library(); await card('library-book', value).getByTestId('open-library-book').click(); }
    else await card('book-card', value).getByTestId('open-book').click();
    const dialog = page.getByRole('dialog', { name: 'Карточка книги' }); await dialog.waitFor(); await until('Book description/outline did not settle', async () => await dialog.locator('.mvp-loading').count() === 0); return dialog;
  }
  async function inspectCandidate(value, unit, fromLibrary) {
    const dialog = await openCard(value, fromLibrary), title = (await dialog.getByTestId('book-title').innerText()).trim(), author = (await dialog.getByTestId('book-author').innerText()).trim();
    if (!isErinHunter(author) || !matchesWarriorsTitle(title, unit, unit.record)) return { ok: false, reason: 'detail_identity_mismatch', title, author };
    const outline = await dialog.getByTestId('chapter-button').evaluateAll(nodes => nodes.map(node => ({ title: node.textContent.trim(), available: !node.disabled })));
    const countText = await dialog.locator('.mvp-detail-chapters .mvp-section-heading').innerText(), total = Number(countText.match(/(\d+)\s+раздел/u)?.[1] || outline.length);
    if (!total || !outline.some(value => value.available) || !await dialog.getByTestId('read-book').isEnabled()) return { ok: false, reason: 'not_readable', title, author, outlineTotal: total, notices: (await dialog.locator('.mvp-notice').allInnerTexts()).map(text => text.slice(0, 1000)) };
    const fullCollectionName = unit.record.canonicalRussianTitle && matchesWarriorsTitle(title, { queryTitles: [unit.record.canonicalRussianTitle] }, { ...unit.record, russianSearchTitles: [] });
    if (unit.fallbacks?.length && !fullCollectionName) {
      const body = normalizeWarriorsText(await dialog.innerText());
      const contents = unit.fallbacks.map(item => warriorsAliases(item, item.record).some(alias => body.includes(normalizeWarriorsText(alias))));
      if (!contents.every(Boolean)) return { ok: false, reason: 'collection_contents_not_proven', title, author, outlineTotal: total };
    }
    if (await dialog.getByTestId('save-book').isEnabled()) await dialog.getByTestId('save-book').click();
    await until('Book was not saved through visible UI', async () => await dialog.getByTestId('save-book').isDisabled() && /В библиотеке/u.test(await dialog.getByTestId('save-book').innerText()));
    return { ok: true, selected: { source: value.source, id: String(value.id), title, author, outlineTotal: total, readable: 'nonempty_outline_read_button_enabled', textVerified: false, fromExistingLibrary: fromLibrary } };
  }
  async function search(query, source) {
    await closeOverlays(); await page.getByTestId('search-tab').click(); await page.getByTestId('source-filter').selectOption(source); await page.getByTestId('search-input').fill(query); await page.getByTestId('search-submit').click();
    await until('Search did not finish', async () => await page.getByTestId('search-submit').isEnabled() && (await page.getByTestId('search-submit').innerText()).trim() === 'Найти');
    const items = await page.getByTestId('book-card').evaluateAll(nodes => nodes.map(node => ({ source: node.dataset.source, id: node.dataset.bookId, title: node.querySelector('h3')?.textContent?.trim() || '', author: node.querySelector('.mvp-card-author')?.textContent?.trim() || '' })));
    const notices = (await page.locator('.mvp-notice.error').allInnerTexts()).map(text => text.slice(0, 1500));
    await sleep(delayMs);
    return { items, notices, outcome: notices.length ? 'source_error' : items.length ? 'results' : 'empty_result' };
  }
  async function nativeSnapshot(label) {
    try { const value = JSON.parse(await adb('shell', 'run-as', pkg, 'cat', 'files/download-progress.json')); await fs.writeFile(path.join(output, label + '-native-progress.json'), JSON.stringify(value, null, 2) + '\n'); return value; }
    catch (error) { event('native_progress_unavailable', { label, error: error.message.slice(0, 300) }); return null; }
  }
  function jobs(snapshot) { return Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot?.jobs) ? snapshot.jobs : []; }
  const jobIdentity = nativeJobIdentity;
  let knownLibrary = [], used = new Map();
  async function discover(unit) {
    report.discoveryVisitedIds.push(unit.bookId);
    const previous = state.records[unit.bookId];
    if (previous?.selected && knownLibrary.some(value => bookKey(value) === bookKey(previous.selected) && isErinHunter(value.author) && matchesWarriorsTitle(value.title, unit, unit.record))) { used.set(bookKey(previous.selected), unit.bookId); event('reuse_saved_selection', { bookId: unit.bookId, title: previous.selected.title }); return previous; }
    const record = state.records[unit.bookId] = { bookId: unit.bookId, title: unit.title, kind: unit.kind, order: unit.order, parentId: unit.parentId || null, queries: warriorsAliases(unit, unit.record), attempts: previous?.attempts || [], selected: null, status: 'pending' };
    const available = value => !used.has(bookKey(value)) || used.get(bookKey(value)) === unit.bookId;
    const existing = prioritizeCachedWarriorsCandidates(knownLibrary.filter(value => available(value) && isErinHunter(value.author) && matchesWarriorsTitle(value.title, unit, unit.record)), jobs(report.nativeBefore));
    for (const value of existing) {
      const result = await inspectCandidate(value, unit, true).catch(error => { if (page.isClosed()) throw error; return { ok: false, reason: 'source_or_ui_error', error: error.message }; }); record.attempts.push({ type: 'existing_library', candidate: value, ...result });
      if (result.ok) { record.selected = result.selected; record.status = 'selected_existing'; used.set(bookKey(value), unit.bookId); await checkpoint(); return record; }
      await closeOverlays();
    }
    if (!record.queries.length) { record.status = 'no_confirmed_russian_query'; await checkpoint(); event('no_russian_title', { bookId: unit.bookId, title: unit.title }); return record; }
    let networkErrors = 0, unreadable = 0;
    for (const source of ['libcat', 'litlife']) for (const query of record.queries) {
      const result = await search(query, source).catch(error => { if (page.isClosed()) throw error; return { items: [], notices: [error.message], outcome: 'source_error' }; }), candidates = prioritizeCachedWarriorsCandidates(result.items.filter(value => available(value) && isErinHunter(value.author) && matchesWarriorsTitle(value.title, unit, unit.record)), jobs(report.nativeBefore));
      const attempt = { type: 'ui_search', source, query, outcome: result.outcome, resultCount: result.items.length, notices: result.notices, matchingCandidates: candidates, rejectedAuthorsOrTitles: result.items.filter(value => !candidates.includes(value)).slice(0, 12) }; record.attempts.push(attempt); if (result.outcome === 'source_error') networkErrors++;
      for (const value of candidates) {
        const inspected = await inspectCandidate(value, unit, false).catch(error => { if (page.isClosed()) throw error; return { ok: false, reason: 'source_or_ui_error', error: error.message }; }); (attempt.inspections ||= []).push(inspected);
        if (inspected.ok) { record.selected = inspected.selected; record.status = 'selected_new'; used.set(bookKey(value), unit.bookId); knownLibrary.push({ ...value }); await checkpoint(); event('selected', { bookId: unit.bookId, title: value.title, source, id: value.id }); return record; }
        unreadable++; await closeOverlays();
        // A closed dialog leaves the same real search result list available.
      }
      await checkpoint();
    }
    record.status = unreadable ? 'matching_edition_not_readable' : networkErrors ? 'unresolved_source_errors' : 'not_found'; await checkpoint(); event('unavailable', { bookId: unit.bookId, title: unit.title, status: record.status }); return record;
  }
  function selections() {
    const result = [], seen = new Set();
    for (const unit of units) {
      const chosen = state.records[unit.bookId]?.selected ? [state.records[unit.bookId]] : unit.fallbacks.map(value => state.records[value.bookId]).filter(value => value?.selected);
      for (const record of chosen) { const key = bookKey(record.selected); if (seen.has(key)) { event('duplicate_edition_excluded', { bookId: record.bookId, key }); continue; } seen.add(key); result.push(record); }
    }
    return result;
  }
  async function ensureFolder() {
    await library(); await catalogueHome(); const tiles = await page.getByTestId('library-folder-tile').evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.folderId, name: node.querySelector('strong')?.textContent.trim() || '' })));
    const current = warriorsTargetFolder(tiles, state.folderId, folderName);
    if (current) state.folderId = current.id;
    else { await page.getByTestId('library-folder-create').click(); await page.getByTestId('library-folder-name').fill(folderName); await page.getByTestId('library-folder-save').click(); await page.getByTestId('library-folder-dialog').waitFor({ state: 'hidden' }); state.folderId = await until('Created series catalogue has not committed', async () => { const value = await organization(), folder = warriorsTargetFolder(value.folders, null, folderName); return value.view === 'folder' && folder && value.selectedFolder === folder.id ? folder.id : false; }); }
    await checkpoint(); return state.folderId;
  }
  async function organizing() { await finishLibraryTools(); await page.getByTestId('library-order-toggle').click(); await page.getByTestId('library-order-list').waitFor({ state: 'visible' }); }
  async function visibleOrder() { return page.getByTestId('library-book-entry').evaluateAll(nodes => nodes.map(node => node.dataset.bookKey)); }
  async function assign(records) {
    const folder = await ensureFolder(); await library(folder); const assignment = warriorsFolderAssignmentPlan(records, await visibleOrder()), expected = assignment.expected, untouchedBefore = warriorsOrganizationOutsideFolder(await organization(), folder);
    if (assignment.extras.length) { report.folder = { id: folder, expected, actual: await visibleOrder(), extras: assignment.extras, exact: false }; throw Error('Target folder already contains unselected editions. No references were added or removed. Inspect local report or choose --folder NEW_NAME.'); }
    if (assignment.missing.length) {
      await library(); await page.getByTestId('library-select-toggle').click();
      const missing = new Set(assignment.missing);
      for (const record of records.filter(value => missing.has(bookKey(value.selected)))) {
        const checkbox = entry(record.selected).getByTestId('library-book-select'); await checkbox.waitFor({ state: 'visible' });
        assert(await checkbox.getAttribute('aria-checked') === 'false', 'Fresh selection mode must start with no selected books');
        await checkbox.click(); await until('Intended book checkbox was not selected', async () => await checkbox.getAttribute('aria-checked') === 'true');
      }
      await page.getByTestId('library-bulk-add').click(); const dialog = page.getByTestId('library-action-dialog'); await dialog.waitFor({ state: 'visible' });
      assert(await dialog.getAttribute('data-action') === 'add', 'Assignment must use reference-preserving Add, never Move');
      await dialog.getByTestId('library-action-folder').selectOption(folder); await dialog.getByTestId('library-action-apply').click();
      await dialog.waitFor({ state: 'hidden' }); await page.getByTestId('library-mode-done').waitFor({ state: 'hidden' });
    }
    await library(folder); await until('Bulk Add membership did not settle', async () => { const next = warriorsFolderAssignmentPlan(records, await visibleOrder()); return !next.missing.length && !next.extras.length; });
    for (const record of records) record.assigned = { folderId: folder, at: new Date().toISOString(), preservesOtherFolders: true };
    await checkpoint(); (report.assignmentBatches ||= []).push({ folderId: folder, addedBookKeys: assignment.missing, alreadyIncludedBookKeys: assignment.existing, action: assignment.missing.length ? 'one_visible_bulk_add_dialog' : 'already_present_no_add_dialog', at: new Date().toISOString() });
    await organizing();
    for (let move = nextWarriorsOrderMove(await visibleOrder(), expected); move; move = nextWarriorsOrderMove(await visibleOrder(), expected)) {
      const value = records.find(record => bookKey(record.selected) === move.key).selected, up = entry(value).getByTestId('library-book-up');
      assert(await up.isEnabled(), 'Expected adjacent Up control must be enabled'); await up.click();
      await until('Exact adjacent manual order change did not settle', async () => JSON.stringify(await visibleOrder()) === JSON.stringify(move.after));
    }
    await page.getByTestId('library-mode-done').click(); await page.getByTestId('library-mode-done').waitFor({ state: 'hidden' });
    const final = await visibleOrder(); check('Folder exactly follows selected bibliography reading order', JSON.stringify(final) === JSON.stringify(expected), { expected, actual: final });
    check('Bulk Add and catalogue ordering preserve every other membership, catalogue and global order', JSON.stringify(warriorsOrganizationOutsideFolder(await organization(), folder)) === JSON.stringify(untouchedBefore));
    report.folder = { id: folder, name: folderName, expected, actual: final, exact: true }; await page.screenshot({ path: path.join(output, 'reading-order-folder.png'), timeout: 5000, animations: 'disabled' });
  }
  const queueAttemptsThisRun = new Set();
  async function queue(records) {
    for (const record of records) {
      const selectedKey = bookKey(record.selected);
      if (queueAttemptsThisRun.has(selectedKey)) continue;
      queueAttemptsThisRun.add(selectedKey);
      try {
        const retained = retainedWarriorsNativeJob(jobs(report.nativeBefore), record.selected);
        if (retained) { record.queue = { status: retained.status, downloaded: retained.downloaded, total: retained.total, failed: retained.failed || 0, unavailable: retained.unavailable || 0, retryAt: retained.retryAt || null, at: new Date().toISOString(), action: completeNativeJob(retained) ? 'already_complete_committed_native_baseline' : 'already_active_committed_native_baseline' }; await checkpoint(); continue; }
        const dialog = await openCard(record.selected, true);
        if (!await dialog.getByTestId('download-book').isEnabled()) { record.queue = { status: 'not_downloadable', at: new Date().toISOString() }; await checkpoint(); continue; }
        await dialog.getByTestId('download-book').click(); await page.getByTestId('download-panel').waitFor();
        const job = page.locator(`[data-testid="download-job"][data-source=${JSON.stringify(record.selected.source)}][data-book-id=${JSON.stringify(record.selected.id)}]`);
        await until('Download row did not appear after visible download button', async () => await job.count() === 1 || (await page.getByTestId('download-panel').innerText()).includes('Не удалось'));
        if (!await job.count()) throw Error((await page.getByTestId('download-panel').innerText()).slice(-1800));
        const resume = job.getByTestId('download-resume'); if (await resume.isVisible().catch(() => false)) { await resume.click(); await until('Resume button did not apply', async () => ['queued', 'downloading', 'waiting', 'complete', 'partial', 'error'].includes(await job.getAttribute('data-status'))); }
        record.queue = { status: await job.getAttribute('data-status'), downloaded: Number(await job.getAttribute('data-downloaded')), total: Number(await job.getAttribute('data-total')), failed: Number(await job.getAttribute('data-failed')), unavailable: Number(await job.getAttribute('data-unavailable')), at: new Date().toISOString(), action: 'visible_download_book_button' };
        if (await job.getByTestId('download-error').isVisible().catch(() => false)) record.queue.error = await job.getByTestId('download-error').innerText();
        event('queue_observed', { bookId: record.bookId, title: record.selected.title, ...record.queue }); await checkpoint();
      } catch (error) { record.queue = { status: 'ui_queue_error', error: error.message, at: new Date().toISOString() }; await checkpoint(); event('queue_error', { bookId: record.bookId, error: error.message.slice(0, 400) }); if (page.isClosed()) throw error; }
    }
  }
  try {
    check('Explicit physical phone is authorized', await adb('get-state') === 'device');
    const installed = await adb('shell', 'pm', 'path', pkg); check('Existing Gargantua APK is installed', installed.startsWith('package:'));
    await adb('shell', 'am', 'start', '-n', activity);
    const pid = await until('Installed APK process missing', () => adb('shell', 'pidof', pkg), 15000);
    await until('Installed WebView debugging socket missing', async () => (await adb('shell', 'cat', '/proc/net/unix')).includes('webview_devtools_remote_' + pid), 20000);
    const listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); }); port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    await adb('forward', 'tcp:' + port, 'localabstract:webview_devtools_remote_' + pid);
    const require = createRequire(import.meta.url), candidates = [args.get('playwright'), process.env.PLAYWRIGHT_MODULE_PATH, 'playwright'].filter(Boolean), runtime = path.join(process.env.LOCALAPPDATA || '', 'OpenAI/Codex/runtimes/cua_node');
    try { for (const folder of await fs.readdir(runtime, { withFileTypes: true })) if (folder.isDirectory()) candidates.push(path.join(runtime, folder.name, 'bin/node_modules/playwright')); } catch {}
    let playwright; for (const candidate of candidates) { try { const value = require(candidate); if (value.chromium) { playwright = value; break; } } catch {} } assert(playwright, 'Install Playwright or pass --playwright MODULE_PATH');
    browser = await playwright.chromium.connectOverCDP('http://127.0.0.1:' + port); page = await until('Bundled Android renderer missing', () => browser.contexts().flatMap(context => context.pages()).find(value => value.url().startsWith('https://appassets.androidplatform.net/'))); page.setDefaultTimeout(timeout);
    page.on('pageerror', error => report.pageErrors.push(error.message)); page.on('console', message => { if (message.type() === 'error') report.console.push(message.text().slice(0, 1500)); });
    const connection = await page.evaluate(() => window.gargantua.getServer()); check('Keeps an already configured normal server connection', connection.configured && !connection.offline, { configured: connection.configured, offline: connection.offline });
    report.nativeBefore = await nativeSnapshot('before'); knownLibrary = await scanLibrary(); report.initialLibrary = knownLibrary;
    used = new Map(Object.values(state.records).filter(value => value.selected).map(value => [bookKey(value.selected), value.bookId]));
    if (sections.includes('discover')) await discoverWarriorsBatches(discoveryTargets, {
      batchSize,
      discover: async unit => { const preferred = await discover(unit); if (!preferred.selected && unit.fallbacks.length) for (const fallback of unit.fallbacks) await discover(fallback); },
      afterBatch: batchSize ? async progress => {
        // Include earlier saved selections as well, so a resumed batch never
        // treats later already-assigned books as unexpected folder contents.
        const selected = selections();
        if (sections.includes('assign') && selected.length) await assign(selected);
        if (sections.includes('queue') && selected.length) await queue(selected);
        const summary = { ...progress, discoveryScope: report.discoveryScope, inventoryUnits: units.length, selectedEditions: selected.length, queueAttempts: queueAttemptsThisRun.size, completedAt: new Date().toISOString() };
        (report.batches ||= []).push(summary); await checkpoint(); event('batch_processed', summary);
      } : undefined,
    });
    const selected = selections(); assert(selected.length || sections.includes('discover'), 'No saved selected editions. Run discover first.');
    if (sections.includes('assign') && selected.length) await assign(selected);
    if (sections.includes('queue') && selected.length) await queue(selected);
    report.nativeAfter = await nativeSnapshot('after'); const observed = jobs(report.nativeAfter); report.selections = selected.map(record => ({ bookId: record.bookId, parentId: record.parentId, title: record.selected.title, selected: record.selected, assigned: record.assigned, queue: record.queue, native: observed.filter(job => jobIdentity(job) === bookKey(record.selected)).map(job => ({ id: job.id, status: job.status, downloaded: job.downloaded, total: job.total, failed: job.failed, unavailable: job.unavailable })) }));
    const inScope = new Set(units.flatMap(unit => [unit.bookId, ...unit.fallbacks.map(item => item.bookId)]));
    report.inventory = { plannedUnits: units.length, discoveryTargetsPlanned: discoveryTargets.length, discoveryRecordIdsVisitedThisRun: [...new Set(report.discoveryVisitedIds)], allParentUnitsVisitedThisRun: units.every(unit => report.discoveryVisitedIds.includes(unit.bookId)), selectedEditions: selected.length, unavailable: Object.values(state.records).filter(record => inScope.has(record.bookId) && !record.selected).map(record => ({ bookId: record.bookId, title: record.title, status: record.status })), fullyDownloadedSelectedBooks: report.selections.filter(record => record.native.some(job => job.status === 'complete' && job.downloaded === job.total && job.total > 0)).length };
    report.inventory.representedUnits = units.filter(unit => state.records[unit.bookId]?.selected || unit.fallbacks.length > 0 && unit.fallbacks.every(fallback => state.records[fallback.bookId]?.selected)).length;
    report.selectedDownloadsComplete = selected.length > 0 && report.inventory.fullyDownloadedSelectedBooks === selected.length;
    report.downloadsComplete = report.selectedDownloadsComplete && report.inventory.representedUnits === units.length;
    check('No unhandled renderer exceptions', report.pageErrors.length === 0, report.pageErrors);
    if (args.get('home') === 'true') { await adb('shell', 'input', 'keyevent', '3'); report.leftOnHome = true; }
    report.serviceAfter = await adb('shell', 'dumpsys', 'activity', 'services', pkg); report.appForceStopped = false; report.ok = true; await checkpoint();
  } catch (error) { report.ok = false; report.error = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {}); process.exitCode = 1; }
  finally {
    // For connectOverCDP, close disconnects this automation connection. No app
    // process is killed, no queue is paused/cancelled and no cache is cleared.
    await browser?.close().catch(() => {}); if (port) await adb('forward', '--remove', 'tcp:' + port).catch(() => {});
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); process.stdout.write(JSON.stringify({ ok: report.ok, selected: report.inventory?.selectedEditions, fullyDownloadedSelectedBooks: report.inventory?.fullyDownloadedSelectedBooks, downloadsComplete: report.downloadsComplete, state: stateFile, report: path.join(output, 'report.json'), error: report.error?.message }) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await downloadWarriorsAndroid();
