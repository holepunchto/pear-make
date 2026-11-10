# Changelog for pear-make

## v1.1.0

### Changes

- Start the updater daemon when `--version|-v` is passed, so version checks also pick up updates
- Update the production upgrade key

## v1.0.0

### Changes

- Split the updater logic out of `bin.mjs` into its own `lib/updater.js` module
- Bump `bare-build` to 1.6.2
- Reformat the codebase with Prettier

## v0.0.0-rc.1

### Features

- `--name` sets the application name
- `--version|-v` shows the CLI version
