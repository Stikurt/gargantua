"""Fail-closed Linux parse boundary: one bounded input/output pipe, no job paths.

The trusted runner alone reads quarantine and commits results. This process
receives bytes, not a pathname. Landlock limits runtime reads and private scratch
space; seccomp closes Landlock's metadata/IPC gaps. Outer Docker isolation is
still required. Neither policy is a claim of immunity to kernel vulnerabilities.
UAPI: docs.kernel.org/userspace-api/{landlock,seccomp_filter}.html
"""
import codecs
import ctypes
import errno
import json
import os
import platform
import signal
import stat
import subprocess
import sys
import sysconfig
import tempfile
import threading
from pathlib import Path

MAX_INPUT_BYTES = 20 * 1024 * 1024
MAX_OUTPUT_BYTES = 25 * 1024 * 1024
MAX_HEADER_BYTES = 4096
PARSE_TIMEOUT = 35  # The outer runner's 40s deadline also covers setup/commit.
READ = (1 << 2) | (1 << 3)
SCRATCH = READ | (1 << 1) | (1 << 4) | (1 << 5) | (1 << 7) | (1 << 8) | (1 << 14)


class SandboxError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Ruleset(ctypes.Structure):
    _fields_ = [('handled_access_fs', ctypes.c_uint64),
                ('handled_access_net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]


class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('allowed_access', ctypes.c_uint64), ('parent_fd', ctypes.c_int32)]


class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]


class FilterProgram(ctypes.Structure):
    _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]


def architecture():
    if sys.platform != 'linux' or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    machine = platform.machine()
    if machine == 'x86_64':
        # Explicit native-64 allowlist, all other syscalls return EPERM. In
        # particular no socket/IPC/fork/exec/ptrace/chmod/chown/xattr/io_uring.
        return 0xC000003E, {
            0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20,
            21, 24, 25, 28, 32, 33, 39, 60, 72, 74, 75, 76, 77, 79, 82, 83, 84,
            87, 89, 96, 97, 98, 102, 104, 107, 108, 110, 131, 186, 201, 202, 217,
            218, 228, 231, 257, 258, 262, 263, 264, 267, 269, 273, 292, 318,
            332, 334,
        }
    # Other architectures require their own reviewed and exercised syscall
    # table. They must not inherit x86 numbers or silently lose restrictions.
    raise SandboxError('SANDBOX_UNAVAILABLE')


def landlock_abi():
    architecture()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    abi = libc.syscall(444, 0, 0, 1)
    if abi < 3:  # TRUNCATE must be mediated; no unrestricted fallback.
        raise SandboxError('SANDBOX_UNAVAILABLE')
    return abi


def _call(libc, number, *args):
    value = libc.syscall(number, *args)
    if value < 0:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    return value


def _seccomp(libc, arch, allowed):
    # Check architecture before syscall number; x32 numbers are absent from
    # the allowlist. Unknown future syscalls fail closed as well.
    instructions = [Filter(0x20, 0, 0, 4), Filter(0x15, 1, 0, arch),
                    Filter(0x06, 0, 0, 0x80000000), Filter(0x20, 0, 0, 0)]
    for number in sorted(allowed):
        instructions.extend((Filter(0x15, 0, 1, number), Filter(0x06, 0, 0, 0x7FFF0000)))
    instructions.append(Filter(0x06, 0, 0, 0x00050000 | errno.EPERM))
    array = (Filter * len(instructions))(*instructions)
    program = FilterProgram(len(array), array)
    if libc.prctl(22, 2, ctypes.byref(program), 0, 0) != 0:
        raise SandboxError('SANDBOX_UNAVAILABLE')


def runtime_read_paths():
    """Interpreter-owned paths, never environment variables or job metadata."""
    paths = sysconfig.get_paths()
    return tuple(sorted({str(Path(paths[key]).resolve()) for key in
                         ('stdlib', 'platstdlib', 'purelib', 'platlib')}))


def restrict_process(scratch, *, read_paths=None):
    """Irreversibly restrict this disposable, single-threaded non-root process.

    read_paths is internal test configuration. The production call only uses
    runtime_read_paths(); no CLI/job can grant additional files or directories.
    No quarantine/jobs/library/DB directory is granted at all.
    """
    arch, allowed = architecture()
    if os.geteuid() == 0 or len(os.listdir('/proc/self/task')) != 1:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    abi = landlock_abi()
    scratch = Path(scratch)
    info = scratch.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    # Close ambient descriptors before applying any policy. Only private stdin,
    # stdout and stderr remain; Popen(close_fds=True) is a second boundary.
    import resource
    soft, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
    os.closerange(3, min(int(soft), 1_048_576))
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise SandboxError('SANDBOX_UNAVAILABLE')
    handled = (1 << (16 if abi >= 5 else 15)) - 1
    if abi >= 9:
        handled |= 1 << 16  # RESOLVE_UNIX
    ruleset = Ruleset(handled, (3 if abi >= 4 else 0) | (12 if abi >= 10 else 0),
                      3 if abi >= 6 else 0)
    size = 24 if abi >= 6 else (16 if abi >= 4 else 8)
    descriptor = _call(libc, 444, ctypes.byref(ruleset), size, 0)
    try:
        paths = [(p, READ) for p in (runtime_read_paths() if read_paths is None else read_paths)]
        paths.append((scratch, SCRATCH))
        for path, access in paths:
            fd = os.open(path, os.O_PATH | os.O_CLOEXEC | os.O_NOFOLLOW)
            try:
                mode = os.fstat(fd).st_mode
                if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                    raise SandboxError('SANDBOX_UNAVAILABLE')
                rule = PathRule(access if stat.S_ISDIR(mode) else access & ~(1 << 3), fd)
                _call(libc, 445, descriptor, 1, ctypes.byref(rule), 0)
            finally:
                os.close(fd)
        _call(libc, 446, descriptor, 0)
    finally:
        os.close(descriptor)
    # This must also succeed; a Landlock-only partial policy is not accepted.
    _seccomp(libc, arch, allowed)
    return abi


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate key')
        result[key] = value
    return result


def bounded_exchange(command, header, data, *, timeout=PARSE_TIMEOUT, limit=MAX_OUTPUT_BYTES):
    """Bound both pipe directions; never accumulate capture_output unchecked."""
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, close_fds=True,
                               env={'LANG': 'C.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'})
    output = bytearray()
    errors = []

    def send():
        try:
            for value in (header, data):
                process.stdin.write(value)
            process.stdin.close()
        except (OSError, ValueError):
            pass  # A rejected/terminated child may close its input immediately.

    def receive():
        try:
            while True:
                chunk = process.stdout.read(min(64 * 1024, limit + 1 - len(output)))
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > limit:
                    errors.append('RESULT_TOO_LARGE')
                    process.kill()
                    break
        except (OSError, ValueError):
            errors.append('SANDBOX_FAILED')

    writer = threading.Thread(target=send, daemon=True)
    reader = threading.Thread(target=receive, daemon=True)
    writer.start(); reader.start()
    try:
        process.wait(timeout=timeout)
        reader.join(timeout=1)
        writer.join(timeout=1)
        if reader.is_alive() or writer.is_alive():
            raise SandboxError('SANDBOX_FAILED')
        if errors:
            raise SandboxError(errors[0])
        if process.returncode != 0:
            raise SandboxError('SANDBOX_FAILED')
        return bytes(output)
    except subprocess.TimeoutExpired as exc:
        raise SandboxError('PARSER_TIMEOUT') from exc
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        writer.join(timeout=1); reader.join(timeout=1)
        process.stdin.close(); process.stdout.close()


def parse_isolated(data, extension, filename):
    architecture()  # Windows/unsupported hosts cannot silently parse unrestricted.
    if len(data) > MAX_INPUT_BYTES:
        raise SandboxError('FILE_TOO_LARGE')
    header = json.dumps({'extension': extension, 'filename': filename}, ensure_ascii=False).encode() + b'\n'
    if len(header) > MAX_HEADER_BYTES:
        raise SandboxError('INVALID_SPEC')
    with tempfile.TemporaryDirectory(prefix='gargantua-parse-') as scratch:
        command = [sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--parse', scratch, str(os.getpid())]
        raw = bounded_exchange(command, header, data)
    try:
        result = json.loads(raw, object_pairs_hook=_unique_object,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite')))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise SandboxError('SANDBOX_FAILED') from exc
    if isinstance(result, dict) and result.get('ok') is True and set(result) == {'ok', 'book'} and isinstance(result['book'], dict):
        return result['book']
    if isinstance(result, dict) and result.get('ok') is False and set(result) == {'ok', 'errorCode'} and result['errorCode'] in ('SANDBOX_UNAVAILABLE', 'PARSER_REJECTED'):
        raise SandboxError(result['errorCode'])
    raise SandboxError('SANDBOX_FAILED')


def _prepare_child(scratch, expected_parent):
    # A killed supervisor must not leave a parse worker holding the pipes open.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != expected_parent:
        raise SandboxError('SANDBOX_UNAVAILABLE')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from safe_parser import parse_book
    from PIL import Image
    Image.init()  # Load trusted decoder plugins before handling input bytes.
    for encoding in ('utf-8-sig', 'utf-8', 'cp1251'):
        codecs.lookup(encoding)
    scratch = Path(scratch).resolve(strict=True)
    os.chdir(scratch)
    os.environ.clear()
    os.environ.update(LANG='C.UTF-8', TMPDIR=str(scratch))
    tempfile.tempdir = str(scratch)
    restrict_process(scratch)
    return parse_book


def child_main(scratch, expected_parent):
    try:
        parse_book = _prepare_child(scratch, expected_parent)
    except Exception as exc:
        # Kernel/policy/import/runtime failures are setup failures, distinct
        # from a book rejected after isolation. No input is consumed here.
        raise SandboxError('SANDBOX_UNAVAILABLE') from exc
    # No bytes from the untrusted book are consumed before both OS policies.
    header = sys.stdin.buffer.readline(MAX_HEADER_BYTES + 1)
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(header) > MAX_HEADER_BYTES or not header.endswith(b'\n') or len(data) > MAX_INPUT_BYTES:
        raise ValueError('Input limit')
    spec = json.loads(header, object_pairs_hook=_unique_object)
    if not isinstance(spec, dict) or set(spec) != {'extension', 'filename'} or spec['extension'] not in ('txt', 'epub', 'fb2', 'ranobe') or not isinstance(spec['filename'], str) or not 1 <= len(spec['filename']) <= 300:
        raise ValueError('Invalid input metadata')
    book = parse_book(data, spec['extension'], spec['filename'])
    value = json.dumps({'ok': True, 'book': book}, ensure_ascii=False, allow_nan=False).encode()
    if len(value) > MAX_OUTPUT_BYTES:
        raise ValueError('Output limit')
    sys.stdout.buffer.write(value)
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4 or sys.argv[1] != '--parse' or not sys.argv[3].isdigit():
            raise SandboxError('SANDBOX_UNAVAILABLE')
        child_main(sys.argv[2], int(sys.argv[3]))
    except Exception as exc:
        code = 'SANDBOX_UNAVAILABLE' if isinstance(exc, SandboxError) else 'PARSER_REJECTED'
        # No decoder message, host path, input bytes or environment in output.
        sys.stdout.write(json.dumps({'ok': False, 'errorCode': code}))
