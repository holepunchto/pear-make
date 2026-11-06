# pear-make

> Pear CLI app for building Pear CLI apps

A [Pear](https://install.pears.com) standalone-binary CLI that builds a `<source>` path with a `<target>` path.

Evergreen command via peer-to-peer over-the-air-updates.

## Install

With [Pear CLI](https://install.pears.com):

```sh
pear install pear://TODO
```

Via `npx`:

```sh
npx pear-install pear://TODO
```

## Usage

```sh
pear-make [flags] <entry>
```

Builds a standalone Pear CLI app by packaging the JavaScript code at `<entry>`.

| Flag                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `--name`                | application name                           |
| `--host`                | host to target (default: the current host) |
| `--path`                | output directory                           |
| `--update-window`, `-w` | wait for update (ms, default 30000)        |
| `--no-updates`, `-n`    | disable updates on this run                |
| `--version`, `-v`       | version                                    |
| `--help`, `-h`          | show help                                  |

## Over-the-air Updates

Unless the `--no-updates` flag is used, `pear-make` spawns a short-lived, detached updater daemon that checks the peer-to-peer network for a newer build and applies it in place, then exits.

It waits up to `--update-window` milliseconds (default 30s) to discover an update; a download already in progress is never cut off. Only one updater runs per storage directory at a time (a lock file), and its output is written to `<storage>/updates.log`.

Updates are published over-the-air with the [Pear CLI](https://docs.pears.com/reference/pear/cli/) and consumed via [pear-runtime](https://docs.pears.com/reference/pear/runtime/). The tracked link is picked from the `upgrade` field in [package.json](package.json) by channel (`production`, `stage`, or `dev`), matching whichever `targets/bin.<channel>.mjs` entrypoint the running binary was built from.

## Development

```sh
npm install
npm start -- --host <host> --path <path> <entry>    # bare bin.mjs --no-updates
npm test                                            # brittle-bare tests
npm run lint                                        # prettier check + lunte
npm run format                                      # prettier write
```

The `start` script passes `--no-updates` so local builds aren't swapped out while iterating. To exercise the updater in dev, run `bare bin.mjs --host <host> --path <path> <entry>` directly, or `bare bin.mjs --updater` to run the updater daemon on its own.

### Make Binaries

```sh
npm run make                 # auto-detect host os/arch, CHANNEL=production (default)
npm run make:stage           # auto-detect host os/arch, CHANNEL=stage
npm run make:dev             # auto-detect host os/arch, CHANNEL=dev
HOST=win32-arm64 npm run make
HOST=darwin-arm64 CHANNEL=stage npm run make
```

Hosts: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64` (via the `HOST` env var; defaults to the current host). Channels: `production` (default), `stage`, `dev` (via `CHANNEL`). Output goes to `out/make`.

Each channel builds from its own entrypoint (`targets/bin.production.mjs`, `targets/bin.stage.mjs`, `targets/bin.dev.mjs`), so the resulting binary is baked with the matching `upgrade` link for that channel. The per-host `make:<host>` scripts always build the `production` channel.

## License

Apache-2.0
