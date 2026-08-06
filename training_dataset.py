"""Compatibility alias for the reorganized implementation module."""

from importlib import import_module as _import_module
import sys as _sys

_impl = _import_module("arena_hero_tactic.training.dataset")
if __name__ == "__main__" and hasattr(_impl, "main"):
    raise SystemExit(_impl.main())
_sys.modules[__name__] = _impl