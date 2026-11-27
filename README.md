# pear-make

> Make binaries & application containers from source.

Builds with [bare-build](https://github.com/holepunchto/bare-build),
resolves and installs with [pear-repo](https://github.com/holepunchto/pear-repo).

- Git-repository tag-driven peer-to-peer over-the-air updates
- Toolchain and dependency resolution over the swarm
- Declarative builds in `pear.json#make`
- Configuration-driven deployment build releases
- Compile & install from a `git+pear://` source link

## Get

Comes with [Pear](https://install.pears.com):

```sh
pear make -h
```

Can also be installed with `pear` as `pear-make`

```sh
pear install pear://u3d888539k964t6omfzxdmf1a9c4jx4iiprm8jyt56x91izm78sy
```

```sh
pear-make -h
```

Can be used with `npx`:

```sh
npx pear-make -h
```

## Usage

Compile:

```sh
pear make
```

Verify toolchain dependencies, trigger dependency install

```sh
pear make resolve
```

Build a deployment folder:

```sh
pear make release
```

Install an app from source Git repo:

```sh
pear make install git+pear://<key>/my-app
pear make install ./app-repo
```

Install directly from a deployment build release:

```sh
pear make install ./out/release
```

Install a published app:

```sh
pear make install pear://<key>
```

### Flags

| Flag              | Where            | Description                                              |
| ----------------- | ---------------- | -------------------------------------------------------- |
| `--host`          | all              | Host to target, repeatable. Defaults to this host        |
| `--target`        | all              | Build only this target, repeatable                       |
| `--config`        | all              | Read `{ "make": {...} }` from this file, not pear.json   |
| `--yes`, `-y`     | all              | Answer yes to every confirmation                         |
| `--json`          | all              | Newline delimited JSON output                            |
| `--no-updates`    | all              | Do not start the updater                                 |
| `--version`, `-v` | all              | Version                                                  |
| `--help`, `-h`    | all              | Help                                                     |
| `--to`            | release, install | Deployment folder, or install destination                |
| `--unmet`, `-u`   | resolve          | Command to install the tree with. Default: `npm install` |
| `--update-window` | all              | Updater wait in ms. Default: 30000                       |

- Flags read the same before or after the command.
- `--to` is an error when `release` is a declared command, which writes where it writes.
- A bare host name is a `release` argument: `pear make release linux-x64 win32-x64`.

Anything after `--` is a bare-build option, overriding the build it belongs to:

```sh
pear make -- --sign --identity "Dev ID" --no-standalone
pear make --target production -- --minimum-version=12.0
```

## Configuration: `pear.json#make`

```json
{ "make": {} }
```

Every key is optional, and so is the file: `{ "make": {} }` is default when absent `pear.json`

- `out` – (optional) Where output and a release go, relative to the project. Defaults to `out`.
- `hosts` – (optional) What the project supports. Absent refuses none.
- `defaultTarget` – (optional) A build name, or an array of them, that a bare `pear make`
  makes instead of all of them. `--target` overrides it.
- `toolchain` – (optional) Tool name → entry, merged over the `npm` and `pear` defaults.
- `lifecycle` – (optional) `resolve`, `make`, `release`. See [Lifecycle](#lifecycle).
- `release` – (optional) `{ "target": "out/release" }`, where `pear make release` writes the
  deployment folder, relative to the project. `--to` overrides it for one run.
- `builds` – (optional) An array of bare-build options objects. See [Builds](#builds).

Set `lifecycle.make` to add capabilities such as notarizing & certificates.

### Builds

`make.builds` is one
[bare-build options object](https://github.com/holepunchto/bare-build#for-await-const-resource-of-buildentry-preflight-options)
per artifact, and nothing else:

```json
{
  "make": {
    "hosts": ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"],
    "builds": [
      {
        "name": "my-app",
        "entry": "build/index.js",
        "identifier": "com.example.my-app",
        "icon": { "darwin-*": "my-app.icns", "default": "my-app.png" },
        "package": { "darwin-*": false, "default": true },
        "sign": {
          "darwin-*": {
            "identity": "$MAC_CODESIGN_IDENTITY",
            "entitlements": "entitlements.plist",
            "hardenedRuntime": true
          },
          "win32-*": { "subject": "${WINDOWS_SUBJECT:-CN=My App Source Build}" }
        }
      }
    ]
  }
}
```

**Host maps.** Any option is `{ "<glob>": value, "default": value }`. First match wins, no match
omits the option.

**Variables.** `$VAR`, `${VAR}` and `${VAR:-fallback}` come from the environment, where empty is
unset. With no fallback an unset variable drops its option, with a warning — and drops the whole
group it is in, so no `MAC_CODESIGN_IDENTITY` is no signing rather than half-formed signing.

Anything after `--` is overrides configuration for **every** build in the run with the exception of `name` and `entry` which are unique to each build.

Without `make.builds` build information is inferred from `package.json`, if present. The `package.json` `productName` or `name` field and `main` field provide the UI `name` and `entrypoint`. The `package.json` `name` and `bin` field string provide standalone `name` and `entry`. If the `bin` field is an object the each key is a build `name` and each value is the `entry`.

### Lifecycle

The make lifecycle is `resolve -> make -> release`.

| Step      | Default                              | Run by              |
| --------- | ------------------------------------ | ------------------- |
| `resolve` | `pear make resolve -u "npm install"` | `pear make resolve` |
| `make`    | `pear make`                          | `pear make`         |
| `release` | `pear make release`                  | `pear make release` |

The `-u` flag is the fallback command to run for non-P2P deps.

### Toolchain

```
<scheme>:<locator>#semver:<range>
```

| Entry                                 | Means                                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| `host:#semver:>=10`                   | The machine's own copy.                                                             |
| `npm:#semver:^1.7.0`                  | By npm, under the key's own name.                                                   |
| `npm:other-name#semver:^1.7.0`        | By npm, under another name.                                                         |
| `pear://<key>#semver:^3.7.0`          | By `pear install`.                                                                  |
| `git+pear://<key>/tool#semver:^1.2.3` | By `pear make install`.                                                             |
| `^1.7.0`                              | Shorthand: `host:` for `npm`, `pear`, `node` and `git`, `npm:` for everything else. |

**Nothing is fetched.** The scheme is for provenance and remedy only.

Tools are expected to be on `PATH`.

## Resolve

```sh
pear make resolve
```

Each build tool in `pear.json#make.toolchain` is asserted, then the dependency tree is handed to npm.

```
bare-build 1.7.0 (bundled)
npm 11.21.3 (global)
pear 3.7.0 (host)
0 of 43 dependencies are pear links — the tree resolves off the swarm
```

- `bare-build 1.7.0 (bundled)` is the copy pear-make ships, never one on this machine
- `npm 11.21.3 (global)` is an `npm:` entry, found on `PATH` or by `npm ls -g`
- `pear 3.7.0 (host)` is a `host:`, `pear://` or `git+pear://` entry, found on `PATH`
- `0 of 43 dependencies are pear links` counts direct dependencies only, no lockfile read

- Out of range versions print causes a mitigation command to be output
- A `lifecycle.resolve` without `-u` refuses the handover
- Use `-u "npm ci"` where the project commits a lockfile

| Flag            | Does                                                             |
| --------------- | ---------------------------------------------------------------- |
| `--unmet`, `-u` | The command that installs a tree which is not all pear links     |
| `--host`        | Hosts a declared `lifecycle.resolve` command is spawned for      |
| `--config`      | Take the toolchain and lifecycle from this file, not `pear.json` |

## Compile

```sh
pear make
```

Make the binary or application container for the system host using [`bare-build`](https://github.com/holepunchto/bare-build) and `pear.json#make` as configuration.

Deslugifies bare-build slugification: `git-remote-git+pear` -> `git-remote-git-pear` -> `git-remote-git+pear`.

| Flag       | Does                                                             |
| ---------- | ---------------------------------------------------------------- |
| `--host`   | Hosts to build for, repeatable. Defaults to this one             |
| `--target` | Builds to make, by name, repeatable. Defaults to `defaultTarget` |
| `--config` | Take `make` from this file, not `pear.json`                      |
| `--`       | bare-build options, applied to every build in the run            |

## Release

```
out/
  make/
    darwin-arm64/<artifact>     ← pear make
    linux-x64/<artifact>
  release/                      ← pear make release
    package.json
    pear.json
    by-arch/<host>/app/<artifact>
```

- `out/release` is the deployment folder `pear stage` publishes and an install reads.
- The `pear-build` library writes it, with `pear.json` copied in beside `package.json`.
- An empty `out/make/<host>` is an error, naming the `pear make` to run.

| Flag       | Does                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `--to`     | Where the deployment folder goes, instead of `release.target`           |
| `--host`   | Which `out/make/<host>` to collect, repeatable. Bare host names do too  |
| `--config` | Take `make` from this file, and copy that file in beside `package.json` |

## Install

```sh
pear make install git+pear://<key>/my-app
```

Peer-to-peer git clone is resolved, compiled, released, then placed on system,.

- `git+pear://<fork>.<length>.<key>/my-app` is immutable: byte-identical every time.
- `git+pear://<key>/my-app` installs the latest git tag
- `git+pear://<key>/my-app#semver:^1.2.3` installs newest tag in semver range
- `git+pear://<key>/my-app#main` installs branch HEAD
- `git+pear://<key>/my-app#v2.0.0-rc.1` installs specific tag
- `git+pear://<key>/my-app#9f2c1ab` installs specific commit

| Flag          | Does                                                             |
| ------------- | ---------------------------------------------------------------- |
| `--to`        | Where the app goes, instead of this OS app directory             |
| `--host`      | Hosts to build and collect for, repeatable. Defaults to this one |
| `--yes`, `-y` | Answer the consent prompts a clone's own commands raise          |

## Development

```sh
npm install
npm start -- --help      # bare bin.mjs
npm test                 # brittle, on bare and node
npm run lint             # prettier check + lunte
npm run format           # prettier write
```

- Source asks for builtins, and `package.json#imports` maps them per runtime.
- Bare's resolver honours the map. Node resolves the builtin.
- `npm test` runs both. `test:bare` and `test:node` run one.
- The updater is Bare's alone, so its log is imported inside it.

pear-make builds itself off `package.json#bin`, with no builds declared:

```sh
npm run make
```

- `bare bin.mjs --updater` runs the daemon alone.

## LICENSE

Apache-2.0
