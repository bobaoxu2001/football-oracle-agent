# Development environment

## What this machine used for Phase 1 / 1.1

| Item | Value |
| --- | --- |
| OS | macOS (host CPU **arm64**) |
| Node | v22.22.0 **x64** via Rosetta (`/usr/local/opt/node@22`) |
| `process.arch` | `x64` |
| Package manager | npm (lockfile present) |
| esbuild in `node_modules` | `@esbuild/darwin-x64` only |

The host is Apple Silicon. The checked-out `node_modules` was installed under **x64 Node**, so default **arm64** Node fails:

```text
You installed esbuild for another platform … "@esbuild/darwin-x64"
needs "@esbuild/darwin-arm64"
```

That is an install/architecture mismatch, not an application bug.

## Preferred clean workflow

Use one Node architecture for install and run.

```bash
cd "/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent"
node -p "process.version + ' ' + process.arch"   # confirm arch
npm ci
npm test                 # Phase 1 + 1.1 gates
npm run backtest:pl      # held-out walk-forward + bootstrap
npm run dev
```

On Apple Silicon, either:

1. **Native arm64 Node** + `npm ci` (installs `@esbuild/darwin-arm64`), or
2. **x64 Node under Rosetta** (as used here) and keep using that same binary for `npm` and tests.

Do not mix an arm64 `node` with an x64 `node_modules`.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Tests | `npm test` |
| Phase 1 core | `npm run test:phase1` |
| Phase 1.1 gates | `npm run test:phase1-1` |
| PL backtest | `npm run backtest:pl` |
| WC bracket | `npm run validate:bracket` |
| Dev server | `npm run dev` |

No extra environment variables are required for the backtest. Snapshots write to `data/processed/predictions/snapshots.jsonl` unless `SNAPSHOT_STORE_PATH` is set (tests set a temp path).
