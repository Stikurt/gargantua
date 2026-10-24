# Сторонние компоненты и содержимое

MIT в LICENSE распространяется на оригинальный код Гаргантюа. Сторонние библиотеки, runtime и содержимое каталогов сохраняют свои лицензии. Уведомления внутри распространяемых пакетов следует сохранять.

- Node.js: https://github.com/nodejs/node/blob/main/LICENSE
- Electron: https://github.com/electron/electron/blob/main/LICENSE . Windows-пакет сохраняет LICENSE и LICENSES.chromium.html из закреплённого runtime.
- React: https://github.com/facebook/react/blob/main/LICENSE
- Express: https://github.com/expressjs/express/blob/master/LICENSE
- Vite: https://github.com/vitejs/vite/blob/main/LICENSE
- AndroidX Core, AndroidX WebKit и Android Gradle Plugin используют условия соответствующих upstream-пакетов; зависимости указаны в android/mvp/build.gradle.

Точные версии npm-зависимостей закреплены в package-lock.json. Их тексты лицензий доступны в установленных пакетах после npm ci. Наличие пакета в lock не означает включение его функций в интерфейс.

Книги, обложки, переводы и названия сторонних каталогов не становятся собственностью авторов приложения. Исходники и релизы не содержат скачанных книг, пользовательской библиотеки, модели голоса или аудиозаписей. Используйте разрешённый вам контент и соблюдайте условия источников.

Экспериментальная ветка с озвучкой содержит отдельное описание условий библиотек и моделей в SETUP_AUDIO.md и соответствующих lock-файлах.
