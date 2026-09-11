# Browser runtime fork

This is the maintained `kkrausse/vivari` fork, on branch `browser-runtime`.
Upstream remains `https://github.com/maitrungduc1410/vivari`.

## Provenance

- Upstream base: `2629c71097238400c45aefa213ef61df4794c2b7`.
- Import commit: `27d9f3f`, the exact 34-file cumulative runtime delta formerly
  stored in `random/browser-container-poc/vivari/patches/0001-sqlite.patch`, plus
  the existing Bun lockfile.
- The live old checkout and saved patch were byte-compared before migration;
  all 34 imported files were compared against the old checkout.
- The original checkout was preserved. Subsequent changes are normal commits.
- Upstream MIT licensing and SQLite dependency licensing remain intact.

## Everyday development

Edit `packages/runtime`, `packages/kernel-host`, `packages/protocol`, or
`packages/core` directly. Do not edit generated `dist`, `pkg`, or `pkg-node`
files. Use Node 24.18.0 for the qualified headless checks and Bun for installation
and packaging. Rust 1.93.0, the `wasm32-unknown-unknown` and `wasm32-wasip1`
targets, and wasm-pack 0.13.1 are the qualified native build inputs.

```sh
bun install --frozen-lockfile
# Rebuild JS/workers after native artifacts have been built:
bun run build:core
# Focused real-worker compatibility checks:
node scripts/verify-runtime-contracts.mjs
node scripts/verify-runtime-contracts.mjs vm-import
# Existing full offline kernel/runtime verification:
bun run verify
```

The integration repo provides incremental native builds, immutable asset
retention, and distribution receipts. With sibling `random` and `vivari`
checkouts, run from `random/browser-container-poc/vivari`:

```sh
bun scripts/build-runtime.ts
```

`VIVARI_SOURCE=/absolute/path/to/checkout` selects another checkout. The build
accepts normal local edits; release qualification requires a committed source
tree. See the integration's `DEVELOPMENT.md` for all commands and exact flags.

## Test ownership

Generic compatibility fixtures live in `scripts/fixtures/runtime-contracts/`,
with `scripts/verify-runtime-contracts.mjs` running them through actual guest
process workers and requiring explicit completion markers. These initial
fixtures were moved unchanged from the integration repo. Browser-specific
qualification is still required; passing Node workers does not establish
browser scheduling or API availability.

OpenCode packaging, model/tool workflows, browser persistence qualification,
and workspace distribution checks live in `random/browser-container-poc`.
Add general runtime regression coverage here as capabilities evolve. Adding a
tool through supported runtime APIs should not require editing the kernel.

## Upgrades and publishing

Keep `origin` pointed at the fork and `upstream` at the original repository.
Fetch/merge upstream deliberately and qualify the resulting commit; builds do
not automatically rebase or reset source. Preserve history and record the
upstream base when upgrading. Use an exact fork revision for reproducible
distribution builds, with toolchain, lockfile, and asset hashes in the receipt.
Development builds must identify dirty source rather than claiming to be a
clean release. Do not publish secrets or generated build caches.
