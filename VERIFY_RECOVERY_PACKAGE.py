#!/usr/bin/env python3
import hashlib, json, pathlib, sys

root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/"PACKAGE_MANIFEST.json").read_text(encoding="utf-8"))

missing=[p for p in manifest["required_paths"] if not (root/p).exists()]
if missing:
    print("MISSING:",*missing,sep="\n- ")
    sys.exit(1)

bad=[]
for line in (root/"PACKAGE_SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
    if not line.strip():
        continue
    expected,path=line.split("  ",1)
    f=root/path
    if not f.exists():
        bad.append(path+" (missing)")
        continue
    actual=hashlib.sha256(f.read_bytes()).hexdigest()
    if actual!=expected:
        bad.append(path+" (checksum mismatch)")

if bad:
    print("CHECKSUM FAILED:",*bad,sep="\n- ")
    sys.exit(1)

print("MS007 recovery package verification passed.")
print("System source commit:",manifest["system_source_commit"])
