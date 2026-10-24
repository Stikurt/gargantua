import { authorName, bookKey } from './api.mjs';
import * as deviceStorage from './storage.mjs';

// One additive record: reader positions, chapter caches and book rows stay intact.
export const LIBRARY_ORGANIZATION_KEY = 'library:organization:v1';
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const folderName = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
const compareName = value => folderName(value).normalize('NFKC').toLocaleLowerCase('ru');
const unique = values => [...new Set(values.filter(identity))];
const rowKey = row => typeof row === 'string' ? row : bookKey(row.book || row);
const searchText = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/gu, 'е').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/gu, ' ').trim();
export function matchesLibrarySearch(row, query) {
  const book = row.book || row, haystack = searchText(`${book.title || ''} ${authorName(book)}`);
  return searchText(query).split(' ').filter(Boolean).every(word => haystack.includes(word));
}

export function normalizeOrganization(value) {
  if (Number(value?.schemaVersion) > 1) throw new Error('Папки созданы более новой версией приложения. Обновите Гаргантюа.');
  const ids = new Set();
  const folders = (Array.isArray(value?.folders) ? value.folders : []).flatMap(folder => {
    if (!identity(folder?.id) || ['all', 'unfiled'].includes(folder.id) || ids.has(folder.id) || !folderName(folder.name)) return [];
    ids.add(folder.id);
    return [{ id: folder.id, name: folderName(folder.name).slice(0, 80), createdAt: Number(folder.createdAt) || 0 }];
  });
  const assignments = Object.fromEntries(Object.entries(value?.assignments || {}).filter(([key, folderId]) => identity(key) && ids.has(folderId)));
  const folderReferences = Object.fromEntries(Object.entries(value?.folderReferences || {}).filter(([id, keys]) => ids.has(id) && Array.isArray(keys)).map(([id, keys]) => [id, unique(keys)]));
  const folderOrders = Object.fromEntries(Object.entries(value?.folderOrders || {}).filter(([id, keys]) => ids.has(id) && Array.isArray(keys)).map(([id, keys]) => [id, unique(keys)]));
  const selectedFolder = ['all', 'unfiled'].includes(value?.selectedFolder) || ids.has(value?.selectedFolder) ? value.selectedFolder : 'all';
  return { schemaVersion: 1, folders, assignments, folderReferences, folderOrders, order: unique(Array.isArray(value?.order) ? value.order : []), selectedFolder, view: value?.view === 'folder' ? 'folder' : 'home' };
}

export function libraryFolderMemberships(organization) {
  const state = normalizeOrganization(organization), memberships = new Map();
  const add = (key, folderId) => { if (!memberships.has(key)) memberships.set(key, new Set()); memberships.get(key).add(folderId); };
  for (const [key, folderId] of Object.entries(state.assignments)) add(key, folderId);
  for (const [folderId, keys] of Object.entries(state.folderReferences)) for (const key of keys) add(key, folderId);
  return memberships;
}

function folderOrder(state, id) {
  const members = new Set([...Object.entries(state.assignments).filter(([, folder]) => folder === id).map(([key]) => key), ...(state.folderReferences[id] || [])]);
  return unique([...(state.folderOrders[id] || []), ...state.order, ...members]).filter(key => members.has(key));
}

export function orderedLibrary(rows, organization, selectedFolder = 'all') {
  const state = normalizeOrganization(organization);
  const memberships = libraryFolderMemberships(state);
  const rank = new Map((['all', 'unfiled'].includes(selectedFolder) ? state.order : folderOrder(state, selectedFolder)).map((key, index) => [key, index]));
  return rows.map((row, index) => ({ row, index, key: rowKey(row) }))
    .filter(({ key }) => selectedFolder === 'all' || (selectedFolder === 'unfiled' ? !memberships.has(key) : memberships.get(key)?.has(selectedFolder)))
    .sort((left, right) => (rank.get(left.key) ?? Infinity) - (rank.get(right.key) ?? Infinity) || left.index - right.index)
    .map(({ row }) => row);
}

export function createLibraryOrganization({ storage = deviceStorage, createId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`, now = Date.now } = {}) {
  const change = transform => storage.update(LIBRARY_ORGANIZATION_KEY, raw => {
    const state = normalizeOrganization(raw);
    transform(state);
    return state;
  });
  const requireFolder = (state, id) => {
    const folder = state.folders.find(value => value.id === id);
    if (!folder) throw new Error('Эта папка больше не существует. Выберите другую.');
    return folder;
  };
  const validateName = (state, value, exceptId) => {
    const name = folderName(value);
    if (!name) throw new Error('Введите название папки.');
    if (name.length > 80) throw new Error('Название папки должно быть не длиннее 80 символов.');
    if (state.folders.some(folder => folder.id !== exceptId && compareName(folder.name) === compareName(name))) throw new Error('Папка с таким названием уже есть.');
    return name;
  };
  return {
    async read() { return normalizeOrganization(await storage.get(LIBRARY_ORGANIZATION_KEY)); },
    sync(rows) {
      const keys = unique(rows.map(rowKey));
      return change(state => {
        state.order = unique([...state.order, ...keys]);
        for (const folder of state.folders) state.folderOrders[folder.id] = folderOrder(state, folder.id);
      });
    },
    createFolder(value) {
      return change(state => {
        const name = validateName(state, value);
        const id = String(createId());
        if (!identity(id) || ['all', 'unfiled'].includes(id) || state.folders.some(folder => folder.id === id)) throw new Error('Не удалось создать папку. Повторите попытку.');
        state.folders.push({ id, name, createdAt: now() });
        state.selectedFolder = id;
        state.view = 'folder';
      });
    },
    importFolder(value, books) {
      const keys = unique(books.map(rowKey));
      return change(state => {
        const base = folderName(value) || 'Открытый каталог';
        let name = base.slice(0, 80), number = 1;
        while (state.folders.some(folder => compareName(folder.name) === compareName(name))) { const suffix = ` (${++number})`; name = base.slice(0, 80 - suffix.length) + suffix; }
        const id = String(createId());
        if (!identity(id) || ['all', 'unfiled'].includes(id) || state.folders.some(folder => folder.id === id)) throw new Error('Не удалось создать папку для каталога. Повторите попытку.');
        state.folders.push({ id, name, createdAt: now() });
        state.folderReferences[id] = keys;
        state.folderOrders[id] = keys;
        state.order = unique([...state.order, ...keys]);
        state.selectedFolder = id;
        state.view = 'folder';
      });
    },
    renameFolder(id, value) {
      return change(state => { const folder = requireFolder(state, id); folder.name = validateName(state, value, id); });
    },
    deleteFolder(id) {
      return change(state => {
        requireFolder(state, id);
        state.folders = state.folders.filter(folder => folder.id !== id);
        state.assignments = Object.fromEntries(Object.entries(state.assignments).filter(([, folderId]) => folderId !== id));
        delete state.folderReferences[id];
        delete state.folderOrders[id];
        if (state.selectedFolder === id) { state.selectedFolder = 'unfiled'; state.view = 'home'; }
      });
    },
    selectFolder(id) {
      return change(state => { if (!['all', 'unfiled'].includes(id)) requireFolder(state, id); state.selectedFolder = id; state.view = 'folder'; });
    },
    showHome() { return change(state => { state.view = 'home'; }); },
    removeFromFolder(books, id) {
      const keys = unique((Array.isArray(books) ? books : [books]).map(rowKey));
      return change(state => {
        requireFolder(state, id);
        for (const key of keys) if (state.assignments[key] === id) delete state.assignments[key];
        const removed = new Set(keys);
        state.folderReferences[id] = (state.folderReferences[id] || []).filter(key => !removed.has(key));
        state.folderOrders[id] = (state.folderOrders[id] || []).filter(key => !removed.has(key));
      });
    },
    organizeBooks(books, id, action = 'add', fromFolderId = '') {
      const keys = unique(books.map(rowKey));
      return change(state => {
        if (!['add', 'move'].includes(action)) throw new Error('Неизвестное действие с каталогом.');
        requireFolder(state, id);
        if (action === 'move' && fromFolderId) {
          requireFolder(state, fromFolderId);
          if (fromFolderId === id) return;
          for (const key of keys) {
            const belongs = state.assignments[key] === fromFolderId || (state.folderReferences[fromFolderId] || []).includes(key);
            if (!belongs) continue;
            const targetOrder = folderOrder(state, id);
            if (state.assignments[key] === fromFolderId) delete state.assignments[key];
            state.folderReferences[fromFolderId] = (state.folderReferences[fromFolderId] || []).filter(value => value !== key);
            state.folderOrders[fromFolderId] = (state.folderOrders[fromFolderId] || []).filter(value => value !== key);
            state.folderReferences[id] = unique([...(state.folderReferences[id] || []), key]);
            state.folderOrders[id] = unique([...targetOrder, key]);
          }
          return;
        }
        for (const key of keys) {
          const targetOrder = folderOrder(state, id).filter(value => action !== 'move' || value !== key);
          if (action === 'move') {
            state.assignments[key] = id;
            for (const folder of state.folders) {
              state.folderReferences[folder.id] = (state.folderReferences[folder.id] || []).filter(value => value !== key);
              state.folderOrders[folder.id] = (state.folderOrders[folder.id] || []).filter(value => value !== key);
            }
          } else state.folderReferences[id] = unique([...(state.folderReferences[id] || []), key]);
          state.folderOrders[id] = unique([...targetOrder, key]);
          state.order = unique([...state.order, key]);
        }
      });
    },
    moveToFolder(book, id) {
      const key = rowKey(book);
      return change(state => {
        if (!identity(key)) throw new Error('Не удалось определить книгу.');
        if (id) { requireFolder(state, id); state.assignments[key] = id; }
        else delete state.assignments[key];
        for (const folder of state.folders) {
          state.folderReferences[folder.id] = (state.folderReferences[folder.id] || []).filter(value => value !== key);
          state.folderOrders[folder.id] = (state.folderOrders[folder.id] || []).filter(value => value !== key);
        }
        if (id) state.folderOrders[id] = [...(state.folderOrders[id] || []), key];
        state.order = unique([...state.order, key]);
      });
    },
    addToFolder(book, id) {
      const key = rowKey(book);
      return change(state => {
        requireFolder(state, id);
        if (!identity(key)) throw new Error('Не удалось определить книгу.');
        state.folderReferences[id] = unique([...(state.folderReferences[id] || []), key]);
        state.folderOrders[id] = unique([...folderOrder(state, id), key]);
        state.order = unique([...state.order, key]);
      });
    },
    moveBook(book, direction, visibleKeys, selectedFolder = 'all') {
      const key = rowKey(book);
      if (![-1, 1].includes(direction)) return Promise.reject(new Error('Неизвестное направление перемещения.'));
      return change(state => {
        const allowed = new Set(unique(visibleKeys.map(rowKey)));
        const order = ['all', 'unfiled'].includes(selectedFolder) ? state.order : (requireFolder(state, selectedFolder), folderOrder(state, selectedFolder));
        const visibleOrder = order.filter(value => allowed.has(value));
        const index = visibleOrder.indexOf(key);
        const neighbor = visibleOrder[index + direction];
        if (index < 0 || !neighbor) return;
        const from = order.indexOf(key), to = order.indexOf(neighbor);
        [order[from], order[to]] = [order[to], order[from]];
        if (!['all', 'unfiled'].includes(selectedFolder)) state.folderOrders[selectedFolder] = order;
      });
    },
    forgetBook(book) {
      const key = rowKey(book);
      return change(state => {
        delete state.assignments[key]; state.order = state.order.filter(value => value !== key);
        for (const id of Object.keys(state.folderReferences)) state.folderReferences[id] = state.folderReferences[id].filter(value => value !== key);
        for (const id of Object.keys(state.folderOrders)) state.folderOrders[id] = state.folderOrders[id].filter(value => value !== key);
      });
    },
  };
}

export const libraryOrganization = createLibraryOrganization();
