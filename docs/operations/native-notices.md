# Reproduce native notice inputs

The Apple Silicon desktop artifact contains two independently built Rust programs:
the in-repository Meerkat gateway and the resource monitor. Prepare notices for the
exact bytes being packaged. A lockfile inventories every resolved platform and
development dependency; it does not identify the compilation closure of either
executable.

The repository supplies both steps:

- `scripts/prepare-native-notice-inputs.py` joins locked Cargo metadata, compiler
  artifact messages, and the exact executable's fingerprint closure. It produces
  the package index and selected graph required by the collector.
- `scripts/collect-native-license-notices.mjs` verifies cached crate archives against
  lock checksums, verifies exact Git checkouts, copies available notice text verbatim, records missing inputs,
  and binds the resulting bundle to both executable and lock hashes.

These commands neither launch the app nor access provider accounts. The preparer
runs no Cargo commands or network requests. The explicit build and metadata steps
below may download public Cargo dependencies. Run them in an owned checkout, with
no other build mutating its target directories during capture or collection.

## Capture actual build inputs

Use the repository's Rust toolchain and Node version. Install Python 3.11 or newer
for its standard-library TOML parser; macOS's system `python3` can be older. For
example, `brew install python@3.12`, then use `python3.12` below.

From the repository root, run the following in one shell. The fresh temporary
directory retains evidence without adding generated files to source control.
`--message-format` captures all selected compiler artifacts, including Cargo's
already-fresh artifacts; it must accompany a successful build, not a test run.

```sh
set -euo pipefail
notice_work="$(mktemp -d "${TMPDIR:-/tmp}/meerkat-native-notices.XXXXXX")"
scripts/repo-cargo --print-env > "$notice_work/gateway-env.txt"
gateway_target_dir="$(sed -n 's/^CARGO_TARGET_DIR=//p' "$notice_work/gateway-env.txt")"

scripts/repo-cargo build --locked --release --target aarch64-apple-darwin \
  -p meerkat-desktop-stdio --message-format=json-render-diagnostics \
  > "$notice_work/gateway-build.jsonl"
scripts/repo-cargo metadata --locked --format-version 1 \
  > "$notice_work/gateway-metadata.json"

cargo build --locked --release --target aarch64-apple-darwin \
  --manifest-path native/resource-monitor/Cargo.toml \
  --message-format=json-render-diagnostics > "$notice_work/monitor-build.jsonl"
cargo metadata --locked --format-version 1 \
  --manifest-path native/resource-monitor/Cargo.toml \
  > "$notice_work/monitor-metadata.json"
monitor_target_dir="$(python3.12 -c 'import json,sys; print(json.load(open(sys.argv[1]))["target_directory"])' "$notice_work/monitor-metadata.json")"
```

Keep stdout as JSON only. Do not concatenate runs or redirect diagnostics into the
JSON file. Each capture must end in exactly one successful `build-finished` event.
Use full metadata, without `--no-deps` or `--filter-platform`, so the inventory can
account for all locked packages. These commands do not regenerate either lock.

The supported packaging monitor path is
`native/resource-monitor/target/aarch64-apple-darwin/release/t3-resource-monitor`.
If your environment sets a custom `CARGO_TARGET_DIR`, the metadata reports that
location; use that exact binary for collection and explicitly provision the same
bytes at the packaging path afterward. Do not rebuild it between collection and
packaging. The gateway uses the isolated target directory reported by
`scripts/repo-cargo`; do not guess a `core/target` path.

## Prepare and collect

```sh
python3.12 scripts/prepare-native-notice-inputs.py \
  --gateway-metadata "$notice_work/gateway-metadata.json" \
  --gateway-build-messages "$notice_work/gateway-build.jsonl" \
  --gateway-binary "$gateway_target_dir/aarch64-apple-darwin/release/meerkat-desktop-stdio" \
  --monitor-metadata "$notice_work/monitor-metadata.json" \
  --monitor-build-messages "$notice_work/monitor-build.jsonl" \
  --monitor-binary "$monitor_target_dir/aarch64-apple-darwin/release/t3-resource-monitor" \
  --output "$notice_work/inputs"

node scripts/collect-native-license-notices.mjs \
  --inventory "$notice_work/inputs/package-index.json" \
  --selection "$notice_work/inputs/selected-graph.json" \
  --supplements "$notice_work/inputs/supplements.json" \
  --t3-license LICENSE \
  --output "$notice_work/bundle"
```

Each output directory must be new. Failed preparation can leave partial evidence;
choose another fresh directory for a retry. Keep the failed evidence when diagnosing
an unsupported fingerprint format or a changed build input.

The preparer verifies a thin arm64 Mach-O executable against its hashed Cargo root
artifact. It follows the root's exact fingerprint dependency values, preserving
64-bit values and dependency aliases. Every selected compiled unit must also appear
in the supplied compiler messages and locked metadata. Build scripts and procedural
macros retain separate roles. Host and target compilation directories are both
read when needed. Missing or ambiguous edges stop preparation rather than expanding
the selection to the whole lockfile.

`inputs/` retains the lock snapshots, metadata, compiler messages, selected unit
graphs, fingerprints, workspace terms, and supplemental source bytes. Generated
paths point to this checkout and its Cargo cache; preserve the directory with the
build evidence, but do not commit or publish it as source. It may contain local
paths. The checked-in tools and supplemental source catalog contain no private
checkout dependencies.

The distributed `bundle/selection.json` is a portable projection. It contains
package identities, compile roles, profiles, binary and lock hashes, and evidence
digests. Its `provenance.sourceSelectionSha256` identifies the complete private
input; the bundle manifest's `selectionSha256` binds the exact public selection
bytes. Local executable, cache, metadata, and evidence paths remain only in
`inputs/`. Notice provenance preserves upstream URLs and repository-relative paths;
workspace manifest provenance retains its verified digest and size. The collector
does not copy arbitrary input metadata into the public bundle. Preserve the private
inputs for a build audit, but distribute only the reviewed bundle.

A debug build can use the same process with its actual `debug` executable and build
capture. The selection records `debug`; that result is not release-profile
qualification. Custom profiles, universal binaries, non-Mac targets, moving Git
references, and vendored-only registries are intentionally unsupported by this preparer. Extend
and test the evidence mapping before using those configurations.

## Review the result

Inspect `bundle/inventory.json` and require `collectionStatus: "collected"` before
using the bundle for a release-purpose package. The collector can exit successfully
with `incomplete`: that preserves a useful diagnostic inventory, not a distributable
bundle. Missing selected packages require attention. Missing notices for excluded
platform packages remain explicitly listed and do not imply those packages ship.

The native workspace's notices come from `core/LICENSE-MIT`, with the package's
current MIT declaration checked in metadata. The resource monitor retains this
repository's `LICENSE`. Third-party archive notices are read directly from
checksum-verified `.crate` files; the preparer does not trust edited extracted
notice files in place of their archive.

For Git dependencies, the lock must contain a public GitHub HTTPS URL with a full
40-character `rev` equal to Cargo's resolved commit. The collector checks checkout
HEAD and rejects tracked changes or untracked inputs (except Cargo's `.cargo-ok`
marker). It reads the package manifest and applicable package/ancestor notice
files directly from that commit's Git objects and checks their checkout bytes.
Committed relative notice symlinks are resolved only to tracked files inside the
same repository; escaping links and cycles are rejected.
The portable inventory records repository, commit, manifest digest and notice
paths; Git packages have their own selection and counts, without invented registry
checksums. Run collection before changing or cleaning the Cargo checkout.

Some locked crates do not include their upstream notice text in their published
archive. `scripts/native-notice-supplements.json` pins the reviewed public source
texts in `scripts/native-notice-assets/` by package checksum and content hash. Each
record preserves the exact upstream repository/commit or canonical text source.
Generic license placeholders remain unchanged; no package copyright holder is
inferred. These assets make the present input preparation reproducible without
private prior-build evidence or a live upstream license website.

When updating a dependency that needs supplemental text:

1. Inspect its checksum-verified crate and VCS metadata, then locate the exact
   upstream revision and applicable notice files. Do not substitute a current
   default-branch license for a different published crate.
2. Preserve the source bytes and attribution verbatim under
   `scripts/native-notice-assets/`. Update the catalog's package checksum, source
   provenance, and content hash together. Do not apply another package's terms or
   fill generic copyright fields by inference.
3. Review the change and rerun preparation and collection for the new binaries.
   A changed checksum for an existing supplemental package stops preparation until
   its source record is reviewed. New packages without available notice text remain
   incomplete in the collector output.

The catalog is an available-text collection, not a statement that all obligations
are satisfied. A selected compilation unit does not prove retained machine-code
symbols or legal applicability. Non-Cargo libraries, Apple SDK terms, Rust toolchain
components, and source-availability obligations require their own review.

## Provision the verified bundle

Follow [distribution](meerkat-distribution.md#native-license-notices) after reviewing
the collection. Provision the gateway using the exact captured binary, rather than
running another implicit build:

```sh
node scripts/build-meerkat-runtime.ts \
  --binary "$gateway_target_dir/aarch64-apple-darwin/release/meerkat-desktop-stdio"
```

Keep a copy of the previous resource pair when replacing
`apps/server/resources/meerkat-runtime/` and
`apps/server/resources/native-notices/`. Copy the complete verified `bundle/` to the
latter directory. The desktop packager rechecks both binary and lock hashes, every
listed notice file, the selected graph, and repository license before accepting
these resources. It also compares the gateway's provisioned lock identity with
the current `core/Cargo.lock`, so an old runtime and matching old notices cannot
silently accompany a source upgrade. Changed binaries require new collection; do not edit manifest
hashes or status to make an old bundle pass. No publication occurs in this workflow.

## Test the preparation tools

These checks use disposable synthetic artifacts and require no Rust build, network,
provider credentials, or running app:

```sh
PYTHONDONTWRITEBYTECODE=1 python3.12 -m unittest discover \
  -s scripts -p test_prepare_native_notice_inputs.py -v
pnpm --dir scripts exec vp test run collect-native-license-notices.test.js
```

Fixture success checks the generator/collector contract. Before a binary release,
also run the workflow above against the actual release artifacts and retain that
specific selection, notice bundle, and acceptance evidence.
