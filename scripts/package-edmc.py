"""Build an installable ZIP, excluding local queues and credentials."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
source = root / "edmc" / "Moonshield"
output = root / "artifacts" / "Moonshield-EDMC.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name in ("__init__.py", "load.py", "moonshield_core.py", "README.md"):
        archive.write(source / name, "Moonshield/" + name)
print(output)
