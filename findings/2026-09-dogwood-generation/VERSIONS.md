# Versions — Dogwood Day 1–2 (2026-09-06 Asia/Taipei)

| Component | Value |
| --- | --- |
| Dogwood repo | https://github.com/dogwood-policy/dogwood |
| Dogwood commit | `c6237c88099b3f492ecc5fcee42df06a19224b97` (`c6237c88 Sync from internal source (2026-08-12) (#12)`) |
| dogwood CLI | `dogwood 1.0.0` (built from workspace crate `amzn-dogwood-cli`) |
| rustc | `rustc 1.90.0 (1159e78c4 2025-09-14)` via rustup |
| cargo | `cargo 1.90.0 (840b83a10 2025-07-30)` |
| OS | Debian GNU/Linux 13 (trixie), Linux 6.12.94+ x86_64 (assistant box, not WSL) |
| Build | `cargo build -p amzn-dogwood-cli --release` in `/workspace/vendor/dogwood` |
| Official baseline example | `dogwood-docs/examples/write_after_read/` (SellShares / ApproveSale) |

## Install / build commands

```bash
git clone --depth 1 https://github.com/dogwood-policy/dogwood /workspace/vendor/dogwood
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.90.0
. "$HOME/.cargo/env"
cd /workspace/vendor/dogwood && cargo build -p amzn-dogwood-cli --release
export PATH="/workspace/vendor/dogwood/target/release:$PATH"
dogwood --version
```

## Day-1 official replay (matches expected.out)

```bash
cd /workspace/vendor/dogwood/dogwood-docs/examples/write_after_read
dogwood validate policy.dw --policy-schema schema.cedarschema
dogwood replay policy.dw --policy-schema schema.cedarschema --trace trace.log
# @0 DENY / @100 ALLOW / @5000 DENY
```
