import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverWarriorsBatches, downloadWarriorsAndroid, isErinHunter, matchesWarriorsTitle, nextWarriorsOrderMove, normalizeWarriorsText, prioritizeCachedWarriorsCandidates, retainedWarriorsNativeJob, warriorsAliases, warriorsDiscoveryTargets, warriorsFolderAssignmentPlan, warriorsOrganizationOutsideFolder, warriorsTargetFolder, warriorsUnits } from '../scripts/download-warriors-android.mjs';

test('Russian aliases normalize typography and ё, while the author must be the full Erin Hunter name', () => {
  const record = { canonicalRussianTitle: 'Огонь и лёд', russianSearchTitles: ['Огонь и лед'], arc: { russian: 'Воители / Начало пророчеств' } };
  const unit = { queryTitles: ['Огонь и лёд'] };
  assert.equal(normalizeWarriorsText('  ОГОНЬ  и ЛЁД!  '), 'огонь и лед');
  for (const title of ['Огонь и лед', 'Коты—воители: Огонь и лёд', 'Огонь и лёд — Эрин Хантер', 'Начало пророчеств. Огонь и лёд']) assert.equal(matchesWarriorsTitle(title, unit, record), true, title);
  for (const author of ['Эрин Хантер', 'Хантер, Эрин', 'Erin Hunter', 'Hunter, Erin']) assert.equal(isErinHunter(author), true, author);
  for (const author of ['Хантер', 'Эрин', 'Роберт Хантер', 'Erin Hunter and another author']) assert.equal(isErinHunter(author), false, author);
  assert.equal(matchesWarriorsTitle('Огонь и лёд. Том 2', unit, record), false);
});

test('collection names are not silently shortened to one contained novella', () => {
  const collection = { canonicalRussianTitle: 'Нерассказанные истории. История Остролистой', russianSearchTitles: [] };
  assert.equal(matchesWarriorsTitle('Нерассказанные истории — История Остролистой', { queryTitles: [collection.canonicalRussianTitle] }, collection), true);
  assert.equal(matchesWarriorsTitle('История Остролистой', { queryTitles: [collection.canonicalRussianTitle] }, collection), false);
  assert.equal(matchesWarriorsTitle('Нерассказанные истории. История Остролистой', { queryTitles: ['История Остролистой'] }, { canonicalRussianTitle: 'История Остролистой' }), false);
});

test('reading plan keeps split Russian volumes distinct and does not invent a Russian query', () => {
  const list = { books: [{ id: 'part1', englishWorkKey: 'same', canonicalRussianTitle: 'Книга. Том 1' }, { id: 'part2', englishWorkKey: 'same', canonicalRussianTitle: 'Книга. Том 2' }, { id: 'en-only', canonicalRussianTitle: null, englishTitle: 'Untranslated' }], recommendedFirstReadOrder: [{ order: 1, bookId: 'part1', queryTitles: ['Книга. Том 1'] }, { order: 2, bookId: 'part2', queryTitles: ['Книга. Том 2'] }, { order: 3, bookId: 'en-only', queryTitles: [] }] };
  const units = warriorsUnits(list);
  assert.deepEqual(units.map(unit => unit.bookId), ['part1', 'part2', 'en-only']);
  assert.equal(matchesWarriorsTitle('Книга. Том 1', units[1], units[1].record), false);
  assert.deepEqual(warriorsAliases(units[2], units[2].record), []);
});

test('an explicit matching Russian volume marker can be removed, while wrong markers and missing subtitles remain distinct', async () => {
  const list = JSON.parse(await fs.readFile(new URL('../docs/gargantua/WARRIORS_READING_LIST.json', import.meta.url), 'utf8'));
  const first = list.books.find(book => book.id === 'wc-firestar-s-quest-ru-1'), second = list.books.find(book => book.id === 'wc-firestar-s-quest-ru-2');
  for (const [record, subtitle] of [[first, 'Искупление'], [second, 'Возрождение']]) {
    const unit = { queryTitles: record.russianSearchTitles }, own = record.readingGroup.order, other = own === 1 ? 2 : 1;
    for (const marker of ['Книга', 'Том', 'Часть']) {
      assert.equal(matchesWarriorsTitle(`Миссия Огнезвезда. ${marker} ${own}. ${subtitle}`, unit, record), true);
      assert.equal(matchesWarriorsTitle(`Коты-воители — Миссия Огнезвезда — ${marker} ${own}: ${subtitle}`, unit, record), true);
      assert.equal(matchesWarriorsTitle(`Миссия Огнезвезда. ${marker} ${other}. ${subtitle}`, unit, record), false, 'Wrong explicit volume must not be hidden');
      assert.equal(matchesWarriorsTitle(`Миссия Огнезвезда. ${marker} ${own}`, unit, record), false, 'Volume marker alone must not replace the meaningful subtitle');
    }
    assert.equal(matchesWarriorsTitle(`Миссия Огнезвёзда. ${subtitle}`, unit, record), true);
    assert.equal(matchesWarriorsTitle('Миссия Огнезвезда', unit, record), false);
  }
  assert.equal(matchesWarriorsTitle('Миссия Огнезвезда. Книга 2. Возрождение', { queryTitles: first.russianSearchTitles }, first), false);
  assert.equal(matchesWarriorsTitle('Миссия Огнезвезда. Книга 1. Искупление', { queryTitles: second.russianSearchTitles }, second), false);
  assert.equal(matchesWarriorsTitle('Огонь и лёд. Книга 1', { queryTitles: ['Огонь и лёд'] }, { canonicalRussianTitle: 'Огонь и лёд' }), false, 'Do not strip metadata markers without explicit readingGroup.order');
});

test('current bibliography exposes 116 queue units, 143 records and explicit novella fallbacks', async () => {
  const list = JSON.parse(await fs.readFile(new URL('../docs/gargantua/WARRIORS_READING_LIST.json', import.meta.url), 'utf8'));
  const units = warriorsUnits(list);
  assert.equal(list.books.length, 143); assert.equal(units.length, 116);
  assert.equal(warriorsUnits(list, 3).length, 3);
  assert.ok(units.some(unit => unit.fallbacks.length === 3));
  for (const unit of units) for (const fallback of unit.fallbacks) assert.equal(fallback.parentId, unit.bookId);
});

test('complete committed editions precede uncached duplicates while incomplete jobs and ties keep candidate order', () => {
  const first = { source: 'libcat', id: 'forest-56' }, second = { source: 'libcat', id: 'forest-99' }, third = { source: 'litlife', id: 'forest-28' }, fourth = { source: 'libcat', id: 'forest-other' };
  const candidates = [first, second, third, fourth];
  const jobs = [
    { book: first, status: 'paused', total: 56, downloaded: 40 },
    { book: second, status: 'complete', total: 99, downloaded: 99 },
    { book: third, status: 'complete', total: 28, downloaded: 27 },
    { book: fourth, status: 'complete', total: 0, downloaded: 0 },
  ];
  assert.deepEqual(prioritizeCachedWarriorsCandidates(candidates, jobs), [second, first, third, fourth]);
  assert.deepEqual(candidates, [first, second, third, fourth], 'Candidate input must not be mutated');
  assert.deepEqual(prioritizeCachedWarriorsCandidates(candidates, []), candidates);
});

test('complete native identity fallback supports persisted encoded job IDs', () => {
  const first = { source: 'libcat', id: '1' }, second = { source: 'litlife', id: '1' };
  const jobs = [{ id: encodeURIComponent(JSON.stringify(['litlife:1', ''])), status: 'complete', total: 8, downloaded: 8 }];
  assert.deepEqual(prioritizeCachedWarriorsCandidates([first, second], jobs), [second, first]);
});

test('discovery batches await assignment and queuing before further searches, including final short batch', async () => {
  const trace = [], selected = [], queued = new Set();
  await discoverWarriorsBatches([1, 2, 3, 4, 5], {
    batchSize: 2,
    discover: async unit => { trace.push('discover:' + unit); selected.push(unit); },
    afterBatch: async progress => {
      trace.push('assign:' + selected.join(','));
      await Promise.resolve();
      const fresh = selected.filter(unit => !queued.has(unit));
      trace.push('queue:' + fresh.join(',')); fresh.forEach(unit => queued.add(unit));
      assert.equal(progress.completedUnits, selected.length);
      assert.equal(progress.totalUnits, 5);
      assert.equal(progress.batchUnits, selected.length === 5 ? 1 : 2);
    },
  });
  assert.deepEqual(trace, ['discover:1', 'discover:2', 'assign:1,2', 'queue:1,2', 'discover:3', 'discover:4', 'assign:1,2,3,4', 'queue:3,4', 'discover:5', 'assign:1,2,3,4,5', 'queue:5']);
});

test('default discovery stays sequential without intermediate mutations and batch failure stops more searches', async () => {
  const trace = [];
  await discoverWarriorsBatches([1, 2, 3], { discover: async unit => { trace.push(unit); } });
  assert.deepEqual(trace, [1, 2, 3]);
  trace.length = 0;
  await assert.rejects(discoverWarriorsBatches([1, 2, 3], { batchSize: 2, discover: async unit => { trace.push(unit); }, afterBatch: async () => { throw Error('UI did not settle'); } }), /UI did not settle/u);
  assert.deepEqual(trace, [1, 2]);
});

test('invalid batch size is rejected before connecting to any device', async () => {
  for (const value of ['0', '-1', '1.5', 'NaN']) await assert.rejects(downloadWarriorsAndroid(['--plan', 'true', '--batch-size', value]), /batch-size must be a positive integer/u);
});

test('targeted discovery retains full inventory and respects parent versus directly requested fallback IDs', () => {
  const first = { bookId: 'collection', fallbacks: [{ bookId: 'novella-1', parentId: 'collection' }, { bookId: 'novella-2', parentId: 'collection' }] }, second = { bookId: 'volume-2', fallbacks: [] };
  const units = [first, second];
  assert.equal(warriorsDiscoveryTargets(units), units);
  assert.deepEqual(warriorsDiscoveryTargets(units, ['collection']), [first]);
  assert.deepEqual(warriorsDiscoveryTargets(units, ['novella-2']), [{ bookId: 'novella-2', parentId: 'collection', fallbacks: [] }]);
  assert.deepEqual(warriorsDiscoveryTargets(units, ['novella-2', 'collection']), [first], 'Requested parent keeps conditional fallback policy rather than double counting its novella');
  assert.deepEqual(warriorsDiscoveryTargets(units, ['volume-2', 'novella-1']).map(unit => unit.bookId), ['novella-1', 'volume-2'], 'Targets still follow bibliography order');
  assert.deepEqual(units, [first, second]);
});

test('unknown, empty or repeated discovery IDs and a conflicting limit are rejected before device access', async () => {
  for (const value of ['unknown-book', '', 'wc-into-the-wild,,wc-fire-and-ice', 'wc-into-the-wild,wc-into-the-wild']) await assert.rejects(downloadWarriorsAndroid(['--plan', 'true', '--discover-ids', value]), /discover-ids|Expected --option/u);
  await assert.rejects(downloadWarriorsAndroid(['--plan', 'true', '--discover-ids', 'wc-into-the-wild', '--limit', '3']), /do not combine it with --limit/u);
});

test('targeted real bibliography plan searches four IDs while order and summary keep all116 units', async () => {
  const ids = ['wc-bramblestar-s-storm-ru-13', 'wc-bramblestar-s-storm-ru-14', 'wc-moth-flight-s-vision-ru-15', 'wc-moth-flight-s-vision-ru-16'];
  const execute = promisify(execFile), script = fileURLToPath(new URL('../scripts/download-warriors-android.mjs', import.meta.url));
  const result = await execute(process.execPath, [script, '--plan', 'true', '--batch-size', '8', '--discover-ids', ids.join(',')]);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.selectedUnits, 116); assert.equal(plan.discoveryTargets, 4);
  assert.deepEqual(plan.discoveryTargetIds, ids);
  assert.equal(plan.discoveryScope, 'TARGETED_IDS_ONLY');
  assert.equal(plan.inventoryScope, 'FULL_READING_LIST_PERSISTED_SELECTIONS_NOT_ALL_RECHECKED_THIS_RUN');
});

test('native baseline retains active jobs and their retry deadline, while paused or failed work remains eligible for UI retry', () => {
  const edition = { source: 'libcat', id: 'same' }, waiting = { book: edition, status: 'waiting', total: 56, downloaded: 8, retryAt: 123456 };
  assert.equal(retainedWarriorsNativeJob([waiting], edition), waiting);
  for (const status of ['queued', 'downloading']) { const active = { ...waiting, status }; assert.equal(retainedWarriorsNativeJob([active], edition), active); }
  for (const status of ['paused', 'partial', 'error', 'cancelled']) assert.equal(retainedWarriorsNativeJob([{ ...waiting, status }], edition), undefined);
  const complete = { ...waiting, status: 'complete', downloaded: 56 };
  assert.equal(retainedWarriorsNativeJob([waiting, complete], edition), complete);
  assert.equal(retainedWarriorsNativeJob([waiting], { source: 'litlife', id: 'same' }), undefined);
});

test('catalogue tiles match the entire name and never reuse a renamed saved ID or a prefix', () => {
  const folders = [{ id: 'old', name: 'Личная папка' }, { id: 'series', name: 'Коты-воители — Эрин Хантер' }, { id: 'other', name: 'Коты-воители — Эрин Хантер — заметки' }];
  assert.equal(warriorsTargetFolder(folders, 'series', 'Коты-воители — Эрин Хантер'), folders[1]);
  assert.equal(warriorsTargetFolder(folders, 'old', '  КОТЫ-ВОИТЕЛИ — Эрин   Хантер '), folders[1]);
  assert.equal(warriorsTargetFolder(folders, 'old', 'Коты-воители'), null);
  assert.throws(() => warriorsTargetFolder([...folders, { id: 'duplicate', name: folders[1].name }], 'series', folders[1].name), /Multiple catalogues/u);
  assert.throws(() => warriorsTargetFolder(folders, null, ' '), /nonempty/u);
});

test('bulk Add plans only missing source/book references and exposes unrelated catalogue editions without removal', () => {
  const records = [{ selected: { source: 'libcat', id: '1' } }, { selected: { source: 'litlife', id: '1' } }, { selected: { source: 'libcat', id: '2' } }], keys = ['libcat:2', 'foreign:book', 'libcat:1'];
  assert.deepEqual(warriorsFolderAssignmentPlan(records, keys), { expected: ['libcat:1', 'litlife:1', 'libcat:2'], missing: ['litlife:1'], existing: ['libcat:1', 'libcat:2'], extras: ['foreign:book'] });
  assert.deepEqual(keys, ['libcat:2', 'foreign:book', 'libcat:1']);
  assert.deepEqual(warriorsFolderAssignmentPlan(records, ['libcat:1', 'litlife:1', 'libcat:2']).missing, [], 'A resumed batch must not select or add all existing references again');
  assert.throws(() => warriorsFolderAssignmentPlan([records[0], records[0]], []), /distinct/u);
  assert.throws(() => warriorsFolderAssignmentPlan(records, ['libcat:1', 'libcat:1']), /distinct/u);
  assert.throws(() => warriorsFolderAssignmentPlan([{ selected: null }], []), /selected edition/u);
});

test('manual order advances by one exact adjacent Up swap for every permutation without weakening identity checks', () => {
  const desired = ['libcat:1', 'litlife:1', 'libcat:2', 'litlife:2'];
  const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(rest => [value, ...rest])) : [[]];
  for (const original of permutations(desired)) {
    let actual = [...original], operations = 0;
    for (let move = nextWarriorsOrderMove(actual, desired); move; move = nextWarriorsOrderMove(actual, desired)) {
      const observed = [...actual]; nextWarriorsOrderMove(actual, desired);
      assert.deepEqual(actual, observed, 'Planning must not mutate the observed UI order');
      assert.equal(move.to, move.from - 1); assert(move.from > move.target);
      assert.equal(actual[move.from], move.key);
      assert.deepEqual(move.after.slice(0, move.target), desired.slice(0, move.target));
      const expected = [...actual]; [expected[move.to], expected[move.from]] = [expected[move.from], expected[move.to]];
      assert.deepEqual(move.after, expected); actual = move.after; operations++;
      assert(operations <= 6, 'Four books need at most six adjacent swaps');
    }
    assert.deepEqual(actual, desired);
  }
  assert.equal(nextWarriorsOrderMove(desired, desired), null);
  assert.throws(() => nextWarriorsOrderMove(['unexpected'], desired), /identities changed/u);
  assert.throws(() => nextWarriorsOrderMove(['libcat:1', 'libcat:1'], ['libcat:1', 'litlife:1']), /distinct/u);
});

test('the untouched organization projection catches global and neighbouring catalogue changes but permits target-only Add/order and navigation', () => {
  const before = { folders: [{ id: 'target', name: 'Серия' }, { id: 'old', name: 'Моя папка' }], order: ['a', 'b'], assignments: { a: 'old' }, folderReferences: { old: ['a'], target: ['b'] }, folderOrders: { target: ['b'], old: ['a'] }, view: 'home', selectedFolder: 'old' };
  const after = structuredClone(before); after.folderReferences.target.push('a'); after.folderOrders.target = ['a', 'b']; after.view = 'folder'; after.selectedFolder = 'target';
  const expected = warriorsOrganizationOutsideFolder(before, 'target');
  assert.deepEqual(warriorsOrganizationOutsideFolder(after, 'target'), expected);
  for (const mutate of [value => value.order.reverse(), value => value.folderReferences.old.push('b'), value => value.assignments.a = 'target', value => value.folderOrders.old.push('b'), value => value.folders[1].name = 'Переименовано']) {
    const changed = structuredClone(after); mutate(changed);
    assert.notDeepEqual(warriorsOrganizationOutsideFolder(changed, 'target'), expected);
  }
  assert.deepEqual(before.folderReferences.target, ['b'], 'Observation must not mutate original memberships');
});
