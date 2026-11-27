#!/usr/bin/env node
import { persistent } from 'bare-storage'
import fs from 'fs'
import path from 'path'
import os from 'os'
import process from 'process'
import pkg from './package.json' with { type: 'json' }
import Repo from 'pear-repo'
import updaterLib from './lib/updater.js'
import Configuration from './lib/configuration.js'

const { spawnUpdater, runUpdater } = updaterLib
const { isLink, isPear, HOSTS, terminal, prompt } = Repo

const appName = pkg.productName || pkg.name

const executable = path.basename(process.execPath, path.extname(process.execPath))
const isDev = executable === 'bare' || executable === 'node'
const script = isDev ? process.argv[1] : null

const quoted = (arg) => (/\s/.test(arg) ? `"${arg}"` : arg)

const invocation = isDev
  ? `${quoted(process.execPath)} ${quoted(script)}`
  : quoted(process.execPath)

function refuse(bailed) {
  const what = bailed.flag ? '--' + bailed.flag.name : bailed.arg ? bailed.arg.value : ''
  const reason = bailed.reason.charAt(0) + bailed.reason.slice(1).toLowerCase().replace(/_/g, ' ')

  console.error(`${reason}: ${what}`.trim() + `\nRun ${appName} --help for usage.`)
  process.exitCode = 1
}

export default async function run(channel) {
  const cli = Configuration.cli(refuse)
  const given = process.argv.slice(isDev ? 2 : 1)
  const at = given.indexOf('--')
  const input = at === -1 ? given : given.slice(0, at)
  const passed = at === -1 ? [] : given.slice(at + 1)

  const { command, argv, mode } = Configuration.route(input, cli)
  const cmd = command.parse(argv, { run: false })

  if (cmd === null) return

  const flags = cmd.flags

  const storage = flags.storage || (isDev ? null : path.join(persistent(), appName))
  const dir = storage || path.join(os.tmpdir(), 'pear', appName)
  const wait = Number(flags.updateWindow) || 30000

  const updates = flags.updates !== false && isDev === false

  if (flags.version) {
    console.log(`v${pkg.version}`)
    startUpdater(dir, wait, updates)
    process.exit()
  }

  if (flags.updater) {
    await updater(dir, wait, channel)
    return
  }

  startUpdater(dir, wait, updates)

  const emit = reporter({ json: flags.json })

  const inherit = flags.json !== true
  const consented = flags.yes === true || process.env.PEAR_MAKE_CONFIRM === '0'
  const confirm = consented === false && inherit
  const target = flags.target
  const source = cmd.args.source || '.'
  const named = cmd.rest || []
  const stray = named.find((name) => name.startsWith('-'))

  if (stray) {
    console.error(`Flags come first: ${stray} was read as a path\nRun ${appName} --help for usage.`)
    process.exitCode = 1
    return
  }

  const paths = named.filter((name) => name in HOSTS === false)
  const hosts = [...(flags.host || []), ...named.filter((name) => name in HOSTS)]

  const cloned = isLink(source)
  const published = cloned === false && isPear(source)
  const remote = cloned || published

  if (remote && mode !== 'install') {
    console.error(
      `${source} is ${cloned ? 'a repository' : 'an app'} to install:\n` +
        `  ${appName} install ${source}`
    )
    process.exitCode = 1
    return
  }

  let configuration = null
  let repo = null

  try {
    configuration = remote ? null : new Configuration(source, { config: flags.config })

    const running = mode === 'deps' ? 'resolve' : mode

    repo = new Repo(
      remote
        ? Configuration.cloning({ confirm, inherit, invocation, passed })
        : configuration.repo({ confirm, inherit, invocation, passed, running, unmet: flags.unmet })
    )

    if (mode === 'resolve') configuration.builder({ push: emit })

    const failed = await step()

    if (failed !== null && failed !== undefined) process.exitCode = 1
  } catch (err) {
    if (flags.json) emit('error', { message: err.message })
    else console.error(err.message)
    process.exitCode = 1
  } finally {
    if (repo !== null) await repo.close()
  }

  async function step() {
    if (mode === 'resolve') return render(repo.resolve({ unmet: flags.unmet }), emit)

    if (mode === 'deps') {
      if (flags.resolved !== true) return render(repo.resolve(), emit)

      emit('peered', { total: null })

      return render(repo.resolve({ met: flags.with || 'npm install' }), emit)
    }

    if (mode === 'release') {
      const own = configuration.flags.release

      return render(
        repo.release({
          paths,
          hosts: hosts.length > 0 ? hosts : own.host || [],
          to: flags.to ?? own.to
        }),
        emit
      )
    }

    const options = Configuration.overrides(passed)

    if (mode === 'install') {
      return render(repo.install(source, { hosts, target, options, to: flags.to || null }), emit)
    }

    if (configuration.installed === false) {
      const unresolved = await render(repo.resolve({ unmet: flags.unmet }), emit)

      if (unresolved !== null && unresolved !== undefined) return unresolved
    }

    return render(repo.make(source, { hosts, target, options }), emit)
  }
}

function startUpdater(dir, wait, updates) {
  if (updates === false) return

  try {
    spawnUpdater(dir, process.execPath, isDev ? script : null, wait)
  } catch (err) {
    console.error('could not start updater:', err.message)
  }
}

async function updater(dir, wait, channel) {
  try {
    fs.mkdirSync(dir, { recursive: true })

    const { default: FileLog } = await import('bare-file-logger')
    const { default: Console } = await import('bare-console')

    const output = new FileLog(path.join(dir, 'updates.log'), { maxSize: 1024 * 1024 })
    const log = { log: new Console(output), close: () => output.close() }

    const instance = await runUpdater(pkg, dir, wait, isDev, log, channel)
    if (instance) instance.on('error', () => (process.exitCode = 1))
  } catch {
    process.exitCode = 1
  }
}

const lines = {
  tool: ({ tool, version, from }) => `${tool} ${version} (${from})`,
  peered: ({ total }) =>
    total === null
      ? 'every dependency is peer-to-peer — pear-repo has the tree'
      : `${total} dependencies, all peer-to-peer — pear-repo has the tree`,
  unresolved: ({ tool, source, message }) =>
    `  could not ask ${source} what ${tool} it has: ${message.split('\n')[0]}`,
  surveyed: ({ pear, total }) =>
    total === 0
      ? 'no dependencies'
      : `${pear} of ${total} dependencies are pear links` +
        (pear === total ? '' : ' — the tree resolves off the swarm'),
  blocked: ({ message }) => '  ' + message.split('\n')[0],
  approve: ({ what, command, cwd }) => `\n${what}: ${command}${cwd ? `\n  in ${cwd}` : ''}`,
  script: ({ command, asked }) => (asked ? null : command),
  preparing: ({ command, asked }) => (asked ? null : `prepare: ${command}`),
  resolved: ({ verlink }) => `version ${verlink}`,
  selected: ({ ref, id }) => `ref ${ref} (${id})`,
  unpinned: ({ link }) =>
    `${link} is unversioned — this build follows whatever the network serves now`,
  cloning: ({ link, ref }) => `cloning ${link}${ref ? ` at ${ref}` : ''}`,
  compiling: ({ host }) => `building for ${host}`,
  build: ({ name, host }) => `${name} ${host}`,
  built: ({ path }) => `  ${path}`,
  renamed: ({ from, to }) => `  renamed ${from} to ${to}`,
  dropped: ({ key, reason }) => `  ${key} dropped (${reason})`,
  overridden: ({ key }) => `  ${key} overridden on the command line`,
  releasing: ({ apps }) => `collecting ${apps.length} app${apps.length === 1 ? '' : 's'}`,
  mirrored: ({ to }) => `  ${to}`,
  released: ({ target }) => `deployment folder: ${target}`,
  installing: ({ target }) => `installing ${target}`,
  app: ({ app, version, dest }) => `  ${app} ${version} to ${dest}`,
  path: ({ dir }) => `  added to PATH: ${dir} — restart your shell for it to take effect`,
  installed: () => 'installed',
  output: ({ chunk }) => chunk.replace(/\n$/, ''),
  error: ({ message }) => message
}

function reporter(opts = {}) {
  const { json = false, write = console.log, fail = console.error } = opts

  return function (tag, data = {}) {
    if (json) return write(JSON.stringify({ cmd: 'make', tag, data }))
    if (!lines[tag]) return

    const line = lines[tag](data)

    if (line === null) return
    if (tag === 'error') return fail(line)

    write(line)
  }
}

async function render(stream, emit) {
  let failed = null

  for await (const { tag, data } of stream) {
    if (tag === 'error') failed = data

    emit(tag, data)

    if (tag === 'approve') data.answer(consent())
  }

  return failed
}

function consent() {
  if (terminal() === false) return true

  const said = prompt('Continue?')

  if (said !== null) return said

  console.error('\nno answer readable — use -y')

  return false
}

await run(isDev ? 'dev' : 'production')
