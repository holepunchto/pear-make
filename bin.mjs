import { command, arg, flag, summary } from 'paparam'
import { persistent } from 'bare-storage'
import FileLog from 'bare-file-logger'
import Console from 'bare-console'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import pkg from './package.json'
import App from './app.js'
import updaterLib from './lib/updater.js'

const { spawnUpdater, runUpdater } = updaterLib

const appName = pkg.productName || pkg.name
const isDev = path.basename(Bare.argv[0], path.extname(Bare.argv[0])) === 'bare'

export default async function run(channel) {
  const cmd = command(
    appName,
    summary(pkg.description),
    arg('[entry]', 'entry point of the app'),
    flag('--name <name>', 'application name'),
    flag('--host <host>', 'host to target (default: the current host)').multiple(),
    flag('--path <dir>', 'output directory'),
    flag('--storage <dir>', 'updater storage directory').hide(),
    flag('--update-window <ms>', 'updater wait in milliseconds').hide(),
    flag('--updater', 'run updater daemon').hide(),
    flag('--version|-v', 'version')
  )

  cmd.parse(Bare.argv.slice(isDev ? 2 : 1))
  if (cmd.flags.help) Bare.exit()

  if (cmd.flags.version) {
    console.log(`v${pkg.version}`)
    Bare.exit()
  }

  const storage = cmd.flags.storage || (isDev ? null : path.join(persistent(), appName))
  const dir = storage || path.join(os.tmpdir(), 'pear', appName)
  const wait = Number(cmd.flags.updateWindow) || 30000

  if (!cmd.flags.updater && !cmd.args.entry) {
    console.error(cmd.help())
    console.error('[app:error] missing <entry>')
    Bare.exit(1)
  }

  if (cmd.flags.updater) {
    fs.mkdirSync(dir, { recursive: true })
    const output = new FileLog(path.join(dir, 'updates.log'), { maxSize: 1024 * 1024 })
    const log = new Console(output)
    await runUpdater(pkg, dir, wait, isDev, output, log, channel)
  } else {
    spawnUpdater(dir, os.execPath(), isDev ? Bare.argv[1] : null, wait)
    console.log(`${appName} v${pkg.version}`)
    try {
      const entry = cmd.args.entry
      const name = cmd.flags.name
      const host = cmd.flags.host
      const pathDir = cmd.flags.path

      for await (const resource of App.build({ entry, name, host, pathDir })) {
        console.log(resource)
      }

      console.log('\nBuild finished.\n')
    } catch (err) {
      console.error('[app:error]', err.message)
    }
  }
}

if (isDev && path.basename(Bare.argv[1]) === 'bin.mjs') {
  await run('dev')
}
