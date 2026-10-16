#!/usr/bin/env python3
"""Prepare the existing native notice collector's inputs without building or fetching.

Requires Python 3.11+. Cargo metadata, compiler JSON, and fingerprint formats are
validated conservatively; an unsupported or ambiguous artifact fails closed.
"""
import argparse
from collections import defaultdict, deque
import hashlib
import json
from pathlib import Path
import re
import stat
import sys
if sys.version_info < (3, 11):
    raise SystemExit("Native notice preparation requires Python 3.11 or newer (macOS system Python may be older).")
import tomllib

TARGET = "aarch64-apple-darwin"
ROOT_PACKAGES = {"gateway": "meerkat-desktop-stdio", "resourceMonitor": "t3-resource-monitor"}
HASH = re.compile(r"[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular(path):
    path = Path(path)
    require(stat.S_ISREG(path.lstat().st_mode), f"Expected regular file: {path}")
    return path.read_bytes()


def digest(path):
    path = Path(path)
    require(stat.S_ISREG(path.lstat().st_mode), f"Expected regular file: {path}")
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(data)
    return h.hexdigest()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value):
    require(isinstance(value, str) and value and "\\" not in value and "\0" not in value
            and not Path(value).is_absolute() and all(p not in ("", ".", "..") for p in value.split("/")),
            f"Unsafe relative path: {value!r}")
    return Path(value)


class Output:
    def __init__(self, root):
        self.root = Path(root).absolute()
        self.root.mkdir()  # Existing evidence must never be replaced.

    def write(self, relative, data):
        path = self.root / safe_relative(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(data)
        return {"path": str(path), "sha256": sha(data), "bytes": len(data)}

    def json(self, relative, data):
        return self.write(relative, (json.dumps(data, indent=2) + "\n").encode())


def read_lock(path):
    rows = {}
    for package in tomllib.loads(regular(path).decode())["package"]:
        name, version = package["name"], package["version"]
        source, checksum = package.get("source"), package.get("checksum")
        require(not source or (source.startswith("registry+") and HASH.fullmatch(checksum or "")),
                f"Only workspace and checksum-pinned registry packages are supported: {name}@{version}")
        key = f"{name}@{version}"
        require(key not in rows, f"Ambiguous lock identity: {key}")
        rows[key] = dict(key=key, name=name, version=version, source=source, checksum=checksum)
    return rows


def read_product(product, metadata_path, messages_path, binary_path, source_root, output):
    metadata_bytes = regular(metadata_path)
    metadata = json.loads(metadata_bytes)
    require(metadata.get("version") == 1 and metadata.get("resolve") is not None,
            "Use cargo metadata --locked --format-version 1, without --no-deps")
    workspace = Path(metadata["workspace_root"]).resolve()
    expected = source_root / ("core" if product == "gateway" else "native/resource-monitor")
    require(workspace == expected.resolve(), f"Metadata workspace differs from source root: {product}")
    lock_path = workspace / "Cargo.lock"
    locked = read_lock(lock_path)
    metadata_packages = {}
    by_id = {}
    for package in metadata["packages"]:
        key = f"{package['name']}@{package['version']}"
        pinned = locked.get(key)
        require(pinned and pinned["source"] == package.get("source"), f"Metadata package outside lock: {key}")
        require(key not in metadata_packages, f"Ambiguous metadata identity: {key}")
        metadata_packages[key] = package
        by_id[package["id"]] = package
    target = Path(metadata["target_directory"]).resolve()
    binary_input = Path(binary_path).absolute()
    require(stat.S_ISREG(binary_input.lstat().st_mode), "Expected a regular Cargo executable")
    binary = binary_input.parent.resolve() / binary_input.name
    require(binary.parent.name in ("debug", "release"), "Use an unmodified Cargo debug/release executable")
    require(binary.parent in (target / binary.parent.name, target / TARGET / binary.parent.name),
            f"Binary is outside the metadata target directory: {binary}")
    with binary.open("rb") as stream:
        header = stream.read(8)
    require(header == b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01", "Expected thin macOS arm64 Mach-O executable")
    binary_hash = digest(binary)
    messages_bytes = regular(messages_path)
    artifacts = []
    finished = []
    for line in messages_bytes.splitlines():
        message = json.loads(line)
        if message.get("reason") == "build-finished":
            finished.append(message.get("success"))
        if message.get("reason") == "compiler-artifact":
            require(message["package_id"] in by_id, "Compiler artifact is outside supplied metadata")
            artifacts.append(message)
    require(finished == [True], "Build messages must contain exactly one successful build-finished event")
    root_artifacts = [a for a in artifacts if a.get("executable") and Path(a["executable"]).resolve() == binary
                      and by_id[a["package_id"]]["name"] == ROOT_PACKAGES[product]
                      and "bin" in a["target"]["kind"]]
    require(len(root_artifacts) == 1, f"Missing or ambiguous compiler artifact for {binary}")
    snapshots = {
        "metadata": output.write(f"evidence/{product}/metadata.json", metadata_bytes),
        "buildMessages": output.write(f"evidence/{product}/build-messages.jsonl", messages_bytes),
    }
    lock = {**output.write(f"locks/{product}.Cargo.lock", regular(lock_path)), "currentSource": str(lock_path)}
    return dict(product=product, workspace=workspace, locked=locked, packages=metadata_packages,
                by_id=by_id, artifacts=artifacts, target=target, binary=binary, binary_hash=binary_hash,
                profile=binary.parent.name, snapshots=snapshots, lock=lock)


def derive_graph(context, output):
    target, binary = context["target"], context["binary"]
    directories = list(dict.fromkeys([binary.parent, target / context["profile"]]))
    units, index, values = {}, defaultdict(list), defaultdict(list)
    for directory in directories:
        for path in sorted((directory / ".fingerprint").glob("*/*.json")):
            kind = next((kind for prefix, kind in (("run-build-script-", "build-script-run"),
                        ("build-script-", "build-script"), ("bin-", "binary"), ("lib-", "library"))
                        if path.stem.startswith(prefix)), None)
            if kind is None:
                continue
            value_path = path.with_suffix("")
            if not value_path.is_file():
                continue
            value = regular(value_path).decode().strip()
            require(re.fullmatch(r"[0-9a-f]{16}", value), f"Unsupported fingerprint value: {value_path}")
            data = json.loads(regular(path))  # Python preserves Cargo's u64 edge values.
            require(isinstance(data.get("deps"), list) and "compile_kind" in data,
                    f"Unsupported Cargo fingerprint schema: {path}")
            name, artifact_hash = path.parent.name.rsplit("-", 1)
            crate = "build_script_build" if kind.startswith("build-script") else path.stem.split("-", 1)[1].replace("-", "_")
            unit_id = str(path.relative_to(target))
            unit = dict(id=unit_id, path=path, value_path=value_path, data=data, kind=kind,
                        name=name, artifact_hash=artifact_hash, directory=directory, crate=crate,
                        value=int.from_bytes(bytes.fromhex(value), "little"))
            units[unit_id] = unit
            index[(unit["value"], crate)].append(unit_id)
            values[unit["value"]].append(unit_id)
    roots = []
    for unit in units.values():
        if unit["kind"] != "binary" or unit["name"] != ROOT_PACKAGES[context["product"]] or unit["directory"] != binary.parent:
            continue
        hashed = binary.parent / "deps" / (unit["crate"] + "-" + unit["artifact_hash"])
        if hashed.is_file() and digest(hashed) == context["binary_hash"]:
            unit["hashed_binary"] = hashed
            roots.append(unit)
    require(len(roots) == 1, "Expected exactly one byte-matched Cargo root fingerprint; rebuild in a clean target directory")
    root = roots[0]

    def identify(unit):
        if "package" in unit:
            return
        edges = []
        for edge in unit["data"]["deps"]:
            require(len(edge) >= 4 and isinstance(edge[3], int), "Unsupported fingerprint dependency edge")
            # Cargo records dependency aliases in edges but declared crate names in units.
            candidates = index[(edge[3], edge[1])] or values[edge[3]]
            require(len(candidates) == 1, f"Missing or ambiguous fingerprint edge: {unit['id']} -> {edge[1]}")
            edges.append({"unit": candidates[0], "crateName": edge[1], "fingerprintValue": str(edge[3])})
        unit["edges"] = edges
        if unit["kind"] == "build-script-run":
            compiled = [units[e["unit"]] for e in edges if units[e["unit"]]["kind"] == "build-script"]
            require(len(compiled) == 1 and compiled[0]["name"] == unit["name"], "Unproven build-script-run identity")
            identify(compiled[0])
            unit.update(package=compiled[0]["package"], proc_macro=False, identity_from=compiled[0]["id"])
            return
        matching = []
        for artifact in context["artifacts"]:
            package = context["by_id"][artifact["package_id"]]
            if package["name"] != unit["name"]:
                continue
            paths = [Path(p) for p in artifact["filenames"]]
            match = any(unit["artifact_hash"] in p.name.split(".")[0].rsplit("-", 1)[-1:]
                        or p.parent.name == f"{unit['name']}-{unit['artifact_hash']}" for p in paths)
            if unit is root:
                match = artifact.get("executable") and Path(artifact["executable"]).resolve() == binary
            if match:
                matching.append((package, artifact))
        require(len(matching) == 1, f"Fingerprint has no unique compiler artifact: {unit['id']}")
        package, artifact = matching[0]
        manifest = Path(package["manifest_path"])
        parsed = tomllib.loads(regular(manifest).decode())
        require(parsed["package"]["name"] == package["name"], "Source manifest changed since metadata")
        version = parsed["package"]["version"]
        if isinstance(version, dict) and version.get("workspace") is True:
            version = tomllib.loads(regular(context["workspace"] / "Cargo.toml").decode())["workspace"]["package"]["version"]
        require(version == package["version"], "Source version changed since metadata")
        unit.update(package=package, proc_macro="proc-macro" in artifact["target"]["kind"],
                    manifest={"path": str(manifest), "sha256": digest(manifest)})

    queue, roles = deque([(root["id"], "runtime")]), defaultdict(set)
    while queue:
        unit_id, inherited = queue.popleft()
        unit = units[unit_id]
        identify(unit)
        role = "build" if unit["kind"].startswith("build-script") else "proc-macro" if unit["proc_macro"] else inherited
        if role in roles[unit_id]:
            continue
        roles[unit_id].add(role)
        child_role = "build" if role in ("build", "proc-macro") else "runtime"
        queue.extend((edge["unit"], child_role) for edge in unit["edges"])
    selected, evidence = {}, []
    for unit_id in sorted(roles):
        unit = units[unit_id]
        key = f"{unit['package']['name']}@{unit['package']['version']}"
        row = selected.setdefault(key, {**context["locked"][key], "roles": set(), "units": []})
        row["roles"].update(roles[unit_id])
        row["units"].append(unit_id)
        evidence.append({"id": unit_id, "packageKey": key, "kind": unit["kind"],
                         "packageId": unit["package"]["id"],
                         **({"sourceManifest": unit["manifest"]} if "manifest" in unit else
                            {"identityFromUnit": unit["identity_from"]}),
                         "roles": sorted(roles[unit_id]), "features": unit["data"].get("features"),
                         "compileKind": str(unit["data"]["compile_kind"]), "dependencyEdges": unit["edges"],
                         "fingerprint": output.write(f"evidence/{context['product']}/{unit_id}", regular(unit["path"])),
                         "value": output.write(f"evidence/{context['product']}/{unit_id[:-5]}", regular(unit["value_path"]))})
    for row in selected.values():
        row["roles"] = sorted(row["roles"])
    require(digest(binary) == context["binary_hash"], "Binary changed during graph derivation")
    return {"profile": context["profile"], "lock": context["lock"],
            "root": {"package": ROOT_PACKAGES[context["product"]], "binary": str(binary),
                     "binarySha256": context["binary_hash"], "artifact": str(root["hashed_binary"]),
                     "fingerprintUnit": root["id"]}, "unresolvedEdges": [],
            "selectedRegistryPackages": [selected[k] for k in sorted(selected) if selected[k]["source"]],
            "selectedWorkspacePackages": [selected[k] for k in sorted(selected) if not selected[k]["source"]],
            "selectedUnitCount": len(evidence), "unitGraph": output.json(f"{context['product']}-units.json", evidence),
            "inputs": context["snapshots"]}


def prepare(options):
    source_root = Path(options.source_root).resolve()
    output = Output(options.output)
    contexts = {}
    for product, prefix in (("gateway", "gateway"), ("resourceMonitor", "monitor")):
        contexts[product] = read_product(product, getattr(options, prefix + "_metadata"),
            getattr(options, prefix + "_build_messages"), getattr(options, prefix + "_binary"), source_root, output)
    graphs = {p: derive_graph(c, output) for p, c in contexts.items()}
    rows = {}
    workspace_supplements = []
    for product, context in contexts.items():
        for key, pinned in context["locked"].items():
            metadata = context["packages"].get(key)
            if not pinned["source"]:
                require(metadata is not None, f"Missing workspace metadata: {key}")
                if product == "resourceMonitor":
                    continue  # The existing collector binds this package to the repository LICENSE.
                current_manifest = tomllib.loads(regular(metadata["manifest_path"]).decode())
                license_value = current_manifest["package"].get("license")
                if isinstance(license_value, dict) and license_value.get("workspace") is True:
                    license_value = tomllib.loads(regular(context["workspace"] / "Cargo.toml").decode())["workspace"]["package"].get("license")
                require(metadata.get("license") == license_value == "MIT", f"Review workspace license: {key}")
                license_path = context["workspace"] / "LICENSE-MIT"
                retained = output.write(f"workspace/{key}/LICENSE-MIT", regular(license_path))
                manifest = output.write(f"workspace/{key}/Cargo.toml", regular(metadata["manifest_path"]))
                workspace_supplements.append({"key": key, "notices": [{"name": "LICENSE-MIT", "file": retained["path"],
                    "sha256": retained["sha256"], "source": {"kind": "repository-workspace-license", "license": "MIT",
                    "repositoryPath": "core/LICENSE-MIT", "packageManifest": manifest}}]})
                continue
            if key in rows:
                require(rows[key]["registrySource"] == pinned["source"] and rows[key]["lockChecksum"] == pinned["checksum"],
                        f"Conflicting locked identity: {key}")
                continue
            cached_source = str(Path(metadata["manifest_path"]).parent) if metadata else None
            if cached_source:
                path = Path(cached_source)
                require(path.parent.parent.name == "src" and path.parent.parent.parent.name == "registry",
                        f"Collector requires Cargo registry archives, not vendored sources: {key}")
                archive = path.parents[2] / "cache" / path.parent.name / f"{pinned['name']}-{pinned['version']}.crate"
                if archive.exists():
                    require(digest(archive) == pinned["checksum"], f"Cached archive checksum mismatch: {key}")
            rows[key] = {"name": pinned["name"], "version": pinned["version"], "registrySource": pinned["source"],
                         "lockChecksum": pinned["checksum"], "cachedSource": cached_source,
                         "licenseExpression": metadata.get("license") if metadata else None}
    supplements_path = source_root / "scripts/native-notice-supplements.json"
    supplements = json.loads(regular(supplements_path))
    require(supplements.get("schemaVersion") == 1, "Unsupported supplemental source catalog")
    packages, supplemental_keys = [], set()
    for row in supplements["packages"]:
        require(row["key"] not in supplemental_keys, f"Duplicate supplement: {row['key']}")
        supplemental_keys.add(row["key"])
        pinned = rows.get(row["key"])
        if not pinned:
            continue
        require(row["checksum"] == pinned["lockChecksum"], f"Supplement lock mismatch: {row['key']}")
        notices = []
        for notice in row["notices"]:
            source = supplements_path.parent / safe_relative(notice["file"])
            data = regular(source)
            require(sha(data) == notice["sha256"] and notice.get("source"), "Supplement provenance mismatch")
            retained = output.write(f"supplements/{row['key']}/{notice['name']}", data)
            notices.append({**notice, "file": retained["path"]})
        packages.append({**row, "notices": notices})
    inventory = output.json("package-index.json", {"schema": 1, "locks": {p: c["lock"] for p, c in contexts.items()},
                                                "packages": [rows[k] for k in sorted(rows)]})
    selection = output.json("selected-graph.json", {"schemaVersion": 1, "platform": TARGET,
        "method": "Byte-matched Cargo executable and lossless fingerprint closure, joined to compiler artifacts and locked metadata",
        "products": graphs, "provenance": {"generatorSha256": digest(__file__), "inventory": inventory},
        "limits": ["Cargo fingerprint formats are unstable; unsupported or ambiguous evidence is rejected.",
                   "Compilation selection is not retained symbol selection or legal clearance."]})
    supplement_record = output.json("supplements.json", {"packages": packages + workspace_supplements})
    for context in contexts.values():
        require(digest(context["lock"]["currentSource"]) == context["lock"]["sha256"], "Lock changed during preparation")
        require(digest(context["binary"]) == context["binary_hash"], "Binary changed during preparation")
    return {"inventory": inventory, "selection": selection, "supplements": supplement_record,
            "products": {p: {"profile": g["profile"], "selectedUnits": g["selectedUnitCount"],
                             "selectedRegistryPackages": len(g["selectedRegistryPackages"])} for p, g in graphs.items()}}


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--source-root", default=str(Path(__file__).resolve().parent.parent))
    result.add_argument("--output", required=True, help="New directory for collector inputs and retained evidence")
    for prefix in ("gateway", "monitor"):
        result.add_argument(f"--{prefix}-metadata", required=True)
        result.add_argument(f"--{prefix}-build-messages", required=True)
        result.add_argument(f"--{prefix}-binary", required=True)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(prepare(parser().parse_args()), indent=2))
    except (ValueError, KeyError, OSError) as error:
        print(f"Native notice preparation failed: {error}", file=sys.stderr)
        sys.exit(1)
