# Установка экспериментальной озвучки

## Что требуется

Эта инструкция относится к `experimental/audio`. Поддерживаемый путь тяжёлого исполнителя — Windows x64 с Docker Desktop в режиме Linux containers, PowerShell 7 и Python 3.12. Монитор использует показатели Windows и расположение диска Docker Desktop; Linux/macOS для всего хоста не приняты. Для сборки и модульных тестов Node нужен Node.js 24 и `npm`; приложение и парсер собираются внутри Docker. Для Android нужны Platform Tools (`adb`) и физический телефон Android 10+; Android SDK собирается отдельным Docker-образом. Сначала убедитесь, что команды `docker`, `python`, `pwsh` доступны в вашей консоли.

Piper работает на CPU. Перевод Qwen требует отдельно исправного NVIDIA GPU, поддерживаемого Docker Desktop GPU-доступа и `nvidia-smi` в PATH. Автоматического перехода перевода на CPU нет. Не включайте перевод, пока обычная озвучка не проверена.

Клонируйте отдельную копию этой ветки:

```powershell
git clone --branch experimental/audio https://github.com/Stikurt/gargantua.git gargantua-audio
cd gargantua-audio
$projectRoot = (Get-Location).Path
New-Item -ItemType Directory -Force .local/runtime,.local/inference-runtime,.local/inference-spool,.local/audio-downloads,.local/s5-pilot/tts-models | Out-Null
```

Не запускайте эту копию поверх стабильных Docker volumes или пользовательской библиотеки. В compose задан отдельный проект `gargantua-audio-experimental`. Порт 3080 должен быть свободен: остановите стабильный сервер его штатным способом на время эксперимента. Выходные книги и пользователи этих двух серверов автоматически не переносятся.

## Секреты новой базы

В PowerShell 7 создайте `.env` только если его ещё нет. Секреты случайные, независимые, по 32 байта; опубликованный `.env.example` содержит только пустые поля.

```powershell
if (Test-Path -LiteralPath .env) { throw '.env уже существует; существующие пароли автоматически не заменяются.' }
$appSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
$adminSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
@("DB_PASSWORD=$appSecret", "DB_ADMIN_PASSWORD=$adminSecret") | Set-Content -LiteralPath .env -Encoding utf8
./scripts/protect-local.ps1
```

Не коммитьте `.env`, `.local`, логины, ключ подписи, скачанные книги, WAV и Docker volumes. Смена `.env` не меняет пароль уже созданной БД автоматически.

## Закреплённый CPU runtime

Скачайте точные wheels из опубликованного `wheel-lock.json`. Помощник использует только закреплённые HTTPS-адреса и проверяет размер и SHA-256 каждого файла; он не вызывает `pip` на хосте и не запускает модели.

```powershell
python scripts/prepare-audio-experimental.py wheels
docker build -t gargantua-s5-cpu:pilot experiments/s5/runtime
```

Образ устанавливает бинарные пакеты офлайн с `--require-hashes`; `pip check` входит в сборку. Исходные wheels и модели не входят в Git. Зафиксированный список зависит от доступности артефактов поставщиков: при HTTP-ошибке не заменяйте версии или SHA произвольно. Частичный файл имеет суффикс `.partial`; после проверки причины сбоя удалите только этот файл и повторите скачивание. Уже проверенные полные файлы переиспользуются.

## Голос Piper Denis

Загружается только выбранный Denis FP32, без остальных экспериментальных голосов и переводчиков:

```powershell
python scripts/prepare-audio-experimental.py voice
docker run --rm --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --memory-swap 2g --cpus 2 --pids-limit 128 --tmpfs /tmp:size=128m,mode=1777 --mount "type=bind,source=$projectRoot,target=/project,readonly" --mount "type=bind,source=$projectRoot/.local/s5-pilot/tts-models,target=/project/.local/s5-pilot/tts-models" --entrypoint python gargantua-s5-cpu:pilot /project/scripts/prepare-audio-experimental.py stage
```

`stage` проверяет архив, безопасно извлекает его без ссылок и исполняемых загрузчиков, проверяет ONNX и удаляет только идентичные повторные метаданные в производной копии. Затем **все** файлы и их SHA сравниваются с `inference/profiles.lock.json`. Успех — `selected-profile-file-hashes-verified`. Неполный каталог не очищается автоматически: проверьте его и повторите в чистой отдельной копии. Это проверка происхождения/формата, а не полное антивирусное заключение или оценка голоса.

Docker image ID локальной сборки может отличаться от исторического ID; `sha256:…` в lock — локальная идентичность, её нельзя передать в `docker pull`. Явно привяжите проверенный новый образ и обновите экспорт профиля:

```powershell
python scripts/prepare-audio-experimental.py bind-runtime --image gargantua-s5-cpu:pilot
python inference/freeze_profiles.py
python inference/freeze_profiles.py --check
git diff -- inference/profiles.lock.json inference/profiles.json
```

Делайте это **до** первой генерации и сборки сервера. Изменение профиля меняет идентичность результата; не перепривязывайте профиль в середине незавершённой задачи. Автоматической замены кода/модели/рецепта нет.

## Сервер и первый вход

```powershell
docker compose up -d --build
docker compose ps
Invoke-RestMethod http://127.0.0.1:3080/api/health
docker compose exec -T app node server/cli.mjs bootstrap
```

Последняя команда создаёт владельца и показывает пароль один раз. Сохраните его в менеджере паролей и смените после входа. Повторный `bootstrap` не является способом сброса уже существующего владельца; используйте `profiles list` и `profiles reset <ID>` через административную консоль при необходимости.

Откройте `http://localhost:3080`. Созданы службы `app`, `worker`, `db`, `parser`, `clamav` и завершившийся одноразовый `storage-init`. Порт наружу не опубликован. Первое получение сигнатур ClamAV может занять время; до готовности свежего антивируса импорт ждёт. Не обходите карантин ради запуска.

## Монитор и исполнитель

Для воспроизводимого ручного запуска используются явно установленные PowerShell/Python, а не отсутствующий в свежем клоне частный переносимый runtime. В **отдельном терминале** из корня экспериментальной копии запустите:

```powershell
pwsh -NoProfile -File scripts/resource-monitor.ps1
```

В другом терминале:

```powershell
python -u inference/executor.py --spool .local/inference-spool
```

Оба процесса оставьте работающими. Исполнитель проверяет свежесть метрик, свободную RAM и диск. У него есть дополнительный порог свободного диска 10 ГиБ; это защитный порог текущего кода, **не** оценка достаточного места для библиотеки. При неизвестном расположении диска Docker/метриках или нехватке ресурсов задача ждёт; не подделывайте `resources.json` и не отключайте проверку. Состояние смотрите в `.local/runtime/resources.json` и `.local/inference-runtime/daemon.json`. У рабочего `daemon` состояние `idle` или `running`; перед приёмом результата проверяется остановка его контейнеров.

Автозапуск, резервные копии и старые lifecycle-обёртки по умолчанию не включены. Некоторые исторические `start.ps1`/`setup.ps1`/задачи требуют отдельно подготовленный переносимый runtime; для новой установки используйте последовательность выше.

## Запрос аудио и восстановление

1. Войдите в клиент, импортируйте небольшой разрешённый русский текст и дождитесь успешных проверок.
2. Выберите создание аудио в клиенте. Либо используйте административную консоль, предварительно получив ID книги: `docker compose exec -T app node server/cli.mjs derived request <book-id> --audio --source-language ru`.
3. В клиенте дождитесь завершения. Состояние очереди: `docker compose exec -T app node server/cli.mjs derived list`; подробности: `derived show <request-id>`.
4. Скачайте аудио на устройство и проверьте Play, паузу, скорость, переход к другому фрагменту и новое открытие без сервера.

Непринятый сегмент после аварии вычисляется заново; уже подтверждённые сегменты проверяются по хешам и не генерируются повторно без изменения исходника/профиля. Оригинал хранится отдельно от результата. Статус завершённой очереди сам по себе не доказывает, что весь звук скачан на устройство.

Для штатной остановки сначала прекратите выдачу задач и остановите worker:

```powershell
docker compose stop worker
./scripts/derived-executor.ps1 -Action stop
```

Дождитесь подтверждённой остановки исполнителя и его контейнеров. Завершите монитор через Ctrl+C в его терминале, затем `docker compose stop`. Не удаляйте `.local/inference-spool`, `.local/inference-runtime` и volumes для обычного перезапуска. Для следующего запуска: `docker compose up -d`, затем монитор и исполнитель двумя командами выше. Готовые книги/сегменты остаются. Команда `docker compose down` сохраняет именованные volumes; добавление `-v` уничтожает серверные данные и в обычных инструкциях не требуется.

## Клиенты

Для Windows из этой ветки:

Скрипт сам получает Electron **45.0.0 Windows x64** по официальному адресу из `desktop/runtime.json` и проверяет закреплённый SHA-256. Размер проверенного ZIP — 158 223 852 байта; на первом запуске нужны сеть и место под архив и распакованное приложение. Готовая папка EXE или частный кэш автора не требуются. Если GitHub недоступен или SHA не совпал, сборка останавливается. Переносимый Python/PowerShell из старой автоматизации для этой сборки не нужен; нужны установленный PowerShell 7 и Docker Desktop в стандартном расположении, которое поддерживает `scripts/runtime-common.ps1`.

```powershell
./scripts/build-desktop.ps1 -Destination releases/Gargantua-Audio-Experimental
```

Запустите `releases/Gargantua-Audio-Experimental/Cotology.exe`. Историческое техническое имя EXE и локальная идентичность данных `Cotology` сохранены; не запускайте одновременно несколько копий с одним профилем. Клиент обращается к локальному серверу на 3080. Новый стабильный MVP имеет отдельную идентичность.

Для старого Android-клиента с аудио:

Скрипт создаёт Android SDK в Docker: Gradle 8.13/JDK 17, SDK 36, build-tools 35.0.0. Архив command line tools закреплён по SHA; первый запуск также обращается к Google/Maven/Gradle. Android SDK на Windows-хосте и сохранённый Gradle-кэш автора не нужны. Исходники `android/app`, корневые Gradle-файлы и выбранный образ старого интерфейса должны быть из этой ветки. Gradle/base-image registry и внешние зависимости могут быть недоступны; успешный исторический APK не заменяет повторную сборку и тест нового файла.

```powershell
./scripts/build-android.ps1 -Image gargantua-audio-experimental:local
adb install -r releases/Cotology-Android/Cotology-preview.apk
```

Пакет `local.cotology.reader.preview`, версия `0.2.2-preview`/code 5; это **другое** приложение, чем стабильное Android 0.8. Для API этому клиенту нужен HTTPS-адрес в собственной приватной сети Tailscale. Подключите оба устройства к своей сети и на сервере выполните `tailscale serve --bg --https=443 http://127.0.0.1:3080`, затем укажите адрес, показанный **вашей** установкой Tailscale, в настройках клиента. Домен или адрес автора проекта нигде не требуется. `Funnel` для этой инструкции не нужен. Старый `scripts/remote.ps1` может проверять MVP endpoint; используйте ручную команду выше или его исправленную веточную версию.

При новой debug-подписи обновление поверх ранее подписанного APK может быть отклонено Android. Не удаляйте приложение с сохранённой библиотекой автоматически: используйте прежний ключ для обновления или отдельное устройство. Ключи `.local/android-signing` сохраняйте у себя и не публикуйте. Новый APK требует собственной проверки на телефоне, даже при совпадении исходников.

## Дополнительный перевод EN→RU

Перевод необязателен для русской озвучки. Закреплённый Qwen GGUF занимает 2 707 513 696 байт; дополнительно нужны runtime, место под результаты и пригодная GPU. Скачивание и runtime:

```powershell
python scripts/prepare-audio-experimental.py translation-model
docker pull ghcr.io/ggml-org/llama.cpp:server-cuda@sha256:490d8cd8000203a3ab8fdfce14ef931e2aa85affd4dd4447bcc75f299f00fd9a
docker pull python@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70
nvidia-smi
python inference/freeze_profiles.py --check
```

Проверьте, что `docker image inspect` возвращает именно IDs `translation.image` и `translation.clientImage` из lock. Не меняйте GPU-рецепт/модель автоматически при несовпадении; остановитесь и оформите отдельную проверяемую адаптацию. Исполнитель требует подтверждённого GPU offload и показаний температуры: мягкая пауза с 80°C, возобновление после охлаждения до 65°C, жёсткая остановка с 87°C. Неизвестные показатели приостанавливают перевод. Пример запроса: `derived request <book-id> --translate --source-language en --no-audio`; результат — отдельный машинный черновик, а не принятый литературный перевод. Чтобы продолжить озвучкой, потребуется запрос с аудио и русская производная публикация.

## Диагностика и хранение

`docker compose logs --tail=100 app worker parser clamav` показывает серверные ошибки. Не публикуйте сырые логи без удаления логинов, адресов, путей и текста книг. При `RESOURCE_PRESSURE`/`metrics_unknown` проверьте монитор и реальные ресурсы. При `runtime_unavailable` проверьте immutable image ID, при `artifact_changed` — полный файл и SHA, при ожидании антивируса — свежие сигнатуры. Не называйте неполную загрузку завершённой, если часть исходных глав недоступна.

Серверная библиотека и БД находятся в именованных Docker volumes, очередь/квитанции — в `.local`. Простое копирование исходников их не сохраняет. Автоматическое резервное копирование не включено. Для длительного хранения сначала остановите очередь и исполнитель с подтверждением очистки, затем делайте согласованную собственную копию БД и файлов. Исторические backup-скрипты требуют отдельной проверки окружения; их наличие не означает готовую резервную копию.

## Лицензии сторонних компонентов

Исходники проекта распространяются по `LICENSE`; лицензия проекта не покрывает сторонние книги/модели. Закреплённый голос Denis: датасет CC0-1.0; Piper/модельная карточка — отдельные условия upstream. Sherpa ONNX — Apache-2.0, используемый стек включает espeak-ng GPL-3.0-or-later, Piper phonemize MIT и ONNX Runtime MIT. При распространении собранного runtime/нативных библиотек сохраните notices и выполните применимые требования к соответствующим исходникам. Qwen-профиль/веса имеют собственную Apache-2.0. Точные upstream-ссылки и области лицензий сохранены в `experiments/s5/tts/models.lock.json` и `inference/profiles.lock.json`.

Другие экспериментальные голоса не включены по умолчанию: у Ruslan в lock отмечен датасет CC-BY-NC-SA-4.0, у MMS — CC-BY-NC-4.0. Свободная лицензия исходников проекта не снимает эти ограничения. Публикуемая ветка не содержит веса, образы runtime, wheels или чужие тексты книг.
