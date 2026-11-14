"""Exercise checker error handling and Windows file URLs on any host."""

import importlib.util
import nturl2path
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

checker = Path(__file__).resolve().parents[2] / "scripts" / "check-docs.py"
spec = importlib.util.spec_from_file_location("checker", checker)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def failed_walk(root, onerror):
    onerror(PermissionError("unreadable directory"))
    return []


with patch.object(module.os, "walk", failed_walk):
    assert not module.validate(Path("."))

# Use the Windows stdlib converter and path class on Linux too.
with (
    patch.object(module, "url2pathname", nturl2path.url2pathname),
    patch.object(module, "Path", PureWindowsPath),
    patch.object(module, "contained", return_value=True) as contained,
):
    assert module.link_exists(
        "file:///C:/checkout/some%20file.md",
        PureWindowsPath("C:/checkout/README.md"),
        PureWindowsPath("C:/checkout"),
    )
    assert contained.call_args.args[0] == PureWindowsPath("C:/checkout/some file.md")
