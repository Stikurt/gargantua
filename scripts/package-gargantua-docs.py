"""Package documentation and a separate, source-only review toolkit.

This builds release archives, not a server, client application or database backup.
Run explicitly after documentation/review inputs have been finalized.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "docs/gargantua"
RELEASE = ROOT / "releases/Gargantua-Documentation"
RELEASE_DATE = "2026-10-24"
DOC_ARCHIVE = f"Gargantua-technical-project-{RELEASE_DATE}.zip"
TOOLS_ARCHIVE = f"Gargantua-review-tools-{RELEASE_DATE}.zip"
DOC_PREFIX = "Gargantua-documentation/"
TOOLS_PREFIX = "Gargantua-review-tools/"

# Preserve the documentation archive's previous scope and directory structure.
# These are intermediate broad-research payloads, not the published reports.
DOC_EXCLUDE = {
    "projects-evidence.json", "projects-feedback.json", "projects-detailed.json",
    "projects-reviewed.json", "shortlist.json", "candidates.json",
}

# An explicit allowlist keeps production code, credentials, caches, books,
# external-dependency API validators and generated test data out of this ZIP.
TOOLS_SOURCES = (
    "scripts/simulate-library-pipeline.py",
    "scripts/probe-storage-durability.py",
    "scripts/catalog-discovery.py",
    "scripts/catalog.ps1",
    "scripts/CATALOG_DISCOVERY_USAGE.md",
    "tests/test_pipeline_simulation.py",
    "tests/test_storage_durability.py",
    "tests/test_catalog_discovery.py",
    "docs/gargantua/examples/catalogs/warriors-first-arc-order.json",
)

TOOLS_README = """# Gargantua review tools

Самостоятельные исходники проверок и metadata-пилота. Это **не сервер, APK/EXE,
parser книг или backup библиотеки**. Распакуйте в отдельную папку; команды
ниже выполняются из `Gargantua-review-tools`, где находятся `scripts` и `tests`.
Рабочие данные, пароли, сессии, модели и книги в архив не входят.

## Зависимости

Python **3.10+**, только стандартная библиотека, включая `sqlite3` (обычная
сборка CPython). Docker, Node, GPU, аккаунт и `pip install` не нужны.
На Windows можно заменить `python` на `py -3`. Необязательная Windows
PowerShell-обёртка `./scripts/catalog.ps1 --help` ищет готовый интерпретатор
и ничего не устанавливает; прямой вызов Python работает без неё.

## Проверки без сети

```text
python -m unittest discover -s tests -p test_pipeline_simulation.py -v
python -m unittest discover -s tests -p test_storage_durability.py -v
python -m unittest discover -s tests -p test_catalog_discovery.py -v
```

Отдельные отчёты:
```text
python scripts/simulate-library-pipeline.py --seeds 64 --output .local/review-output/simulation-results.json
python scripts/probe-storage-durability.py --help
python scripts/probe-storage-durability.py
```

Симуляция проверяет конечную модель, а не production-код. Storage probe
действительно аварийно завершает свои дочерние процессы и проверяет файлы/
SQLite. Это не power-loss, PostgreSQL или APK/EXE тест. Его отчёт создаётся в
`docs/gargantua/research/storage-durability-results.json` **распакованной папки**,
временные данные — в собственной `.local/temp/storage-durability-probe-*`;
по умолчанию они убираются, `--keep` оставляет их. Catalog tests используют
fixtures/mocks без сети и свою временную подпапку в `tests`. Внутренние
`--child`/`--cursor-child` вручную не вызывайте.

## Необязательная живая проверка metadata

Требуется HTTPS к публичному JSON API Open Library. Только библиографические
метаданные; тексты, обложки и архивы не скачиваются, сервер/БД не используются.

```text
python scripts/catalog-discovery.py --help
python scripts/catalog-discovery.py author "Arthur C. Clarke" --limit 20 --max-requests 3 --timeout 20 --output .local/review-output/clarke-candidates
python scripts/catalog-discovery.py series "Warriors" --alias "Коты-воители" --curated-order docs/gargantua/examples/catalogs/warriors-first-arc-order.json --limit 20 --max-requests 3 --timeout 20 --output .local/review-output/warriors-first-arc
```

После успешного сетевого запроса тот же запрос можно повторить по кешу:
```text
python scripts/catalog-discovery.py author "Arthur C. Clarke" --limit 20 --max-requests 3 --timeout 20 --offline --output .local/review-output/clarke-candidates-cached
```

Новый `--output` содержит JSON/HTML/Markdown; для намеренной замены нужен
`--overwrite`. По умолчанию кеш — `.local/catalog-discovery-cache`.
`needs-clarification` требует выбора автора человеком; первый ID не выбирается
молча. Seed — шесть романов первого цикла Warriors, не вся франшиза и не
доказательство доступного текста. Сопоставления Work остаются кандидатными;
публикационный порядок не равен сюжетной хронологии. Сетевые лимиты/ошибки
могут дать частичный результат или отсутствие отчёта. Не обходите лимиты
параллельными копиями. Полные параметры и коды завершения:
[CATALOG_DISCOVERY_USAGE.md](scripts/CATALOG_DISCOVERY_USAGE.md).

`FILE_MANIFEST.json` содержит размеры/SHA-256 файлов. Внешние `SHA256.txt` и
`build-info.json` отдельно описывают архив документов и этот набор.
ZIP CRC/manifest проверяют целостность упаковки, **не прохождение тестов или
готовность продукта**. Фиксируйте фактический результат своего запуска.
API validators с внешними зависимостями в набор не включены.
"""


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def documentation_payloads() -> dict[str, bytes]:
    return {
        path.relative_to(DOC).as_posix(): path.read_bytes()
        for path in sorted(DOC.rglob("*"))
        if path.is_file() and path.name not in DOC_EXCLUDE
    }


def review_tool_payloads() -> dict[str, bytes]:
    result = {}
    for relative in TOOLS_SOURCES:
        source = ROOT / relative
        if not source.is_file() or not source.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError(f"Missing or out-of-workspace review input: {relative}")
        result[relative] = source.read_bytes()
    result["README.md"] = TOOLS_README.encode("utf-8")
    return result


def build_archive(name: str, prefix: str, payloads: dict[str, bytes], scope: str) -> dict:
    manifest = {
        relative: {"bytes": len(payload), "sha256": sha256(payload)}
        for relative, payload in sorted(payloads.items())
    }
    archive = RELEASE / name
    temporary = archive.with_suffix(archive.suffix + ".tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for relative, payload in sorted(payloads.items()):
            bundle.writestr(prefix + relative, payload)
        bundle.writestr(
            prefix + "FILE_MANIFEST.json",
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        )
    with zipfile.ZipFile(temporary) as bundle:
        damaged = bundle.testzip()
        if damaged is not None:
            raise ValueError(f"ZIP CRC validation failed: {damaged}")
        expected = {prefix + relative for relative in manifest}
        expected.add(prefix + "FILE_MANIFEST.json")
        if set(bundle.namelist()) != expected:
            raise ValueError(f"Unexpected archive contents: {name}")
        for relative, metadata in manifest.items():
            payload = bundle.read(prefix + relative)
            if len(payload) != metadata["bytes"] or sha256(payload) != metadata["sha256"]:
                raise ValueError(f"Archive manifest mismatch: {relative}")
        if json.loads(bundle.read(prefix + "FILE_MANIFEST.json")) != manifest:
            raise ValueError(f"Embedded manifest mismatch: {name}")
    temporary.replace(archive)
    return {
        "name": name,
        "entryRoot": prefix.rstrip("/"),
        "files": len(manifest),
        "bytes": archive.stat().st_size,
        "sha256": sha256(archive.read_bytes()),
        "validatedArchive": True,
        "validation": ["ZIP CRC", "entry allowlist", "per-file bytes and SHA-256", "embedded manifest"],
        "scope": scope,
    }


def main() -> None:
    # Read/validate all inputs before touching either release archive. A snapshot
    # of bytes also prevents source edits during packaging from invalidating hashes.
    documents = documentation_payloads()
    tools = review_tool_payloads()
    if not documents:
        raise ValueError("No documentation files found")
    RELEASE.mkdir(parents=True, exist_ok=True)
    docs_info = build_archive(
        DOC_ARCHIVE, DOC_PREFIX, documents,
        "Техническая документация; не сборка приложения и не резервная копия БД",
    )
    tools_info = build_archive(
        TOOLS_ARCHIVE, TOOLS_PREFIX, tools,
        "Исходники инструментов проверки/metadata-пилота; не сервер, parser книг или APK/EXE",
    )
    archives = [dict(kind="documentation", **docs_info), dict(kind="review-tools", **tools_info)]
    (RELEASE / "SHA256.txt").write_text(
        "".join(f"{item['sha256']}  {item['name']}\n" for item in archives),
        encoding="utf-8",
    )
    # Keep the previous document-only fields for consumers of build-info.json;
    # the archives array is authoritative for the two distinct deliverables.
    build_info = {
        "title": "Гаргантюа — персональная библиотека",
        "date": RELEASE_DATE,
        "primaryArchive": DOC_ARCHIVE,
        "documentFiles": len(documents),
        "bytes": docs_info["bytes"],
        "sha256": docs_info["sha256"],
        "validatedArchive": docs_info["validatedArchive"] and tools_info["validatedArchive"],
        "scope": "Документация и отдельные review tools; не сборка сервера/клиента или backup",
        "archiveCount": len(archives),
        "totalArchiveBytes": sum(item["bytes"] for item in archives),
        "archives": archives,
    }
    (RELEASE / "build-info.json").write_text(
        json.dumps(build_info, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
    )
    for item in archives:
        print(f"Packaged {item['kind']}: {item['files']} files; ZIP bytes: {item['bytes']}; SHA256: {item['sha256']}")


if __name__ == "__main__":
    main()
