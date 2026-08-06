"""Small filesystem lock used to keep one live process per workspace."""

from __future__ import annotations

import ctypes
import os
from pathlib import Path


class InstanceAlreadyRunning(RuntimeError):
    """Raised when another live process owns the lock file."""

    def __init__(self, path: Path, owner_pid: int | None) -> None:
        self.path = path
        self.owner_pid = owner_pid
        owner = f" (pid {owner_pid})" if owner_pid is not None else ""
        super().__init__(f"another process already owns {path}{owner}")


def _process_exists(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        process_query_limited_information = 0x1000
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [
            ctypes.c_uint32,
            ctypes.c_int,
            ctypes.c_uint32,
        ]
        kernel32.OpenProcess.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        handle = kernel32.OpenProcess(
            process_query_limited_information,
            0,
            pid,
        )
        if not handle:
            return False
        kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except (OSError, ProcessLookupError):
        return False
    return True


class SingleInstanceLock:
    """Acquire an exclusive lock and remove stale locks after a crash."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path).expanduser()
        self._owned = False

    def _owner_pid(self) -> int | None:
        try:
            raw = self.path.read_text(encoding="ascii").strip()
            return int(raw) if raw else None
        except (OSError, TypeError, ValueError):
            return None

    def acquire(self) -> "SingleInstanceLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(
                    self.path,
                    os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                )
            except FileExistsError:
                owner_pid = self._owner_pid()
                if owner_pid is not None and _process_exists(owner_pid):
                    raise InstanceAlreadyRunning(self.path, owner_pid)
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    continue
                continue
            with os.fdopen(descriptor, "w", encoding="ascii") as handle:
                handle.write(f"{os.getpid()}\n")
            self._owned = True
            return self
        raise InstanceAlreadyRunning(self.path, self._owner_pid())

    def release(self) -> None:
        if not self._owned:
            return
        try:
            if self._owner_pid() == os.getpid():
                self.path.unlink()
        except FileNotFoundError:
            pass
        finally:
            self._owned = False

    def __enter__(self) -> "SingleInstanceLock":
        return self.acquire()

    def __exit__(self, *_: object) -> None:
        self.release()
