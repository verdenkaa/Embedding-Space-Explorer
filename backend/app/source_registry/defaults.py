"""Default exclusion rules.

- Heavy/service directories are excluded by NAME at any depth.
- Secret-like files are excluded by default; they can be explicitly included
  via user include-patterns, which produces a visible warning.
- Binary detection: known binary extensions + NUL-byte sniff.
"""

from __future__ import annotations

DEFAULT_EXCLUDE_DIRS: frozenset[str] = frozenset(
    {
        # VCS
        ".git",
        ".hg",
        ".svn",
        # dependencies / packaging
        "node_modules",
        "bower_components",
        "site-packages",
        ".eggs",
        # virtualenvs
        ".venv",
        "venv",
        # tool caches
        "__pycache__",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".nox",
        ".cache",
        ".npm",
        ".gradle",
        ".mvn",
        ".turbo",
        ".vite",
        ".parcel-cache",
        # build outputs
        "dist",
        "build",
        "target",
        "out",
        "coverage",
        ".next",
        ".nuxt",
        ".output",
        ".svelte-kit",
        # IDE
        ".idea",
        ".vscode",
    }
)

#: File-name glob patterns (case-insensitive) excluded by default: secrets.
DEFAULT_SECRET_PATTERNS: tuple[str, ...] = (
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.crt",
    "*.cer",
    "*.keystore",
    "id_rsa*",
    "id_dsa*",
    "id_ed25519*",
    "secrets.*",
    "secret.*",
    "credentials.*",
    "serviceaccount*.json",
)

#: Extensions considered binary without reading the file.
BINARY_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".bmp",
        ".ico",
        ".webp",
        ".tif",
        ".tiff",
        ".pdf",
        ".zip",
        ".gz",
        ".tgz",
        ".bz2",
        ".xz",
        ".7z",
        ".rar",
        ".exe",
        ".dll",
        ".so",
        ".dylib",
        ".class",
        ".jar",
        ".war",
        ".mp3",
        ".wav",
        ".ogg",
        ".mp4",
        ".avi",
        ".mov",
        ".mkv",
        ".webm",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
        ".eot",
        ".npy",
        ".npz",
        ".db",
        ".sqlite",
        ".sqlite3",
        ".pyc",
        ".pyo",
        ".pyd",
        ".wasm",
        ".bin",
        ".dat",
        ".pack",
        ".idx",
    }
)

#: Reason codes for skipped files (shown in UI; keep stable).
SKIP_EXCLUDED_DIR = "excluded-dir"
SKIP_EXCLUDED_PATTERN = "excluded-pattern"
SKIP_SECRET = "secret-file"
SKIP_HIDDEN = "hidden"
SKIP_TOO_LARGE = "too-large"
SKIP_BINARY = "binary"
SKIP_SYMLINK_OUTSIDE = "symlink-outside-root"
SKIP_UNREADABLE = "unreadable"
