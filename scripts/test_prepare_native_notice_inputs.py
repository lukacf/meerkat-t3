"""Pure fixture tests. No Cargo, network, provider accounts, or app processes."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("notice_inputs", Path(__file__).with_name("prepare-native-notice-inputs.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
MACHO = b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01"


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())


def json_write(path, data):
    write(path, json.dumps(data))


def crate_archive():
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz") as tar:
        for name, value in {"Cargo.toml": '[package]\nname = "demo"\nversion = "1.0.0"\nlicense = "MIT"\n',
                            "LICENSE": "Original fixture holder\r\n"}.items():
            data = value.encode()
            info = tarfile.TarInfo("demo-1.0.0/" + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return result.getvalue()


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-notice-inputs-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.products = {}
        archive = crate_archive()
        self.checksum = hashlib.sha256(archive).hexdigest()
        self.package_source = self.root / "cargo/registry/src/index/demo-1.0.0"
        write(self.package_source / "Cargo.toml", '[package]\nname = "demo"\nversion = "1.0.0"\nlicense = "MIT"\n')
        write(self.root / "cargo/registry/cache/index/demo-1.0.0.crate", archive)
        json_write(self.source / "scripts/native-notice-supplements.json", {"schemaVersion": 1, "packages": []})
        write(self.source / "LICENSE", "Original T3 fixture notice\n")
        for product, folder in (("gateway", "core"), ("resourceMonitor", "native/resource-monitor")):
            workspace = self.source / folder
            name = MODULE.ROOT_PACKAGES[product]
            write(workspace / "Cargo.toml", '[workspace]\n[workspace.package]\nversion = "0.1.0"\nlicense = "MIT"\n')
            manifest = workspace / name / "Cargo.toml"
            write(manifest, f'[package]\nname = "{name}"\nversion.workspace = true\nlicense.workspace = true\n')
            write(workspace / "LICENSE-MIT", "Native fixture copyright and MIT terms\n")
            write(workspace / "Cargo.lock", f'''version = 4
[[package]]
name = "{name}"
version = "0.1.0"
[[package]]
name = "demo"
version = "1.0.0"
source = "{REGISTRY}"
checksum = "{self.checksum}"
''')
            target = self.root / product / "target"
            directory = target / MODULE.TARGET / "release"
            binary = directory / name
            write(binary, MACHO + product.encode())
            root_id = "path+file://fixture#" + name + "@0.1.0"
            package_id = REGISTRY + "#demo@1.0.0"
            metadata = {"version": 1, "resolve": {"nodes": []}, "workspace_root": str(workspace),
                "target_directory": str(target), "packages": [
                    {"id": root_id, "name": name, "version": "0.1.0", "source": None,
                     "manifest_path": str(manifest), "license": "MIT"},
                    {"id": package_id, "name": "demo", "version": "1.0.0", "source": REGISTRY,
                     "manifest_path": str(self.package_source / "Cargo.toml"), "license": "MIT"}]}
            metadata_path = self.root / f"{product}-metadata.json"
            json_write(metadata_path, metadata)
            # A u64 above JavaScript's integer precision boundary, with a renamed dependency.
            value = 2**63 + 987654321
            fp = directory / ".fingerprint" / "demo-2222222222222222" / "lib-demo.json"
            json_write(fp, {"deps": [], "compile_kind": 0, "features": "[]"})
            write(fp.with_suffix(""), value.to_bytes(8, "little").hex())
            root_fp = directory / ".fingerprint" / f"{name}-1111111111111111" / f"bin-{name}.json"
            json_write(root_fp, {"deps": [[1, "renamed_demo", False, value]], "compile_kind": 0, "features": "[]"})
            write(root_fp.with_suffix(""), (value + 1).to_bytes(8, "little").hex())
            write(directory / "deps" / f"{name.replace('-', '_')}-1111111111111111", binary.read_bytes())
            library = directory / "deps/libdemo-2222222222222222.rlib"
            write(library, "fixture library")
            artifacts = [
                {"reason": "compiler-artifact", "package_id": package_id, "target": {"kind": ["lib"]},
                 "filenames": [str(library)], "executable": None},
                {"reason": "compiler-artifact", "package_id": root_id, "target": {"kind": ["bin"]},
                 "filenames": [str(binary)], "executable": str(binary)},
                {"reason": "build-finished", "success": True}]
            messages_path = self.root / f"{product}-build.jsonl"
            write(messages_path, "\n".join(json.dumps(a) for a in artifacts))
            self.products[product] = dict(binary=binary, metadata=metadata, metadata_path=metadata_path,
                messages_path=messages_path, artifacts=artifacts, root_fp=root_fp, fp=fp, workspace=workspace)
        self.options = argparse.Namespace(source_root=self.source, output=self.root / "prepared",
            gateway_metadata=self.products["gateway"]["metadata_path"], gateway_build_messages=self.products["gateway"]["messages_path"],
            gateway_binary=self.products["gateway"]["binary"], monitor_metadata=self.products["resourceMonitor"]["metadata_path"],
            monitor_build_messages=self.products["resourceMonitor"]["messages_path"], monitor_binary=self.products["resourceMonitor"]["binary"])

    def test_alias_u64_graph_workspace_notice_and_existing_collector(self):
        result = MODULE.prepare(self.options)
        graph = json.loads(Path(result["selection"]["path"]).read_text())
        self.assertEqual(graph["products"]["gateway"]["selectedRegistryPackages"][0]["key"], "demo@1.0.0")
        self.assertEqual(graph["products"]["gateway"]["selectedUnitCount"], 2)
        units = json.loads(Path(graph["products"]["gateway"]["unitGraph"]["path"]).read_text())
        edge = next(unit for unit in units if unit["kind"] == "binary")["dependencyEdges"][0]
        self.assertEqual(edge["fingerprintValue"], str(2**63 + 987654321))
        library = next(unit for unit in units if unit["kind"] == "library")
        self.assertEqual(library["sourceManifest"]["sha256"], MODULE.digest(self.package_source / "Cargo.toml"))
        collector = Path(__file__).with_name("collect-native-license-notices.mjs")
        process = subprocess.run(["node", str(collector), "--inventory", result["inventory"]["path"],
            "--selection", result["selection"]["path"], "--supplements", result["supplements"]["path"],
            "--t3-license", str(self.source / "LICENSE"), "--output", str(self.root / "collected")],
            check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(process.stdout)["collectionStatus"], "collected")
        with self.assertRaises(FileExistsError):
            MODULE.prepare(self.options)

    def test_host_build_script_and_proc_macro_roles(self):
        product = self.products["gateway"]
        target = product["binary"].parents[2]
        host = target / "release"
        target_dir = product["binary"].parent
        compile_value, run_value, macro_value = 21, 22, 23
        compile_fp = host / ".fingerprint/demo-3333333333333333/build-script-build-script-build.json"
        json_write(compile_fp, {"deps": [], "compile_kind": 0, "features": "[]"})
        write(compile_fp.with_suffix(""), compile_value.to_bytes(8, "little").hex())
        compiled = host / "build/demo-3333333333333333/build-script-build"
        write(compiled, "compiled build script")
        run_fp = target_dir / ".fingerprint/demo-4444444444444444/run-build-script-build-script-build.json"
        json_write(run_fp, {"deps": [[1, "build_script_build", False, compile_value]], "compile_kind": 0})
        write(run_fp.with_suffix(""), run_value.to_bytes(8, "little").hex())
        lib = json.loads(product["fp"].read_text())
        lib["deps"] = [[1, "build_script_build", False, run_value]]
        json_write(product["fp"], lib)
        macro_fp = host / ".fingerprint/demo-5555555555555555/lib-demo.json"
        json_write(macro_fp, {"deps": [], "compile_kind": 0, "features": "[]"})
        write(macro_fp.with_suffix(""), macro_value.to_bytes(8, "little").hex())
        macro = host / "deps/libdemo-5555555555555555.dylib"
        write(macro, "compiled proc macro")
        root = json.loads(product["root_fp"].read_text())
        root["deps"].append([1, "macro_alias", False, macro_value])
        json_write(product["root_fp"], root)
        package_id = product["metadata"]["packages"][1]["id"]
        artifacts = product["artifacts"][:-1] + [
            {"reason": "compiler-artifact", "package_id": package_id, "target": {"kind": ["custom-build"]},
             "filenames": [str(compiled)], "executable": None},
            {"reason": "build-script-executed", "package_id": package_id,
             "out_dir": str(target_dir / "build/demo-4444444444444444/out")},
            {"reason": "compiler-artifact", "package_id": package_id, "target": {"kind": ["proc-macro"]},
             "filenames": [str(macro)], "executable": None}, product["artifacts"][-1]]
        write(product["messages_path"], "\n".join(json.dumps(a) for a in artifacts))
        result = MODULE.prepare(self.options)
        graph = json.loads(Path(result["selection"]["path"]).read_text())["products"]["gateway"]
        self.assertEqual(graph["selectedUnitCount"], 5)
        self.assertEqual(graph["selectedRegistryPackages"][0]["roles"], ["build", "proc-macro", "runtime"])
        units = json.loads(Path(graph["unitGraph"]["path"]).read_text())
        run = next(unit for unit in units if unit["kind"] == "build-script-run")
        compiled_unit = next(unit for unit in units if unit["id"] == run["identityFromUnit"])
        self.assertEqual(compiled_unit["kind"], "build-script")
        self.assertEqual(compiled_unit["packageId"], run["packageId"])

    def add_colliding_build_script_runs(self):
        product = self.products["gateway"]
        target_dir = product["binary"].parent
        host = product["binary"].parents[2] / "release"
        compile_fp = host / ".fingerprint/demo-3333333333333333/build-script-build-script-build.json"
        json_write(compile_fp, {"deps": [], "compile_kind": 0})
        write(compile_fp.with_suffix(""), (21).to_bytes(8, "little").hex())
        compiled = host / "build/demo-3333333333333333/build-script-build"
        write(compiled, "compiled build script")
        runs = []
        for directory, suffix in ((target_dir, "4444444444444444"), (host, "6666666666666666")):
            fp = directory / f".fingerprint/demo-{suffix}/run-build-script-build-script-build.json"
            # Cargo may emit byte-identical run fingerprints for host and target.
            json_write(fp, {"deps": [[1, "build_script_build", False, 21]], "compile_kind": 0})
            write(fp.with_suffix(""), (22).to_bytes(8, "little").hex())
            runs.append(fp)
        lib = json.loads(product["fp"].read_text())
        lib["deps"] = [[1, "build_script_build", False, 22]]
        json_write(product["fp"], lib)
        package_id = product["metadata"]["packages"][1]["id"]
        product["artifacts"][-1:-1] = [
            {"reason": "compiler-artifact", "package_id": package_id, "target": {"kind": ["custom-build"]},
             "filenames": [str(compiled)], "executable": None},
            {"reason": "build-script-executed", "package_id": package_id,
             "out_dir": str(target_dir / "build/demo-4444444444444444/out")}]
        return product, runs

    def save_messages(self, product):
        write(product["messages_path"], "\n".join(json.dumps(a) for a in product["artifacts"]))

    def test_identical_cached_host_run_resolved_by_current_execution(self):
        product, runs = self.add_colliding_build_script_runs()
        self.save_messages(product)
        result = MODULE.prepare(self.options)
        graph = json.loads(Path(result["selection"]["path"]).read_text())["products"]["gateway"]
        units = json.loads(Path(graph["unitGraph"]["path"]).read_text())
        self.assertEqual(graph["selectedUnitCount"], 4)
        target = product["binary"].parents[2]
        run = next(unit for unit in units if unit["kind"] == "build-script-run")
        self.assertEqual(run["id"], str(runs[0].relative_to(target)))
        self.assertNotIn(str(runs[1].relative_to(target)), [unit["id"] for unit in units])
        library = next(unit for unit in units if unit["kind"] == "library")
        self.assertEqual(library["dependencyEdges"][0]["unit"], run["id"])
        self.assertIn(run["identityFromUnit"], [unit["id"] for unit in units])

    def test_current_host_and_target_runs_resolve_in_consumers_build_tree(self):
        product, runs = self.add_colliding_build_script_runs()
        host_execution = dict(product["artifacts"][-2])
        host_execution["out_dir"] = str(runs[1].parents[2] / "build" / runs[1].parent.name / "out")
        product["artifacts"].insert(-1, host_execution)
        self.save_messages(product)
        result = MODULE.prepare(self.options)
        graph = json.loads(Path(result["selection"]["path"]).read_text())["products"]["gateway"]
        units = json.loads(Path(graph["unitGraph"]["path"]).read_text())
        run = next(unit for unit in units if unit["kind"] == "build-script-run")
        self.assertEqual(run["id"], str(runs[0].relative_to(product["binary"].parents[2])))

    def test_host_execution_cannot_replace_missing_target_execution(self):
        product, runs = self.add_colliding_build_script_runs()
        product["artifacts"][-2]["out_dir"] = str(runs[1].parents[2] / "build" / runs[1].parent.name / "out")
        self.save_messages(product)
        with self.assertRaisesRegex(ValueError, "fingerprint edge"):
            MODULE.prepare(self.options)

    def test_build_script_run_keeps_another_packages_build_script_dependency(self):
        product, runs = self.add_colliding_build_script_runs()
        package = product["metadata"]["packages"][0]
        host = product["binary"].parents[2] / "release"
        compile_fp = host / ".fingerprint" / f"{package['name']}-8888888888888888" / "build-script-build-script-build.json"
        json_write(compile_fp, {"deps": [], "compile_kind": 0})
        write(compile_fp.with_suffix(""), (31).to_bytes(8, "little").hex())
        compiled = host / "build" / compile_fp.parent.name / "build-script-build"
        write(compiled, "dependency build script")
        dependency = runs[0].parents[1] / f"{package['name']}-9999999999999999" / runs[0].name
        json_write(dependency, {"deps": [[1, "build_script_build", False, 31]], "compile_kind": 0})
        write(dependency.with_suffix(""), (32).to_bytes(8, "little").hex())
        run = json.loads(runs[0].read_text())
        run["deps"].append([2, "build_script_build", False, 32])
        json_write(runs[0], run)
        product["artifacts"][-1:-1] = [
            {"reason": "compiler-artifact", "package_id": package["id"], "target": {"kind": ["custom-build"]},
             "filenames": [str(compiled)], "executable": None},
            {"reason": "build-script-executed", "package_id": package["id"],
             "out_dir": str(product["binary"].parent / "build" / dependency.parent.name / "out")}]
        self.save_messages(product)
        result = MODULE.prepare(self.options)
        graph = json.loads(Path(result["selection"]["path"]).read_text())["products"]["gateway"]
        units = json.loads(Path(graph["unitGraph"]["path"]).read_text())
        self.assertEqual(graph["selectedUnitCount"], 6)
        dependency_unit = next(unit for unit in units if unit["id"] == str(dependency.relative_to(host.parent)))
        self.assertEqual(dependency_unit["packageId"], package["id"])
        self.assertEqual(dependency_unit["roles"], ["build"])
        self.assertIn(dependency_unit["identityFromUnit"], [unit["id"] for unit in units])

    def test_multiple_current_runs_in_same_build_tree_remain_ambiguous(self):
        product, runs = self.add_colliding_build_script_runs()
        duplicate = runs[0].parents[1] / "demo-7777777777777777" / runs[0].name
        write(duplicate, runs[0].read_bytes())
        write(duplicate.with_suffix(""), runs[0].with_suffix("").read_bytes())
        execution = dict(product["artifacts"][-2])
        execution["out_dir"] = str(product["binary"].parent / "build" / duplicate.parent.name / "out")
        product["artifacts"].insert(-1, execution)
        self.save_messages(product)
        with self.assertRaisesRegex(ValueError, "ambiguous fingerprint edge"):
            MODULE.prepare(self.options)

    def test_build_script_execution_package_must_match_compiled_artifact(self):
        product, _ = self.add_colliding_build_script_runs()
        product["artifacts"][-2]["package_id"] = product["metadata"]["packages"][0]["id"]
        self.save_messages(product)
        with self.assertRaisesRegex(ValueError, "execution differs from compiler artifact"):
            MODULE.prepare(self.options)

    def test_duplicate_execution_records_are_rejected(self):
        product, _ = self.add_colliding_build_script_runs()
        product["artifacts"].insert(-1, dict(product["artifacts"][-2]))
        self.save_messages(product)
        with self.assertRaisesRegex(ValueError, "fingerprint edge"):
            MODULE.prepare(self.options)

    def test_changed_binary_rejected(self):
        with self.options.gateway_binary.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "byte-matched"):
            MODULE.prepare(self.options)

    def test_missing_or_ambiguous_edge_rejected(self):
        self.products["gateway"]["fp"].unlink()
        with self.assertRaisesRegex(ValueError, "fingerprint edge"):
            MODULE.prepare(self.options)

    def test_failed_build_rejected(self):
        product = self.products["gateway"]
        product["artifacts"][-1]["success"] = False
        write(product["messages_path"], "\n".join(json.dumps(a) for a in product["artifacts"]))
        with self.assertRaisesRegex(ValueError, "successful build-finished"):
            MODULE.prepare(self.options)

    def test_compiler_artifact_required_for_each_selected_unit(self):
        product = self.products["gateway"]
        write(product["messages_path"], "\n".join(json.dumps(a) for a in product["artifacts"][1:]))
        with self.assertRaisesRegex(ValueError, "no unique compiler artifact"):
            MODULE.prepare(self.options)

    def test_metadata_from_another_workspace_rejected(self):
        product = self.products["gateway"]
        product["metadata"]["workspace_root"] = str(self.root)
        json_write(product["metadata_path"], product["metadata"])
        with self.assertRaisesRegex(ValueError, "workspace differs"):
            MODULE.prepare(self.options)

    def test_archive_checksum_tamper_rejected(self):
        write(self.root / "cargo/registry/cache/index/demo-1.0.0.crate", "changed archive")
        with self.assertRaisesRegex(ValueError, "archive checksum mismatch"):
            MODULE.prepare(self.options)

    def test_pinned_supplement_bytes_and_lock_are_verified(self):
        data = b"Exact supplemental source\r\n"
        write(self.source / "scripts/native-notice-assets/demo.txt", data)
        supplement = {"schemaVersion": 1, "packages": [{"key": "demo@1.0.0", "checksum": self.checksum,
            "notices": [{"name": "extra.txt", "file": "native-notice-assets/demo.txt", "sha256": MODULE.sha(data),
                         "source": {"kind": "fixture"}}]}]}
        json_write(self.source / "scripts/native-notice-supplements.json", supplement)
        result = MODULE.prepare(self.options)
        notices = json.loads(Path(result["supplements"]["path"]).read_text())["packages"][0]["notices"]
        self.assertEqual(Path(notices[0]["file"]).read_bytes(), data)
        self.options.output = self.root / "tampered"
        write(self.source / "scripts/native-notice-assets/demo.txt", b"changed")
        with self.assertRaisesRegex(ValueError, "provenance mismatch"):
            MODULE.prepare(self.options)


if __name__ == "__main__":
    unittest.main()
