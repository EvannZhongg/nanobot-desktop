from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def desktop_root() -> Path:
    return Path(__file__).resolve().parents[1]


def resources_root() -> Path:
    return desktop_root() / "src-tauri" / "resources"


def find_python_executable(root: Path) -> Path | None:
    if sys.platform.startswith("win"):
        exe = root / "python.exe"
        return exe if exe.exists() else None
    for name in ("python3", "python"):
        exe = root / "bin" / name
        if exe.exists():
            return exe
    return None


def extract_archive(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive, "r") as zf:
            zf.extractall(dest)
        return
    if archive.suffixes[-2:] == [".tar", ".gz"] or archive.suffix == ".tgz":
        with tarfile.open(archive, "r:gz") as tf:
            tf.extractall(dest)
        return
    raise RuntimeError(f"Unsupported archive format: {archive}")


def prepare_python_runtime(target: Path) -> Path:
    env_path = os.environ.get("NANOBOT_EMBED_PYTHON")
    archive = os.environ.get("NANOBOT_EMBED_PYTHON_ARCHIVE")

    if archive:
        archive_path = Path(archive).expanduser().resolve()
        if not archive_path.exists():
            raise RuntimeError(f"Archive not found: {archive_path}")
        temp = desktop_root() / ".tmp_runtime"
        if temp.exists():
            shutil.rmtree(temp)
        extract_archive(archive_path, temp)
        # use the first directory containing a python executable
        for candidate in temp.iterdir():
            if candidate.is_dir() and find_python_executable(candidate):
                env_path = str(candidate)
                break
        if not env_path and find_python_executable(temp):
            env_path = str(temp)

    if env_path:
        source = Path(env_path).expanduser().resolve()
        if not source.exists():
            raise RuntimeError(f"NANOBOT_EMBED_PYTHON not found: {source}")
    else:
        source = Path(sys.base_prefix).resolve()
        print(
            f"[warn] NANOBOT_EMBED_PYTHON not set, using sys.base_prefix: {source}"
        )

    python_exe = find_python_executable(source)
    if not python_exe:
        raise RuntimeError(f"Python executable not found under: {source}")

    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)

    def ignore(dir_path: str, entries: list[str]) -> list[str]:
        ignored = []
        if "site-packages" in entries:
            ignored.append("site-packages")
        if "__pycache__" in entries:
            ignored.append("__pycache__")
        if "tests" in entries:
            ignored.append("tests")
        if "test" in entries:
            ignored.append("test")
        return ignored

    shutil.copytree(source, target, dirs_exist_ok=True, ignore=ignore)
    return target


def install_dependencies(site_packages: Path) -> None:
    site_packages.mkdir(parents=True, exist_ok=True)
    ensure_pip_available()
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        ".",
        "--target",
        str(site_packages),
    ]
    subprocess.check_call(cmd, cwd=repo_root())

    bridge_src = repo_root() / "bridge"
    bridge_dst = site_packages / "nanobot" / "bridge"
    if bridge_src.exists():
        if bridge_dst.exists():
            shutil.rmtree(bridge_dst)
        shutil.copytree(bridge_src, bridge_dst)


def ensure_pip_available() -> None:
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    try:
        subprocess.check_call(
            [sys.executable, "-m", "ensurepip", "--upgrade"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as exc:
        raise RuntimeError(
            "pip is not available in the current Python and ensurepip failed. "
            "Install pip into the venv or run uv sync again."
        ) from exc

    subprocess.check_call(
        [sys.executable, "-m", "pip", "install", "--upgrade", "pip"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    resources = resources_root()
    if resources.exists():
        shutil.rmtree(resources)
    resources.mkdir(parents=True, exist_ok=True)

    python_target = resources / "python"
    site_packages = resources / "site-packages"

    print(f"[1/3] Preparing embedded python -> {python_target}")
    prepare_python_runtime(python_target)

    print(f"[2/3] Installing nanobot deps -> {site_packages}")
    install_dependencies(site_packages)

    manifest = resources / "runtime_manifest.txt"
    manifest.write_text(
        "\n".join(
            [
                f"python={python_target}",
                f"site-packages={site_packages}",
            ]
        ),
        encoding="utf-8",
    )
    print(f"[3/3] Runtime manifest -> {manifest}")


if __name__ == "__main__":
    main()
