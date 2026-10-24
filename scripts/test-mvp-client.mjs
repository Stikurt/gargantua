/** Live acceptance of the packaged Windows client. No source fixture or server API bypass. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (!key.startsWith('--') || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`Expected --option value: ${key}`);
  args.set(key.slice(2), process.argv[++i]);
}
const executable = path.resolve(args.get('exe') || path.join(root, 'releases/Gargantua-MVP/Gargantua.exe'));
const output = path.resolve(args.get('output') || path.join(root, '.local/test-results', `mvp-client-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`));
const regression = args.get('regression');
const regressionCases = {
  'gutenberg:36098': {source: 'gutenberg', id: '36098', title: 'The Flowers of Evil', host: 'www.gutenberg.org', sourcePath: '/ebooks/36098'},
  'ranobelib:111229--preference-for-the-possessed': {source: 'ranobelib', id: '111229--preference-for-the-possessed', title: 'Привилегия попаданки', host: 'ranobelib.me', sourcePath: '/ru/book/111229--preference-for-the-possessed'},
  'ranobelib:112902--kizokuin-gaiden-ichi-nensei': {source: 'ranobelib', id: '112902--kizokuin-gaiden-ichi-nensei', title: 'Истории дворянской академии. Власть книжного червя (Новелла)', host: 'ranobelib.me', sourcePath: '/ru/book/112902--kizokuin-gaiden-ichi-nensei'}
};
if (regression) assert(Object.hasOwn(regressionCases, regression), 'Unknown previously failing source regression');
const regressionSpec = regressionCases[regression];
const sources = (regression ? regressionSpec.source : args.get('sources') || 'ranobelib,gutenberg').split(',');
assert(sources.length && sources.every(source => ['ranobelib', 'gutenberg', 'wikisource'].includes(source)), 'Invalid source list');
assert.equal(new Set(sources).size, sources.length, 'Duplicate sources');
const timeout = Number(args.get('timeout') || 120000);
assert(Number.isSafeInteger(timeout) && timeout >= 10000 && timeout <= 300000, 'Invalid timeout');
await fs.access(executable);
await fs.mkdir(path.dirname(output), {recursive: true});
await fs.mkdir(output, {recursive: false});
const profile = path.join(output, 'profile');
const report = {
  schemaVersion: 1,
  scope: regression ? 'PACKAGED_WINDOWS_EXE_LIVE_REGRESSION_PREVIOUSLY_FAILING_SOURCE_IDENTITY' : 'PACKAGED_WINDOWS_EXE_UI_TO_LIVE_CATALOG_SEARCH_CHAPTER_LIBRARY_COLD_RESTART_OFFLINE',
  ...(regression ? {regression} : {}),
  fixture: false,
  startedAt: new Date().toISOString(),
  executable,
  executableSha256: createHash('sha256').update(await fs.readFile(executable)).digest('hex'),
  profile,
  sources,
  books: [],
  skippedFrontMatter: [],
  checks: [],
  screenshots: [],
  layout: [],
  console: [],
  pageErrors: []
};
let current;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = text => createHash('sha256').update(text).digest('hex');
function check(name, condition, detail) {
  report.checks.push({name, ok: Boolean(condition), ...(detail === undefined ? {} : {detail})});
  assert(condition, name);
  process.stdout.write(`${JSON.stringify({check: name, ok: true})}\n`);
}
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [args.get('playwright'), process.env.PLAYWRIGHT_MODULE_PATH, 'playwright', path.join(path.dirname(process.execPath), 'node_modules/playwright')].filter(Boolean);
  const runtimeRoot = path.join(process.env.LOCALAPPDATA || '', 'OpenAI/Codex/runtimes/cua_node');
  try { for (const entry of await fs.readdir(runtimeRoot, {withFileTypes: true})) if (entry.isDirectory()) candidates.push(path.join(runtimeRoot, entry.name, 'bin/node_modules/playwright')); } catch {}
  for (const candidate of candidates) {
    try { const value = require(candidate); if (value.chromium) { report.playwright = candidate; return value; } } catch {}
  }
  throw Error('Playwright is required. Pass --playwright ABSOLUTE_MODULE_DIRECTORY or install it in the project. CDP uses the packaged Electron runtime; no browser download is needed.');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function until(description, read, wait = timeout) {
  const end = Date.now() + wait;
  let error;
  while (Date.now() < end) {
    try { const value = await read(); if (value) return value; } catch (caught) { if (caught.acceptanceFailure) throw caught; error = caught; }
    await delay(100);
  }
  throw Error(`${description}${error ? `: ${error.message}` : ''}`);
}
async function launch(offline = false) {
  const port = await freePort();
  const logStem = offline ? 'offline' : report.books.length ? 'restart' : 'online';
  const stdout = await fs.open(path.join(output, `${logStem}.stdout.log`), 'w');
  const stderr = await fs.open(path.join(output, `${logStem}.stderr.log`), 'w');
  const environment = {...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--test-profile=${profile}`, ...(offline ? ['--offline'] : [])], {cwd: path.dirname(executable), windowsHide: true, env: environment, stdio: ['ignore', stdout.fd, stderr.fd]});
  const launched = {child, stdout, stderr, offline, closed: false};
  child.once('error', error => { launched.spawnError = error; });
  child.once('exit', (code, signal) => { launched.closed = true; launched.exit = {code, signal}; });
  current = launched;
  await until('Packaged client did not expose its own CDP endpoint', async () => {
    if (launched.spawnError) throw launched.spawnError;
    if (launched.closed) throw Error(`Client exited: ${JSON.stringify(launched.exit)}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(1000)});
    return response.ok;
  }, 30000);
  const playwright = await loadPlaywright();
  launched.browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  launched.page = await until('Packaged Gargantua renderer was not opened', async () => launched.browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('gargantua://app')));
  launched.page.setDefaultTimeout(timeout);
  launched.page.on('pageerror', error => report.pageErrors.push({mode: logStem, error: error.message}));
  launched.page.on('console', message => {
    if (!['warning', 'error'].includes(message.type())) return;
    const location = message.location();
    const externalImageFailure = /^https?:\/\//.test(location.url || '') && /(?:cover|image|thumbnail|\.(?:png|jpe?g|webp|avif)(?:$|\?))/i.test(location.url) && /failed to load resource|net::ERR_/i.test(message.text());
    report.console.push({mode: logStem, type: message.type(), text: message.text().slice(0, 3000), location, expectedExternalCoverFailure: externalImageFailure});
  });
  // Reload only our isolated renderer after listeners attach, so startup faults
  // cannot escape the error checks while Electron's inspector is connecting.
  await launched.page.reload({waitUntil: 'domcontentloaded'});
  await launched.page.getByTestId('library-tab').waitFor({state: 'visible'});
  check(`${logStem}: native packaged renderer loaded`, await launched.page.evaluate(() => Boolean(window.gargantua?.request) && typeof require === 'undefined' && location.protocol === 'gargantua:'));
  return launched.page;
}
async function closeClient() {
  const session = current;
  if (!session) return;
  if (!session.closed && session.page) await session.page.evaluate(() => window.close()).catch(() => {});
  let graceful = session.closed;
  if (!graceful) {
    try { await until('Client did not close gracefully', () => session.closed, 15000); graceful = true; } catch {}
  }
  if (!session.closed) { session.child.kill(); await until('Own test process did not stop', () => session.closed, 5000).catch(() => {}); }
  await session.browser?.close().catch(() => {});
  await session.stdout.close().catch(() => {});
  await session.stderr.close().catch(() => {});
  current = null;
  return graceful;
}
function bookSelector(kind, book) {
  return `[data-testid="${kind}"][data-source=${JSON.stringify(book.source)}][data-book-id=${JSON.stringify(book.id)}]`;
}
async function closeOverlays(page) {
  for (const id of ['close-reader', 'close-book']) { const button = page.getByTestId(id); if (await button.isVisible().catch(() => false)) await button.click(); }
}
async function screenshotAndLayout(page, label, sizes = [[1440, 900], [1280, 800], [1024, 768], [900, 650]]) {
  for (const [width, height] of sizes) {
    await page.setViewportSize({width, height});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      rootScrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      rootClientWidth: document.documentElement.clientWidth,
      clippedControls: [...document.querySelectorAll('button,input,select')].filter(element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        if (box.width < 1 || box.height < 1 || style.visibility === 'hidden' || style.display === 'none') return false;
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body) { const computed = getComputedStyle(ancestor); if (['auto', 'scroll', 'hidden', 'clip'].includes(computed.overflowX)) return false; ancestor = ancestor.parentElement; }
        return box.left < -2 || box.right > innerWidth + 2;
      }).map(element => ({testId: element.dataset.testid, label: (element.getAttribute('aria-label') || element.textContent || element.placeholder || '').trim().slice(0, 120)}))
    }));
    const filename = `${label}-${width}x${height}.png`;
    await page.screenshot({path: path.join(output, filename), fullPage: false});
    report.screenshots.push(filename);
    report.layout.push({screen: label, ...layout});
    check(`${label} ${width}×${height}: no horizontal page overflow`, layout.rootScrollWidth <= layout.rootClientWidth + 2, layout);
    check(`${label} ${width}×${height}: controls stay inside the viewport`, !layout.clippedControls.length, layout.clippedControls);
  }
  await page.setViewportSize({width: 1280, height: 800});
}
async function readChapter(page, book, expected) {
  const chapter = expected ? page.locator(`[data-testid="chapter-button"][data-chapter-id=${JSON.stringify(expected.id)}]`).first() : page.locator('[data-testid="chapter-button"]:not([disabled])').first();
  await chapter.waitFor({state: 'visible'});
  let id = await chapter.getAttribute('data-chapter-id');
  let title = (await chapter.innerText()).trim();
  assert(id, 'Chapter control must expose source chapter identity');
  await chapter.click();
  const content = page.getByTestId('reader-content');
  for (let skipped = 0; skipped <= 12; skipped++) {
    await until(`Real ${book.source} chapter did not render`, async () => {
      const failure = page.getByRole('heading', {name: 'Не удалось открыть главу', exact: true});
      if (await failure.isVisible().catch(() => false)) throw Object.assign(Error(`Live ${book.source} chapter failed: ${(await page.getByTestId('reader').innerText()).slice(-3000)}`), {acceptanceFailure: true});
      return await content.isVisible() && (await content.innerText()).trim().length > 0;
    });
    const text = (await content.innerText()).trim();
    const paragraphs = await content.locator('p').count();
    const record = {id, title, characters: text.length, paragraphs, sha256: digest(text), excerpt: text.slice(0, 240)};
    const substantial = text.length >= 250 && (book.source !== 'ranobelib' || paragraphs >= 2);
    if (!expected && !substantial && /иллюстрац|обложк|титульн|illustration|cover/i.test(title)) {
      assert(skipped < 12, 'Too many introductory illustration sections before readable prose');
      const item = {id, title, characters: text.length, paragraphs, reason: 'Explicit illustration, cover or title-page section; continuing to prose in the same book through the client'};
      (book.skippedFrontMatter ||= []).push(item);
      report.skippedFrontMatter.push({source: book.source, bookId: book.id, ...item});
      process.stdout.write(`${JSON.stringify({skippedFrontMatter: item, source: book.source, bookId: book.id})}\n`);
      const next = page.getByRole('button', {name: 'Следующая', exact: true});
      assert(await next.isEnabled(), 'Introductory illustration section has no accessible next chapter');
      await next.click();
      await page.getByRole('button', {name: 'Оглавление', exact: true}).click();
      const active = page.locator('[data-testid="chapter-button"][aria-current="page"]');
      await until('Next chapter identity did not change through the reader', async () => await active.count() === 1 && await active.getAttribute('data-chapter-id') !== id);
      id = await active.getAttribute('data-chapter-id');
      title = (await active.innerText()).trim();
      await page.getByRole('button', {name: 'Скрыть оглавление', exact: true}).click();
      continue;
    }
    check(`${book.source}: chapter contains substantial readable text`, substantial, record);
    check(`${book.source}: reader text contains no script or parser artifacts`, !/<\/?(?:script|iframe|html|body)\b|__NEXT_DATA__|cf-browser-verification|window\.__INITIAL_STATE__|enable javascript and cookies to continue|access denied/i.test(text));
    if (expected) check(`${book.source}: cached chapter is unchanged after ${current.offline ? 'offline' : 'cold'} restart`, record.sha256 === expected.sha256, {expected: expected.sha256, actual: record.sha256});
    return record;
  }
}
async function openSavedChapter(page, book, mode) {
  await closeOverlays(page);
  await page.getByTestId('library-tab').click();
  const card = page.locator(bookSelector('library-book', book));
  await card.waitFor({state: 'visible'});
  check(`${mode}: ${book.source} book survives in the library`, await card.count() === 1, {title: book.title, id: book.id});
  await card.getByTestId('open-library-book').click();
  await readChapter(page, book, book.chapter);
  await screenshotAndLayout(page, `${mode}-${book.source}-reader`, [[1280, 800], [900, 650]]);
}

try {
  let page = await launch();
  if (regression) {
    await page.getByTestId('search-tab').click();
    await page.getByTestId('source-filter').selectOption(regressionSpec.source);
    await page.getByTestId('search-input').fill(regressionSpec.title);
    await page.getByTestId('search-submit').click();
    await page.getByRole('heading', {name: 'Результаты поиска', exact: true}).waitFor({state: 'visible'});
    await until('Regression title search has not completed', async () => await page.getByTestId('search-submit').isEnabled() && (await page.getByTestId('search-submit').innerText()).trim() === 'Найти');
    const book = {source: regressionSpec.source, id: regressionSpec.id, title: regressionSpec.title, selectedBy: 'UI title search for previously failing source identity'};
    const label = `${book.source} ${book.id}`;
    const screenshotStem = `regression-${book.source}-${book.id}`;
    const card = page.locator(bookSelector('book-card', book));
    check(`Regression: UI title search finds the original ${label}`, await card.count() === 1 && await card.isVisible(), {visibleResults: await page.getByTestId('book-card').allInnerTexts()});
    report.books.push(book);
    await screenshotAndLayout(page, `${screenshotStem}-title-search`, [[1280, 800], [900, 650]]);
    await card.getByTestId('open-book').click();
    const dialog = page.getByRole('dialog', {name: 'Карточка книги'});
    await dialog.waitFor({state: 'visible'});
    await until(`Regression ${label} card did not load readable chapters`, async () => {
      const alert = dialog.getByRole('alert').first();
      if (await alert.isVisible().catch(() => false)) throw Object.assign(Error(`${label} regression failed: ${await alert.innerText()}`), {acceptanceFailure: true});
      return await dialog.locator('[data-testid="chapter-button"]:not([disabled])').count() > 0 && await dialog.getByTestId('read-book').isEnabled();
    });
    check(`Regression: card identity stays ${label}`, await dialog.getAttribute('data-source') === book.source && await dialog.getAttribute('data-book-id') === book.id);
    book.sourceUrl = await dialog.getByTestId('source-link').getAttribute('href');
    check(`Regression: exact official source link matches ${label}`, new URL(book.sourceUrl).protocol === 'https:' && new URL(book.sourceUrl).hostname === regressionSpec.host && new URL(book.sourceUrl).pathname === regressionSpec.sourcePath, book.sourceUrl);
    const save = dialog.getByTestId('save-book');
    if (await save.isEnabled()) await save.click();
    await until('Regression book has not been saved', async () => /В библиотеке/.test(await save.innerText()) && await save.isDisabled());
    book.chapter = await readChapter(page, book);
    await screenshotAndLayout(page, `${screenshotStem}-reader`, [[1280, 800], [900, 650]]);
    await closeOverlays(page);
    await page.getByTestId('library-tab').click();
    await page.locator(bookSelector('library-book', book)).waitFor({state: 'visible'});
    check('Regression: original failing book is saved in the client library', true);
    check('Regression: packaged client closes gracefully', await closeClient());
    check('Regression: no unhandled renderer errors', report.pageErrors.length === 0, report.pageErrors);
    check('Regression: no unexpected console errors', !report.console.some(message => message.type === 'error' && !message.expectedExternalCoverFailure), report.console);
    report.ok = true;
  } else {
  await page.getByTestId('search-tab').click();
  await page.keyboard.press('Control+k');
  await until('Search shortcut did not focus the query field', () => page.getByTestId('search-input').evaluate(element => document.activeElement === element), 5000);
  check('Search keyboard shortcut focuses the query field', true);
  await screenshotAndLayout(page, 'search-empty');
  for (const source of sources) {
    await closeOverlays(page);
    await page.getByTestId('search-tab').click();
    await page.getByTestId('source-filter').selectOption(source);
    await page.getByTestId('random-book').click();
    const dialog = page.getByRole('dialog', {name: 'Карточка книги'});
    await until(`Random ${source} catalog request did not open a card`, async () => {
      if (await dialog.isVisible()) return true;
      const alert = page.getByRole('alert').first();
      if (await alert.isVisible().catch(() => false)) throw Object.assign(Error(`Live ${source} random selection failed: ${await alert.innerText()}`), {acceptanceFailure: true});
      return false;
    });
    await until('Random book identity did not resolve', async () => (await dialog.getAttribute('data-source')) === source && Boolean(await dialog.getAttribute('data-book-id')));
    const book = {source, id: await dialog.getAttribute('data-book-id'), title: (await dialog.getByTestId('book-title').innerText()).trim(), selectedBy: 'random catalog button in packaged UI'};
    assert(book.title.length > 1, 'Random catalog returned an empty title');
    report.books.push(book);
    check(`${source}: random existing catalog book opens through the client`, true, book);
    await until('Random card has not loaded a readable table of contents', async () => {
      const alert = dialog.getByRole('alert').first();
      if (await alert.isVisible().catch(() => false)) throw Object.assign(Error(`Live ${source} card failed: ${await alert.innerText()}`), {acceptanceFailure: true});
      return await dialog.locator('[data-testid="chapter-button"]:not([disabled])').count() > 0 && await dialog.getByTestId('read-book').isEnabled();
    });
    const sourceUrl = await dialog.getByTestId('source-link').getAttribute('href');
    const expectedHost = {ranobelib: 'ranobelib.me', wikisource: 'ru.wikisource.org', gutenberg: 'www.gutenberg.org'}[source];
    check(`${source}: card links to the actual source catalog`, new URL(sourceUrl).protocol === 'https:' && new URL(sourceUrl).hostname === expectedHost, sourceUrl);
    book.sourceUrl = sourceUrl;
    await screenshotAndLayout(page, `${source}-random-card`);
    const save = dialog.getByTestId('save-book');
    if (await save.isEnabled()) await save.click();
    await until('Book save has not completed', async () => /В библиотеке/.test(await save.innerText()) && await save.isDisabled());
    await page.getByTestId('close-book').click();
    await page.getByTestId('library-tab').click();
    await page.locator(bookSelector('library-book', book)).waitFor({state: 'visible'});
    check(`${source}: explicit save persists the card before any reading`, true);
    await page.getByTestId('search-tab').click();
    await page.getByTestId('search-input').fill(book.title);
    await page.getByTestId('search-submit').click();
    await page.getByRole('heading', {name: 'Результаты поиска', exact: true}).waitFor({state: 'visible'});
    await until('Title search has not completed', async () => await page.getByTestId('search-submit').isEnabled() && (await page.getByTestId('search-submit').innerText()).trim() === 'Найти');
    const result = page.locator(bookSelector('book-card', book));
    check(`${source}: UI title search finds the same randomly selected identity`, await result.count() === 1 && await result.isVisible(), {query: book.title, id: book.id, visibleResults: await page.getByTestId('book-card').allInnerTexts()});
    await screenshotAndLayout(page, `${source}-title-search`);
    await result.getByTestId('open-book').click();
    await dialog.waitFor({state: 'visible'});
    book.chapter = await readChapter(page, book);
    await screenshotAndLayout(page, `${source}-reader`);
    await closeOverlays(page);
    await page.getByTestId('library-tab').click();
    await page.locator(bookSelector('library-book', book)).waitFor({state: 'visible'});
    check(`${source}: searched book is visible in the client library`, true);
  }
  const knownBook = report.books[0];
  await page.getByTestId('search-tab').click();
  await page.getByTestId('source-filter').selectOption('all');
  await page.getByTestId('search-input').fill(knownBook.title);
  await page.getByTestId('search-submit').click();
  await until('Combined catalog search has not completed', async () => await page.getByTestId('search-submit').isEnabled() && (await page.getByTestId('search-submit').innerText()).trim() === 'Найти');
  const combinedResult = page.locator(bookSelector('book-card', knownBook));
  check('Default all-sources search preserves a known matching source identity', await combinedResult.count() === 1 && await combinedResult.isVisible(), {query: knownBook.title, source: knownBook.source, id: knownBook.id});
  await screenshotAndLayout(page, 'all-sources-search', [[1280, 800], [900, 650]]);
  await page.getByTestId('library-tab').click();
  await screenshotAndLayout(page, 'library-online');
  check('Online packaged client closes gracefully', await closeClient());
  page = await launch();
  for (const book of report.books) await openSavedChapter(page, book, 'cold');
  check('Cold restarted client closes gracefully', await closeClient());
  page = await launch(true);
  await page.getByTestId('search-tab').click();
  await page.getByTestId('search-input').fill('Проверка недоступного соединения');
  await page.getByTestId('search-submit').click();
  const alert = page.getByRole('alert').first();
  await alert.waitFor({state: 'visible'});
  const offlineError = (await alert.innerText()).trim();
  check('Offline client explains that live search is unavailable', /недоступ|подключ|соедин|офлайн|сервер|offline/i.test(offlineError), offlineError);
  await screenshotAndLayout(page, 'offline-search-error', [[1280, 800], [900, 650]]);
  for (const book of report.books) await openSavedChapter(page, book, 'offline');
  check('Offline client closes gracefully', await closeClient());
  check('No unhandled renderer errors', report.pageErrors.length === 0, report.pageErrors);
  const consoleErrors = report.console.filter(message => message.type === 'error' && !message.expectedExternalCoverFailure);
  check('No unexpected renderer console errors', consoleErrors.length === 0, consoleErrors);
  report.ok = true;
  }
} catch (error) {
  report.ok = false;
  report.error = {message: error.message, stack: error.stack};
  if (current?.page) {
    await current.page.screenshot({path: path.join(output, 'failure.png'), fullPage: false}).catch(() => {});
    await fs.writeFile(path.join(output, 'failure-visible-text.txt'), await current.page.locator('body').innerText().catch(() => '')).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await closeClient();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(`${JSON.stringify({ok: report.ok, report: path.join(output, 'report.json'), books: report.books.map(({source, id, title}) => ({source, id, title})), error: report.error?.message})}\n`);
}
