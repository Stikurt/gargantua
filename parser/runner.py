"""Bounded attempt-scoped parser runner. Never takes storage roots from a job."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from sandbox import SandboxError, parse_isolated

MAX_JOB_BYTES = 16 * 1024
MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_RESULT_BYTES = 25 * 1024 * 1024
CHILD_TIMEOUT = 40
MAX_PENDING_BATCH = 100
TOKEN_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
SHA_RE = re.compile(r'[0-9a-f]{64}')


class JobError(ValueError):
    def __init__(self, code, message, sha256=None):
        super().__init__(message)
        self.code = code
        self.sha256 = sha256


@dataclass(frozen=True)
class RunnerConfig:
    # Only the owner/process CLI or tests choose these roots, never job JSON.
    quarantine_root: Path = Path('/quarantine')
    jobs_root: Path = Path('/jobs')

    def __post_init__(self):
        object.__setattr__(self, 'quarantine_root', Path(self.quarantine_root).resolve())
        object.__setattr__(self, 'jobs_root', Path(self.jobs_root).resolve())

    @property
    def pending(self):
        return self.jobs_root / 'pending'

    @property
    def results(self):
        return self.jobs_root / 'results'


def valid_token(value):
    return isinstance(value, str) and TOKEN_RE.fullmatch(value) is not None and str(uuid.UUID(value)) == value


@contextmanager
def directory_handle(directory):
    """Pin the known immediate directory on POSIX; refuse symlink scopes."""
    fd = None
    try:
        if not stat.S_ISDIR(directory.lstat().st_mode):
            raise JobError('UNSAFE_DIRECTORY', 'Небезопасный каталог задачи')
        if os.name == 'posix':
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        yield fd
    except OSError as exc:
        raise JobError('STORAGE_UNAVAILABLE', 'Хранилище задачи недоступно') from exc
    finally:
        if fd is not None:
            os.close(fd)


def relative_stat(directory, name, dir_fd):
    if dir_fd is not None:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    return (directory / name).lstat()


def read_regular(directory, name, limit):
    # All callers construct name from a validated token, not a user path.
    with directory_handle(directory) as dir_fd:
        before = relative_stat(directory, name, dir_fd)
        if not stat.S_ISREG(before.st_mode):
            raise JobError('UNSAFE_FILE', 'Задача и её вход должны быть обычными файлами без ссылок')
        if before.st_size > limit:
            raise JobError('FILE_TOO_LARGE', 'Файл задачи превышает установленный лимит')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
        fd = os.open(name if dir_fd is not None else directory / name, flags, **({'dir_fd': dir_fd} if dir_fd is not None else {}))
        with os.fdopen(fd, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise JobError('INPUT_CHANGED', 'Файл задачи изменился во время открытия')
            data = stream.read(limit + 1)
            after = os.fstat(stream.fileno())
        if len(data) > limit:
            raise JobError('FILE_TOO_LARGE', 'Файл задачи превышает установленный лимит')
        if (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != after.st_size:
            raise JobError('INPUT_CHANGED', 'Файл задачи изменился во время чтения')
        return data


def job_token(job, config):
    path = Path(job)
    if path.suffix != '.json' or not valid_token(path.stem) or '..' in path.parts:
        raise JobError('INVALID_JOB_PATH', 'Некорректное имя задачи')
    if path.parent != Path('.') and path.absolute() != config.pending / path.name:
        raise JobError('INVALID_JOB_PATH', 'Задача находится вне разрешённого каталога')
    return path.stem


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise JobError('INVALID_SPEC', 'Повторяющиеся поля в задаче')
        result[key] = value
    return result


def read_spec(token, config):
    raw = read_regular(config.pending, token + '.json', MAX_JOB_BYTES)
    try:
        spec = json.loads(raw.decode('utf-8'), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise JobError('INVALID_SPEC', 'Некорректный JSON задачи') from exc
    allowed = {'id', 'inputId', 'inputScope', 'inputSha256', 'extension', 'filename'}
    if not isinstance(spec, dict) or not set(spec) <= allowed or spec.get('id') != token:
        raise JobError('INVALID_SPEC', 'Некорректная привязка задачи')
    filename = spec.get('filename')
    if spec.get('extension') not in ('epub', 'fb2', 'txt', 'ranobe') or not isinstance(filename, str) or not 1 <= len(filename) <= 300 or any(ord(c) < 32 or ord(c) == 127 for c in filename):
        raise JobError('INVALID_SPEC', 'Некорректный формат или имя книги')
    if 'inputScope' in spec or 'inputId' in spec:
        if spec.get('inputScope') != 'attempts' or spec.get('inputId') != token or not valid_token(spec.get('inputId')):
            raise JobError('INVALID_SPEC', 'Некорректная область или привязка входа')
        scope = 'attempts'
        if not isinstance(spec.get('inputSha256'), str) or SHA_RE.fullmatch(spec['inputSha256']) is None:
            raise JobError('INVALID_SPEC', 'Для попытки требуется SHA-256 входа')
    else:
        # Compatibility only for legacy in-flight jobs. Explicit scope=incoming
        # or a partial new spec cannot silently fall back to this path.
        scope = 'incoming'
        if 'inputSha256' in spec and (not isinstance(spec['inputSha256'], str) or SHA_RE.fullmatch(spec['inputSha256']) is None):
            raise JobError('INVALID_SPEC', 'Некорректный SHA-256 входа')
    return spec, scope


def process(job, config=None):
    config = config or RunnerConfig()
    token = job_token(job, config)
    spec, scope = read_spec(token, config)
    data = read_regular(config.quarantine_root / scope, token, MAX_INPUT_BYTES)
    digest = hashlib.sha256(data).hexdigest()
    if spec.get('inputSha256', digest) != digest:
        raise JobError('INPUT_HASH_MISMATCH', 'Хеш входа не соответствует попытке; разбор запрещён', digest)
    try:
        # This trusted process alone sees job/storage paths. The untrusted
        # decoder receives only one bounded byte stream and returns inert JSON.
        book = parse_isolated(data, spec['extension'], spec['filename'])
    except SandboxError as exc:
        messages = {
            'SANDBOX_UNAVAILABLE': 'Изоляция проверки недоступна; разбор запрещён',
            'SANDBOX_FAILED': 'Изолированная проверка не предоставила допустимый результат',
            'PARSER_TIMEOUT': 'Превышено время изолированной проверки',
            'RESULT_TOO_LARGE': 'Результат превышает установленный лимит',
            'PARSER_REJECTED': 'Проверка структуры или содержимого книги не пройдена',
        }
        code = exc.code if exc.code in messages else 'SANDBOX_FAILED'
        raise JobError(code, messages[code], digest) from exc
    except Exception as exc:
        # Do not echo arbitrary decoder messages, paths or input bytes to clients.
        raise JobError('PARSER_REJECTED', 'Проверка структуры или содержимого книги не пройдена', digest) from exc
    return {'attemptToken': token, 'book': book, 'sha256': digest}


def result_exists(token, config):
    with directory_handle(config.results) as dir_fd:
        try:
            info = relative_stat(config.results, token + '.json', dir_fd)
        except FileNotFoundError:
            return False
        return stat.S_ISREG(info.st_mode) and info.st_size <= MAX_RESULT_BYTES


def job_marker(token, config):
    # Metadata only: the parent never opens/parses arbitrary pending JSON.
    with directory_handle(config.pending) as dir_fd:
        try:
            info = relative_stat(config.pending, token + '.json', dir_fd)
        except FileNotFoundError:
            return None
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, stat.S_IFMT(info.st_mode))


def write_result(token, result, config, expected_job_marker=None):
    if not valid_token(token) or result.get('attemptToken') != token:
        raise JobError('INVALID_RESULT', 'Некорректная привязка результата')
    data = json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if len(data) > MAX_RESULT_BYTES:
        raise JobError('RESULT_TOO_LARGE', 'Результат превышает установленный лимит')
    name = token + '.json'
    temp = token + '.' + uuid.uuid4().hex + '.tmp'
    with directory_handle(config.results) as dir_fd:
        kwargs = {'dir_fd': dir_fd} if dir_fd is not None else {}
        path = lambda item: item if dir_fd is not None else config.results / item
        fd = os.open(path(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600, **kwargs)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # Best effort against cancellation/reconciliation. The worker still
            # fences results by the never-reused token and exact raw input hash.
            if expected_job_marker is not None and job_marker(token, config) != expected_job_marker:
                return False
            if dir_fd is not None:
                os.replace(temp, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
                os.fsync(dir_fd)
            else:
                # Windows tests cannot provide POSIX directory-fsync semantics.
                os.replace(config.results / temp, config.results / name)
        finally:
            try:
                os.unlink(path(temp), **kwargs)
            except FileNotFoundError:
                pass
    return True


def error_result(token, code, message, sha256=None):
    result = {'ok': False, 'attemptToken': token, 'errorCode': code, 'error': message}
    if sha256 is not None:
        result['sha256'] = sha256
    return result


def run_job(token, config):
    if not valid_token(token):
        raise JobError('INVALID_JOB_PATH', 'Некорректное имя задачи')
    if result_exists(token, config):
        return
    marker = job_marker(token, config)
    if marker is None:
        return
    try:
        result = {'ok': True, **process(token + '.json', config)}
    except JobError as exc:
        result = error_result(token, exc.code, str(exc), exc.sha256)
    except Exception:
        result = error_result(token, 'RUNNER_FAILED', 'Обработчик задачи не завершил проверку')
    write_result(token, result, config, marker)


def run_pending_once(config, run_child=None):
    run_child = run_child or subprocess.run
    handled = 0
    with directory_handle(config.pending):
        with os.scandir(config.pending) as pending:
            for entry in pending:
                if not entry.name.endswith('.json') or not valid_token(entry.name[:-5]):
                    continue
                token = entry.name[:-5]
                if result_exists(token, config):
                    continue
                marker = job_marker(token, config)
                if marker is None:
                    continue
                command = [sys.executable, '-B', str(Path(__file__).resolve()), '--job', token,
                           '--quarantine-root', str(config.quarantine_root), '--jobs-root', str(config.jobs_root)]
                try:
                    # Parent never opens job JSON or input files. Each child owns
                    # one attempt, with no unbounded stdout/stderr accumulation.
                    run_child(command, timeout=CHILD_TIMEOUT, check=True, stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    code, message = 'CHILD_NO_RESULT', 'Обработчик не предоставил результат проверки'
                except subprocess.TimeoutExpired:
                    code, message = 'PARSER_TIMEOUT', 'Превышено время изолированной проверки'
                except (subprocess.CalledProcessError, OSError):
                    code, message = 'CHILD_FAILED', 'Изолированный обработчик завершился с ошибкой'
                # A child can exit after publishing. Preserve its committed
                # result instead of changing a completed attempt into failure.
                if not result_exists(token, config):
                    write_result(token, error_result(token, code, message), config, marker)
                handled += 1
                if handled >= MAX_PENDING_BATCH:
                    break
    return handled


def main(argv=None):
    cli = argparse.ArgumentParser(description='Изолированный обработчик задач библиотеки')
    cli.add_argument('--job', help='Один canonical UUID токен; без параметра — цикл ожидания')
    cli.add_argument('--quarantine-root', type=Path, default=Path('/quarantine'))
    cli.add_argument('--jobs-root', type=Path, default=Path('/jobs'))
    args = cli.parse_args(argv)
    config = RunnerConfig(args.quarantine_root, args.jobs_root)
    if args.job is not None:
        run_job(args.job, config)
        return 0
    while True:
        run_pending_once(config)
        time.sleep(1)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except JobError:
        # No traceback or storage paths in daemon/child logs. Parent publishes
        # a safe attempt-bound failure if a child cannot write its own result.
        raise SystemExit(1)
