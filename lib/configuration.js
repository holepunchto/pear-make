const fs = require('fs')
const path = require('path')
const process = require('process')
const { command, rest, sloppy, bail } = require('paparam')
const Repo = require('pear-repo')
const bareBuild = require('bare-build')
const bareBuildPkg = require('bare-build/package')
const manifest = require('../package.json')

const { HOSTS, current, assertHost } = Repo

/*
 * pear.json#make — structure & defaults. Every key is optional.
 *
 * {
 *   "make": {
 *     "out": "out",                           output root
 *     "hosts": ["darwin-arm64", "win32-x64"], supported hosts. absent refuses none
 *     "defaultTarget": ["production"],        what a bare `pear make` picks
 *
 *     "toolchain": {                          tool -> <scheme>:<locator>#semver:<range>
 *       "npm": "npm:#semver:>=10",            scheme is host:, npm:, pear:// or git+pear://
 *       "pear": "pear://<key>#semver:^3.7.0"  a bare range is host: for npm, pear, node,
 *     },                                      git and npm: for anything else
 *
 *     "lifecycle": {                                      spawn this, false to skip, absent for
 *       "resolve": "pear make resolve -u \"npm install\"", the default beside it. pear make is
 *       "make": "pear make",                               this pear-make, never spawned. The -u
 *       "release": "pear make release"                     resolves the tree: a declared resolve
 *     },                                                   without one is npm never touching it.
 *                                                          No toolchain step: resolve asserts it
 *
 *     "release": {
 *       "target": "out/release"                 deployment folder
 *     },
 *
 *     "builds": [                               each object is a bare-build options
 *       {                                       object, nothing else
 *         "name": "my-app",                     defaults to productName or name
 *         "entry": "index.js",                  bare-build entry. defaults to main
 *         "hosts": ["darwin-arm64"],            narrows this build to these hosts
 *         "standalone": true,                   or "package": true, never both
 *         "sign": { "identity": "$IDENTITY" }   any other key is a bare-build option
 *       }
 *     ]
 *   }
 * }
 */

const RESERVED = new Set(['name', 'entry', 'hosts'])

const MISSING = Symbol('missing')

const NAME = manifest.productName || manifest.name

const TOKENS = /(?:"[^"]*"|'[^']*'|[^\s"']+)+/g
const QUOTES = /"([^"]*)"|'([^']*)'/g

const isFlag = (key) => key.startsWith('flag ')
const isCommand = (key) => key.startsWith('command ')
const only = (def, keep) => Object.fromEntries(Object.entries(def).filter(([key]) => keep(key)))

let reader = null

function flagsOf(def) {
  const flags = only(def, isFlag)
  for (const sub of Object.values(only(def, isCommand))) Object.assign(flags, flagsOf(sub))
  return flags
}

function tokens(line) {
  return [...line.matchAll(TOKENS)].map((hit) => hit[0].replace(QUOTES, '$1$2'))
}

function environ() {
  return { ...process.env }
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`)
  }
}

function findRoot(from) {
  let dir = path.resolve(from)

  while (true) {
    if (fs.existsSync(path.join(dir, 'pear.json'))) return dir
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function isHostMap(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false

  const keys = Object.keys(value)
  if (keys.length === 0) return false

  return keys.every((key) => key === 'default' || key.includes('-') || key.includes('*'))
}

function globbed(glob, host) {
  if (glob === 'default' || glob === '*') return true
  const pattern = '^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
  return new RegExp(pattern).test(host)
}

function pick(map, host) {
  for (const key of Object.keys(map)) {
    if (key !== 'default' && globbed(key, host)) return map[key]
  }
  return 'default' in map ? map.default : undefined
}

function expand(value, env) {
  if (typeof value !== 'string') return value

  let missing = false

  const out = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced, fallback, bare) => {
      const name = braced || bare
      const found = env[name]
      if (found !== undefined && found !== '') return found
      if (fallback !== undefined) return fallback
      missing = true
      return ''
    }
  )

  return missing ? MISSING : out
}

function declared(line, builtin) {
  if (line === false) return false
  if (typeof line !== 'string' || line.trim() === '') return builtin

  return line.trim()
}

function camel(name) {
  return name.replace(/-([a-z0-9])/gi, (_, char) => char.toUpperCase())
}

function quoted(arg) {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

function line(invocation, name, step, opts = {}) {
  const { config = null, passed = [], flags = {} } = opts
  const args = [name]

  const hosts = step.hosts?.length > 0 ? step.hosts : flags.host || []
  const targets = step.target?.length > 0 ? step.target : flags.target || []

  for (const host of hosts) args.push('--host', host)
  for (const only of targets) args.push('--target', only)
  if (flags.to !== undefined && step.to === undefined) args.push('--to', quoted(flags.to))
  if (config !== null) args.push('--config', quoted(config))
  if (step.confirm === false) args.push('-y')
  if (passed.length > 0) args.push('--', ...passed.map(quoted))

  return [invocation, ...args].join(' ')
}

function spawning(invocation, name, opts = {}) {
  return (step) => step.shell(line(invocation, name, step, opts), name)
}

function noop() {}

module.exports = class Configuration {
  static LABEL = 'pear.json#make'

  static TOOLCHAIN = {
    npm: 'npm:#semver:>=10',
    pear: 'pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy#semver:^3.7.0'
  }

  static UNMET = 'npm install'

  static LIFECYCLE = {
    resolve: `pear make resolve -u "${Configuration.UNMET}"`,
    make: 'pear make',
    release: 'pear make release'
  }

  static NAME = NAME

  static cli(onbail = null) {
    const def = manifest.command
    const shared = only(def, isFlag)

    const commands = new Map(
      Object.entries(only(def, isCommand)).map(([key, sub]) => {
        const name = key.slice('command '.length)
        const declared = command(name, { ...sub, ...shared })
        return [name, sub.hidden === true ? declared.hide() : declared]
      })
    )

    const root = command(
      NAME,
      only(def, (key) => isCommand(key) === false),
      ...(onbail === null ? [] : [bail(onbail)]),
      ...commands.values()
    )

    commands.set('make', root)

    return { root, commands }
  }

  static route(input, cli = Configuration.cli()) {
    const scan = command(
      NAME,
      sloppy({ flags: true, args: true }),
      rest('[...rest]'),
      flagsOf(manifest.command)
    )

    scan.parse(input, { run: false, silent: true, bails: false })

    const first = (scan.rest || [])[0]
    const at = scan.indices.rest
    const found = cli.commands.has(first)
    const run = found ? cli.commands.get(first) : cli.commands.get('make')

    return {
      command: run,
      argv: found ? [...input.slice(0, at), ...input.slice(at + 1)] : input,
      mode: run === cli.root ? 'make' : run.name
    }
  }

  static reads(line) {
    const argv = tokens(line)
    const start = argv[0] === 'pear' && argv[1] === 'make' ? 2 : argv[0] === NAME ? 1 : -1

    if (start === -1) return null

    if (reader === null) reader = Configuration.cli()

    const { command: run, argv: rest, mode } = Configuration.route(argv.slice(start), reader)
    const read = run.parse(rest, { run: false, silent: true, bails: false })

    return read === null ? null : { command: mode, flags: read.flags }
  }

  static overrides(argv = []) {
    const options = {}

    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]

      if (token.startsWith('--') === false) {
        throw new Error(`${token} is not a bare-build option — those come as --flags, after --`)
      }

      const equals = token.indexOf('=')
      const inverse = token.startsWith('--no-')
      const name = camel(token.slice(inverse ? 5 : 2, equals === -1 ? token.length : equals))

      if (RESERVED.has(name)) {
        throw new Error(`--${name} comes from ${Configuration.LABEL}.builds, not from after --`)
      }

      let value = true

      if (equals !== -1) value = token.slice(equals + 1)
      else if (inverse) value = false
      else if (i + 1 < argv.length && argv[i + 1].startsWith('-') === false) value = argv[++i]

      options[name] = name in options ? [].concat(options[name], value) : value
    }

    return options
  }

  static cloning(opts = {}) {
    const { confirm = true, inherit = false, invocation, passed = [] } = opts

    return {
      label: Configuration.LABEL,
      confirm,
      inherit,
      lifecycle: {
        resolve: spawning(invocation, 'resolve'),
        make: spawning(invocation, 'make', { passed }),
        release: spawning(invocation, 'release')
      }
    }
  }

  static identifier(input) {
    return input
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
  }

  static artifact(build, host) {
    const { ext, packaged } = HOSTS[host]

    return build.package ? build.name + packaged : build.name + ext
  }

  static built(build, host) {
    return (
      Configuration.identifier(build.name) +
      (build.package ? HOSTS[host].packaged : HOSTS[host].ext)
    )
  }

  static resolve(value, host, env) {
    if (isHostMap(value)) value = pick(value, host)
    return expand(value, env)
  }

  static options(build, host, opts = {}) {
    const { env = {} } = opts
    const options = {}
    const dropped = []

    for (const key of Object.keys(build)) {
      if (RESERVED.has(key)) continue

      const value = Configuration.resolve(build[key], host, env)

      if (value === MISSING) {
        dropped.push({ key, reason: 'unset variable' })
        continue
      }

      if (value === false || value === null || value === undefined) continue

      if (Array.isArray(value)) {
        const items = []

        for (const item of value) {
          const resolved = expand(item, env)
          if (resolved === MISSING) continue
          items.push(resolved)
        }

        options[key] = items
        continue
      }

      if (value !== true && typeof value === 'object') {
        const group = Configuration.options(value, host, opts)

        if (group.dropped.length > 0) {
          dropped.push({ key, reason: group.dropped.map((entry) => entry.key).join(', ') })
          continue
        }

        options[key] = true
        Object.assign(options, group.options)
        continue
      }

      options[key] = value
    }

    return { options, dropped }
  }

  root
  file
  configured
  label = Configuration.LABEL
  pkg
  pear
  make
  lifecycle
  flags
  out
  makeDir
  releaseDir
  hosts
  builds
  defaultTarget
  toolchain

  constructor(from = '.', opts = {}) {
    const root = findRoot(from)

    if (root === null) {
      throw new Error(
        `No pear.json or package.json found in ${path.resolve(from)} or any parent directory.`
      )
    }

    const given = opts.config ? path.resolve(opts.config) : null

    this.root = root
    this.file = given || path.join(root, 'pear.json')
    this.configured = given !== null || fs.existsSync(this.file)

    this.pear = this.configured ? readJSON(this.file) : {}

    if (given !== null && (this.pear.make === null || typeof this.pear.make !== 'object')) {
      throw new Error(
        `${this.file} has no "make": a config read with --config must be { "make": { … } }`
      )
    }

    const pkgPath = path.join(root, 'package.json')

    this.pkg = fs.existsSync(pkgPath) ? readJSON(pkgPath) : {}
    this.make = this.pear.make && typeof this.pear.make === 'object' ? this.pear.make : {}

    const { make } = this
    const release = make.release || {}
    const lifecycle = make.lifecycle || {}

    const builds = make.builds !== undefined && make.builds !== null

    if (builds) {
      if (Array.isArray(make.builds) === false) {
        throw new Error(`${this.file}#make.builds is an array of bare-build options objects`)
      }

      if (make.builds.length === 0) {
        throw new Error(`${this.file}#make.builds declares no builds`)
      }
    }

    const steps = {
      resolve: declared(lifecycle.resolve, Configuration.LIFECYCLE.resolve),
      make: declared(lifecycle.make, Configuration.LIFECYCLE.make),
      release: declared(lifecycle.release, Configuration.LIFECYCLE.release)
    }

    const read = {}

    for (const name of Object.keys(steps)) {
      read[name] = steps[name] === false ? null : Configuration.reads(steps[name])

      if (read[name] !== null && read[name].command !== name) {
        throw new Error(
          `${this.file}#make.lifecycle.${name} is "${steps[name]}", which is ${NAME} ` +
            `${read[name].command} — a step may only name its own command`
        )
      }
    }

    this.out = path.resolve(root, make.out || 'out')
    this.makeDir = path.join(this.out, 'make')
    this.releaseDir = path.resolve(root, release.target || path.join(this.out, 'release'))

    const wanted = make.defaultTarget

    if (wanted !== undefined && wanted !== null) {
      const names = typeof wanted === 'string' ? [wanted] : wanted
      const strings = Array.isArray(names) && names.every((name) => typeof name === 'string')

      if (strings === false) {
        throw new Error(`${this.file}#make.defaultTarget is a build name, or an array of them`)
      }

      this.defaultTarget = names
    } else {
      this.defaultTarget = null
    }
    this.toolchain = { ...Configuration.TOOLCHAIN, ...(make.toolchain || {}) }

    this.hosts =
      Array.isArray(make.hosts) && make.hosts.length > 0 ? make.hosts.map(assertHost) : null

    this.lifecycle = {
      resolve: read.resolve === null ? steps.resolve : null,
      resolveUnmet: read.resolve === null ? false : (read.resolve.flags.unmet ?? false),
      make: read.make === null ? steps.make : null,
      release: read.release === null ? steps.release : null
    }

    this.flags = {
      resolve: read.resolve === null ? {} : read.resolve.flags,
      make: read.make === null ? {} : read.make.flags,
      release: read.release === null ? {} : read.release.flags
    }

    this.builds =
      this.lifecycle.make === null ? (builds ? this._builds(make.builds) : this._derived()) : null
  }

  _builds(declarations) {
    const builds = []
    const seen = new Set()

    for (let i = 0; i < declarations.length; i++) {
      const at = `${this.file}#make.builds[${i}]`
      const declaration = declarations[i]

      if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
        throw new Error(`${at} is an object of bare-build options`)
      }

      const build = this._build(declaration, at)

      if (seen.has(build.name)) {
        throw new Error(`${this.file}#make.builds has two builds named "${build.name}"`)
      }

      seen.add(build.name)
      builds.push(build)
    }

    return builds
  }

  _derived() {
    const { bin, main } = this.pkg
    const name = this.pkg.productName || this.pkg.name
    const builds = []

    if (typeof bin === 'string' && name) builds.push(this._build({ name, entry: bin }))
    else if (bin !== null && typeof bin === 'object') {
      for (const key of Object.keys(bin)) builds.push(this._build({ name: key, entry: bin[key] }))
    }

    if (name && (main || builds.length === 0)) {
      builds.push(this._build(main ? { name, entry: main } : { name }))
    }

    if (builds.length === 0) {
      throw new Error(
        `Nothing to build: ${this.file} declares no builds and package.json has no "bin",\n` +
          '"main" or "name" to derive one from. Declare make.builds, or a make.lifecycle.make.'
      )
    }

    return builds
  }

  _build(declared, at = `${this.file}#make.builds`) {
    const build = { ...declared }

    if (!build.name) build.name = this.pkg.productName || this.pkg.name

    if (typeof build.name !== 'string' || build.name === '') {
      throw new Error(
        `${at} has no "name", and package.json has no "productName" or "name" to take one from`
      )
    }

    if (build.standalone && build.package) {
      throw new Error(
        `${at} ("${build.name}") sets both "standalone" and "package" — bare-build treats them as mutually exclusive`
      )
    }

    if (build.standalone === undefined && !build.package) build.standalone = true
    if (!build.entry) build.entry = this.pkg.main || 'index.js'
    if (build.hosts) build.hosts.map(assertHost)

    return build
  }

  repo(opts = {}) {
    const {
      confirm = true,
      inherit = false,
      running = null,
      invocation = null,
      passed = [],
      unmet: asked = undefined
    } = opts

    const { lifecycle, make } = this

    const toolchain = { ...this.toolchain }
    delete toolchain['bare-build']

    const config = this.file === path.join(this.root, 'pear.json') ? null : this.file

    const here = running === 'make' ? ['make', 'resolve'] : [running]

    const step = (name) => {
      if (lifecycle[name] !== null) return lifecycle[name]
      if (here.includes(name) === false) {
        return spawning(invocation, name, {
          config,
          flags: this.flags[name],
          passed: name === 'make' ? passed : []
        })
      }
      return name === 'make' ? (opts) => this.build(opts) : null
    }

    const unmet = asked === undefined ? lifecycle.resolveUnmet : asked
    const met =
      unmet === false || invocation === null
        ? unmet
        : `${invocation} deps --resolved --with ${quoted(unmet)}`

    return {
      root: this.root,
      label: Configuration.LABEL,
      confirm,
      inherit,
      toolchain,
      hosts: this.hosts,
      out: make.out || 'out',
      release: {
        target: (make.release || {}).target || null,
        config: this.configured ? this.file : false
      },
      lifecycle: {
        resolveMet: met,
        resolveUnmet: unmet,
        resolve: step('resolve'),
        make: step('make'),
        release: step('release')
      }
    }
  }

  supported(host) {
    assertHost(host)

    if (!this.hosts) return host

    if (this.hosts.includes(host) === false) {
      throw new Error(`${host} is not in ${this.label}.hosts (${this.hosts.join(', ')})`)
    }

    return host
  }

  select(opts = {}) {
    const own = this.flags.make
    const hosts = opts.hosts?.length > 0 ? opts.hosts : own.host
    const target = opts.target?.length > 0 ? opts.target : own.target

    const wanted = (hosts?.length > 0 ? hosts : [current()]).map((host) => this.supported(host))
    const targets = target?.length > 0 ? target : this.defaultTarget
    const known = [...new Set(this.builds.map((build) => build.name))]
    const jobs = []

    if (targets) {
      for (const name of targets) {
        if (!known.includes(name)) {
          throw new Error(`No build named "${name}" — builds are: ${known.join(', ')}`)
        }
      }
    }

    for (const host of wanted) {
      for (const build of this.builds) {
        if (targets && !targets.includes(build.name)) continue
        if (build.hosts && !build.hosts.includes(host)) continue
        jobs.push({ build, host })
      }
    }

    if (jobs.length === 0) {
      throw new Error(`Nothing to build for ${wanted.join(', ')} — builds are: ${known.join(', ')}`)
    }

    return jobs
  }

  get installed() {
    const deps = { ...this.pkg.dependencies, ...this.pkg.optionalDependencies }

    if (Object.keys(deps).length === 0) return true

    return fs.existsSync(path.join(this.root, 'node_modules'))
  }

  builder(opts = {}) {
    const { push = noop } = opts
    const spec = this.toolchain['bare-build']
    const version = bareBuildPkg.version

    if (spec !== undefined) {
      const label = `${this.label}.toolchain`
      const entry = Repo.declared('bare-build', spec, { label })

      if (Repo.matches(version, entry.range) === false) {
        throw new Error(
          `pear-make ships bare-build ${version}, which does not satisfy ${label}["bare-build"] (${entry.range})\n` +
            'A toolchain entry is not fetched, so the bare-build a build gets is the one that ships.'
        )
      }
    }

    push('tool', { tool: 'bare-build', version, from: 'bundled' })

    return bareBuild
  }

  async build(opts = {}) {
    const { options: overrides = {}, push = noop } = opts

    const jobs = this.select(opts)
    const env = environ()
    const build = this.builder({ push })

    const results = []

    for (const { build: entry, host } of jobs) {
      const out = path.join(this.makeDir, host)
      const { options, dropped } = Configuration.options({ ...entry, ...overrides }, host, { env })

      for (const { key, reason } of dropped) push('dropped', { key, reason, host })
      for (const key of Object.keys(overrides)) push('overridden', { key, host })

      push('build', { name: entry.name, host, entry: entry.entry, out })

      fs.mkdirSync(out, { recursive: true })

      for await (const written of build(path.resolve(this.root, entry.entry), null, {
        ...options,
        name: entry.name,
        hosts: [host],
        out
      })) {
        push('wrote', { path: String(written), host })
      }

      const file = path.join(out, this.restore(entry, host, out, push))

      results.push({ name: entry.name, host, path: file })
      push('built', { name: entry.name, host, path: file })
    }

    return results
  }

  restore(build, host, out, push = noop) {
    const wanted = Configuration.artifact(build, host)
    const made = Configuration.built(build, host)

    if (made === wanted) return wanted

    const from = path.join(out, made)
    const to = path.join(out, wanted)

    if (!fs.existsSync(from)) throw new Error(`bare-build did not write ${from}`)

    const cased = from.toLowerCase() === to.toLowerCase()

    if (cased === false && fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })

    fs.renameSync(from, to)
    push('renamed', { from: made, to: wanted, host })

    return wanted
  }
}
