# Библиотека 0.9 — контракт приёмки интерфейса

Контракт обновлён после переработки библиотеки. Он описывает общий интерфейс ПК и Android; нативные загрузки и хранилище глав используют прежние контроллеры. Проверки телефона выполняются отдельно от браузерного макета.

## Навигация и карточки

| Элемент | `data-testid` и атрибуты |
|---|---|
| Общая витрина | `library-all-books`, постоянная вкладка, `aria-pressed` |
| Каталоги | `library-catalogs-tab`, постоянная вкладка, `aria-pressed` |
| Экран каталогов | `library-home`, `library-folder-grid` |
| Плитка каталога | `library-folder-tile`, `data-folder-id` |
| Без папки | `library-unfiled-books` на экране каталогов |
| Открытый список | `library-folder-view`, заголовок `library-current-folder` |
| Возврат к каталогам | `library-home-back` внутри каталога или списка без папки; в общей витрине используется вкладка |
| Найти в текущем списке | `library-search-input` |
| Книжная строка | `library-book-entry`, `data-book-key`, `data-folder-id` |
| Карточка | `library-book`, `data-source`, `data-book-id` |
| Описание / чтение | `open-library-book`, `read-library-book` либо `continue-reading` |

Общий поиск использует только название и автора. Все слова запроса должны встретиться, порядок слов свободный; регистр, `ё/е` и пунктуация нормализуются. Сначала применяется выбранный каталог, затем текстовый фильтр.

## Выбор и операции с каталогами

`library-select-toggle` включает выбор; `library-book-select` — кнопка с `role="checkbox"` и `aria-checked` внутри соответствующей книжной строки. `library-select-all` выбирает видимые результаты. `library-mode-done` завершает выбор или перестановку.

Общая панель `library-selection-actions` содержит `library-bulk-add`, `library-bulk-move`, `library-bulk-remove-reference`, `library-bulk-remove-library`. Перемещение и снятие ссылки доступны только в пользовательском каталоге. Удаление из библиотеки всегда требует отдельного подтверждения.

Диалог: `library-action-dialog`, `library-action-close`, `library-action-folder` (единственный общий выбор каталога), `library-action-apply`. Действие записано в `data-action`. Для безопасного перемещения **обязательны** `data-move-scope="catalog"` и `data-from-folder-id` исходного каталога. Автоматизация должна проверить эти атрибуты до подтверждения.

При повторном добавлении `library-action-already-included` показывает число уже включённых книг в `data-count`. Повторное добавление не создаёт новые книжные строки или повторные ссылки. Контекстное перемещение снимает связь только с исходным каталогом и сохраняет все остальные связи.

## Порядок и меню

`library-order-toggle` открывает `library-order-list`. Кнопки `library-book-up` и `library-book-down` находятся в соответствующей строке и отключены на границах. Перестановка внутри каталога не меняет его соседние каталоги или общий порядок библиотеки.

`library-menu-toggle` открывает меню: `library-folder-manage` (переименование), `library-folder-delete-open` → `library-folder-delete-confirm`, `catalog-export`, `catalog-share`, `catalog-import`. Создание каталога: `library-folder-create` либо `library-create-first-folder`; прежние поля диалога — `library-folder-dialog`, `library-folder-name`, `library-folder-save`, `library-folder-close`.

Перенос файла: `catalog-transfer-progress`, `catalog-transfer-error`, `catalog-transfer-result`, `catalog-transfer-partial`, `catalog-transfer-dismiss`. Результат сохраняет атрибуты `data-book-count`, `data-chapter-count`, `data-cached-chapter-count`. Меню отправки не доказывает доставку файла.

## Состояние и ожидания теста

Единственная запись организации остаётся `library:organization:v1`, схема 1. Добавлено поле `view: "home" | "folder"`; прежний `selectedFolder` сохраняется и при переходе на экран каталогов. Старые записи без `view` начинают с каталогов, сохраняя книги, связи, порядок и последний выбранный каталог. После выбора конкретного списка он восстанавливается при перезапуске.

Чтение снимков IndexedDB и нативного прогресса в приёмке допускается только для наблюдения. Операции выполняются реальными кнопками. После смены вкладки, каталога или перестановки нужно дождаться ожидаемого набора книжных ключей либо завершения записи; возврат `click()` сам по себе не подтверждает завершение IndexedDB. Скрытых устаревших выпадающих списков под карточками нет.
