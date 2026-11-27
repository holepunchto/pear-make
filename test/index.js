const { test } = require('brittle')
const fs = require('fs')
const path = require('path')
const tmp = require('test-tmp')
const process = require('process')
const { spawn, spawnSync } = require('child_process')
const { platform, arch, isBare } = require('which-runtime')
const manifest = require('../package.json')
const bareBuild = require('bare-build/package')

const BIN = path.join(__dirname, '..', 'bin.mjs')
const FIXTURES = path.join(__dirname, 'fixtures')

const HOST = platform + '-' + arch
const OTHER = HOST === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'

const BUILD = { timeout: 300000 }

function copy(from, to) {
  fs.mkdirSync(to, { recursive: true })

  for (const name of fs.readdirSync(from)) {
    const source = path.join(from, name)
    const target = path.join(to, name)

    if (fs.statSync(source).isDirectory()) copy(source, target)
    else fs.writeFileSync(target, fs.readFileSync(source))
  }
}

async function fixture(t, name) {
  const dir = await tmp(t)

  copy(path.join(FIXTURES, name), dir)

  return dir
}

function make(dir, ...args) {
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' })
  const stdout = run.stdout === null ? '' : run.stdout.toString()
  const stderr = run.stderr === null ? '' : run.stderr.toString()
  const ops = []

  for (const line of stdout.split('\n')) {
    if (line.startsWith('{') === false) continue
    ops.push(JSON.parse(line))
  }

  return {
    status: run.status,
    stdout,
    stderr,
    ops,
    tags: ops.map((op) => op.tag),
    data(tag) {
      const found = ops.find((op) => op.tag === tag)
      return found === undefined ? null : found.data
    },
    all(tag) {
      return ops.filter((op) => op.tag === tag).map((op) => op.data)
    },
    names() {
      return ops.filter((op) => op.tag === 'built').map((op) => op.data.name)
    }
  }
}

const artifact = (dir, host, name) => path.join(dir, 'out', 'make', host, name)

test('builds - package.json#bin is a standalone each', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-bin')
  const run = make(dir, '--json')

  t.is(run.status, 0)
  t.alike(run.names(), ['one', 'two'], 'one build per bin entry, named after the key')
  t.alike(
    run.all('build').map((data) => data.entry),
    ['one.js', 'two.js'],
    'and entered at what the key points to'
  )
  t.ok(fs.existsSync(artifact(dir, HOST, 'one')))
  t.ok(fs.existsSync(artifact(dir, HOST, 'two')))
  t.absent(fs.existsSync(path.join(dir, 'pear.json')), 'with nothing declared at all')
})

test('builds - package.json#main is a build of its own', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-main')
  const run = make(dir, '--json')

  t.is(run.status, 0)
  t.alike(run.names(), ['Fixture'], 'named after productName')
  t.is(run.data('build').entry, 'index.js', 'entered at main')
  t.ok(fs.existsSync(artifact(dir, HOST, 'Fixture')), 'under the name as given, not the slug')
})

test('builds - a project with only a name', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-name')
  const run = make(dir, '--json')

  t.is(run.status, 0)
  t.alike(run.names(), ['fixture'])
  t.is(run.data('build').entry, 'index.js', 'off index.js, where main would point')
  t.ok(fs.existsSync(artifact(dir, HOST, 'fixture')))
})

test('builds - a declaration replaces package.json, it does not fill it in', BUILD, async (t) => {
  const dir = await fixture(t, 'declared')
  const run = make(dir, '--json')

  t.is(run.status, 0)
  t.alike(run.names(), ['first', 'second'], 'the declared builds, in the order declared')
  t.absent(run.names().includes('ignored'), 'and the bin package.json offers is not one of them')

  const picked = make(dir, '--json', '--target', 'second')

  t.alike(picked.names(), ['second'], '--target picks one by name')

  const missing = make(dir, '--target', 'nope')

  t.is(missing.status, 1)
  t.ok(
    missing.stderr.includes('No build named "nope" — builds are: first, second'),
    'and a name that is not there names the ones that are'
  )
})

test('builds - a name bare-build slugifies is renamed back', BUILD, async (t) => {
  const dir = await fixture(t, 'slug')
  const run = make(dir, '--json')

  t.is(run.status, 0)
  t.alike(run.data('renamed'), {
    from: 'git-remote-git-pear',
    to: 'git-remote-git+pear',
    host: HOST
  })
  t.ok(fs.existsSync(artifact(dir, HOST, 'git-remote-git+pear')), 'the name as declared')
  t.absent(fs.existsSync(artifact(dir, HOST, 'git-remote-git-pear')), 'and not the slug')
})

test('builds - two hosts in one pass, and a build can sit out', BUILD, async (t) => {
  const dir = await fixture(t, 'narrow')
  const run = make(dir, '--json', '--host', 'darwin-arm64', '--host', 'linux-x64')

  t.is(run.status, 0)
  t.alike(
    run.all('built').map((data) => [data.host, data.name]),
    [
      ['darwin-arm64', 'everywhere'],
      ['linux-x64', 'everywhere'],
      ['linux-x64', 'linux-only']
    ],
    'one pass, both hosts, and a declared hosts keeps that build off the other'
  )

  t.ok(fs.existsSync(artifact(dir, 'linux-x64', 'linux-only')))
  t.absent(fs.existsSync(artifact(dir, 'darwin-arm64', 'linux-only')))
})

test('builds - a host map picks per host, and a group drops whole', BUILD, async (t) => {
  const dir = await fixture(t, 'signed')

  const signed = make(dir, '--json', '--host', 'darwin-arm64')

  t.is(signed.status, 0, 'the build goes on unsigned')
  t.alike(
    signed.all('dropped'),
    [{ key: 'sign', reason: 'identity', host: 'darwin-arm64' }],
    'an unset variable takes the group it is in, not half of it'
  )

  const unsigned = make(dir, '--json', '--host', 'linux-x64')

  t.alike(unsigned.all('dropped'), [], 'a host the map says nothing about has no signing to drop')
})

test('builds - what comes after -- is bare-build', BUILD, async (t) => {
  const dir = await fixture(t, 'declared')

  const run = make(dir, '--json', '--host', OTHER, '--', '--identifier', 'io.fixture.app')

  t.is(run.status, 0)
  t.alike(
    run.all('overridden'),
    [
      { key: 'identifier', host: OTHER },
      { key: 'identifier', host: OTHER }
    ],
    'every build takes it, and says so'
  )

  const own = make(dir, '--host', OTHER, '--', '--name', 'other')

  t.is(own.status, 1)
  t.ok(
    own.stderr.includes('--name comes from pear.json#make.builds'),
    'the options pear-make sets itself are not reachable this way'
  )

  const loose = make(dir, '--host', OTHER, '--', 'standalone')

  t.is(loose.status, 1)
  t.ok(loose.stderr.includes('is not a bare-build option'), 'and a bare word is no option at all')
})

test('builds - what a build cannot be', async (t) => {
  const dir = await fixture(t, 'invalid')

  const refusals = {
    'not-an-array.json': 'builds is an array of bare-build options objects',
    'empty.json': 'builds declares no builds',
    'item-not-an-object.json': 'is an object of bare-build options',
    'two-of-a-name.json': 'has two builds named "a"',
    'both-modes.json': 'mutually exclusive',
    'unknown-host.json': 'Unsupported host',
    'bad-default-target.json': 'defaultTarget is a build name, or an array of them'
  }

  for (const [config, message] of Object.entries(refusals)) {
    const run = make(dir, '--config', config)

    t.is(run.status, 1, config)
    t.ok(run.stderr.includes(message), message)
  }
})

test('builds - nothing to build says what is missing', async (t) => {
  const dir = await fixture(t, 'nameless')
  const run = make(dir)

  t.is(run.status, 1)
  t.ok(run.stderr.includes('Nothing to build'))
  t.ok(run.stderr.includes('"bin"'), 'and what package.json would have to say')
})

test('builds - a host the project does not support', async (t) => {
  const dir = await fixture(t, 'narrow')
  const run = make(dir, '--host', 'win32-x64')

  t.is(run.status, 1)
  t.ok(run.stderr.includes('win32-x64 is not in pear.json#make.hosts (darwin-arm64, linux-x64)'))
})

test('config - a file passed in stands in for pear.json', BUILD, async (t) => {
  const dir = await fixture(t, 'elsewhere')
  const run = make(dir, '--json', '--config', 'make.json')

  t.is(run.status, 0)
  t.is(run.data('build').entry, 'entry.js', 'the file passed in is the configuration')

  const release = make(dir, '--json', '--config', 'make.json', 'release')

  t.is(release.status, 0)
  t.alike(
    JSON.parse(fs.readFileSync(path.join(dir, 'out', 'release', 'pear.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(dir, 'make.json'), 'utf8')),
    'and travels into the deployment folder as the pear.json of it'
  )
})

test('release - the deployment folder is what an install reads', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-name')

  make(dir, '--host', HOST)

  const run = make(dir, '--json', 'release')
  const target = path.join(dir, 'out', 'release')

  t.is(run.status, 0)
  t.is(run.data('releasing').target, target)
  t.is(run.data('released').target, target)
  t.ok(fs.existsSync(path.join(target, 'package.json')), 'the manifest an install reads')
  t.absent(
    fs.existsSync(path.join(target, 'pear.json')),
    'and no config, since this project has none'
  )
  t.ok(
    fs.existsSync(path.join(target, 'by-arch', HOST, 'app', 'fixture')),
    'and the binary in the by-arch layout'
  )

  const nothing = await fixture(t, 'derived-name')
  const empty = make(nothing, '--json', 'release')

  t.is(empty.status, 1)
  t.ok(empty.data('error').message.includes('pear make'), 'nothing built names the make to run')
})

test('release - a host is an argument of its own, and flags come first', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-name')

  make(dir, '--host', OTHER)

  const run = make(dir, '--json', 'release', OTHER)

  t.is(run.status, 0)
  t.ok(run.all('mirrored').length > 0, 'a bare host name is read as a host, not as a path')

  const stray = make(dir, 'release', OTHER, '--json')

  t.is(stray.status, 1)
  t.ok(
    stray.stderr.includes('Flags come first: --json was read as a path'),
    'and a flag behind one is refused rather than taken as a directory'
  )
})

test('release - --to is refused when the project collects its own', async (t) => {
  const dir = await fixture(t, 'collect')
  const run = make(dir, 'release', '--to', path.join(dir, 'elsewhere'))

  t.is(run.status, 1)
  t.ok(run.stderr.includes('cannot be honoured by "./collect.sh"'))
})

test('lifecycle - a project that wraps the build declares the wrapper', BUILD, async (t) => {
  const dir = await fixture(t, 'wrapper')
  const run = make(dir, '--json', '--host', OTHER)

  t.is(run.status, 0)
  t.is(run.data('script').command, 'npm run make -- --host ' + OTHER, 'the project own command')
  t.is(run.data('script').step, 'make')
  t.absent(run.tags.includes('built'), 'and pear-make builds nothing itself')

  t.alike(
    JSON.parse(fs.readFileSync(path.join(dir, 'step.json'), 'utf8')),
    { argv: ['--host', OTHER], host: OTHER, confirm: '0' },
    'the host it is for, and that nobody is watching'
  )
})

test('lifecycle - a make script in package.json is nobody to pear-make', BUILD, async (t) => {
  const dir = await fixture(t, 'script')
  const run = make(dir, '--json', '--host', OTHER)

  t.is(run.status, 0)
  t.absent(run.tags.includes('script'), 'an undeclared script is not a step')
  t.alike(run.names(), ['fixture'], 'the build is pear-make own, off package.json')
  t.absent(fs.existsSync(path.join(dir, 'step.json')), 'and the script never ran')

  const released = make(dir, '--json', 'release', OTHER)

  t.is(released.status, 0)
  t.absent(released.tags.includes('script'), 'nor does it make release a script')
  t.ok(released.data('released'), 'which would have been npm run release, missing or not')
})

test('lifecycle - a script that calls pear make does not call itself', BUILD, async (t) => {
  const dir = await fixture(t, 'alias')
  const run = make(dir, '--json', '--host', OTHER)

  t.is(run.status, 0)
  t.absent(run.tags.includes('script'), 'no subprocess, so nothing to recurse into')
  t.alike(run.names(), ['fixture'])
})

test('lifecycle - a step naming pear make is this process', BUILD, async (t) => {
  const dir = await fixture(t, 'in-process')
  const run = make(dir, '--json', '--host', OTHER)

  t.is(run.status, 0)
  t.absent(run.tags.includes('script'), 'never a subprocess, and never one off PATH')
  t.alike(run.names(), ['picked'], 'the flags on the step are what it builds')

  const own = make(dir, '--json', '--host', OTHER, '--target', 'unpicked')

  t.alike(own.names(), ['unpicked'], 'and the run overrides them one flag at a time')
})

test('lifecycle - false skips a step, toolchain and all', async (t) => {
  const dir = await fixture(t, 'no-resolve')
  const run = make(dir, '--json', 'resolve')

  t.is(run.status, 0)
  t.alike(run.tags, ['tool', 'final'], 'bare-build answers for itself, and nothing else runs')
  t.is(run.data('tool').tool, 'bare-build')
})

test('resolve - the toolchain is asserted, then the tree is handed on', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-name')
  const run = make(dir, '--json', 'resolve', '-u', 'echo unmet')

  t.is(run.status, 0)
  t.is(run.tags[0], 'tool', 'the toolchain comes first')
  t.alike(run.data('tool'), { tool: 'bare-build', version: bareBuild.version, from: 'bundled' })
  t.alike(run.data('surveyed'), { pear: 0, unmet: 0, total: 0 }, 'then the dependencies, counted')
  t.ok(
    run.all('script').some((data) => data.command.includes('deps --resolved --with "echo unmet"')),
    'and the tree goes to the command the run named, not only the one configured'
  )
})

test('resolve - a toolchain pear-make cannot satisfy', async (t) => {
  const dir = await fixture(t, 'old-bare-build')
  const run = make(dir, '--json')

  t.is(run.status, 1)
  t.ok(run.data('error').message.includes('pear-make ships bare-build ' + bareBuild.version))
  t.ok(run.data('error').message.includes('^99.0.0'), 'and what the project asked for')
})

test('report - the ops are what the output says', BUILD, async (t) => {
  const dir = await fixture(t, 'derived-name')
  const run = make(dir, '--host', OTHER)

  t.is(run.status, 0)
  t.absent(run.stdout.includes('undefined'), 'a tag with no line of its own prints nothing')

  t.alike(run.stdout.split('\n').filter(Boolean), [
    `bare-build ${bareBuild.version} (bundled)`,
    `fixture ${OTHER}`,
    '  ' + artifact(dir, OTHER, 'fixture')
  ])

  const json = make(dir, '--json', '--host', OTHER)

  t.is(
    json.ops.length,
    json.stdout.split('\n').filter(Boolean).length,
    '--json is one object per line and no prose'
  )
  t.alike(
    json.ops.filter((op) => op.cmd !== 'make'),
    [],
    'every one of them named for the command'
  )
  t.is(json.all('final').length, 1, 'and exactly one final ends it')
})

test('report - a failure is on stderr, whoever raised it', async (t) => {
  const parsed = make(await fixture(t, 'invalid'), '--config', 'empty.json')

  t.is(parsed.status, 1)
  t.is(parsed.stdout, '', 'thrown before the stream opens')
  t.ok(parsed.stderr.includes('declares no builds'))

  const streamed = make(await fixture(t, 'declared'), '--target', 'nope')

  t.is(streamed.status, 1)
  t.is(streamed.stdout, '', 'and carried by it')
  t.ok(streamed.stderr.includes('No build named "nope"'))
})

test('updater - a dev run starts none', async (t) => {
  const dir = await fixture(t, 'derived-name')
  const storage = await tmp(t)

  const run = make(dir, '--version', '--storage', storage)

  t.is(run.status, 0)
  t.ok(run.stdout.startsWith('v'))
  t.alike(fs.readdirSync(storage), [], 'a runtime running a script has nothing to swap')

  const off = make(dir, '--version', '--no-updates', '--storage', storage)

  t.is(off.status, 0)
  t.alike(fs.readdirSync(storage), [], 'and --no-updates is the standing answer anyway')
})

test('updater - the daemon takes the storage directory, and one has it at a time', async (t) => {
  if (isBare === false) {
    t.pass('the daemon only runs on bare')
    return
  }

  const storage = await tmp(t)

  const held = spawn(process.execPath, [
    BIN,
    '--updater',
    '--storage',
    storage,
    '--update-window',
    '20000'
  ])

  t.teardown(() => held.kill())

  for (let i = 0; fs.existsSync(path.join(storage, 'updater.lock')) === false; i++) {
    t.ok(i < 300, 'the daemon takes the lock')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  t.ok(fs.existsSync(path.join(storage, 'updates.log')), 'the log is where the storage is')
  t.ok(fs.existsSync(path.join(storage, 'pear-runtime')), 'and so is what it mirrors into')

  const second = spawnSync(
    process.execPath,
    [BIN, '--updater', '--storage', storage, '--update-window', '1'],
    { encoding: 'utf8' }
  )

  t.is(second.status, 0, 'a second one is not an error')
  t.ok(
    fs.readFileSync(path.join(storage, 'updates.log'), 'utf8').includes('already running'),
    'it says so in the log and leaves the first to it'
  )
})

function cli(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' }).stdout.toString()
}

function flagsIn(text) {
  const found = new Set((text.match(/^ {2}(--[a-z-]+)/gm) || []).map((line) => line.trim()))
  found.delete('--help')
  return found
}

function declaredIn(def) {
  return new Set(
    Object.keys(def)
      .filter((key) => key.startsWith('flag '))
      .map((key) => key.slice('flag '.length).split('|')[0].split(' ')[0])
  )
}

function regexesIn(source) {
  const found = []

  for (let i = 0; i < source.length; i++) {
    const char = source[i]

    if (char === '/' && source[i + 1] === '/') {
      const line = source.indexOf('\n', i)
      if (line === -1) break
      i = line
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close === -1) break
      i = close + 1
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      i = ends(source, i, char)
      continue
    }

    if (char !== '/') continue

    let prev = i - 1
    while (prev >= 0 && /\s/.test(source[prev])) prev--
    if (prev >= 0 && /[\w$)\]]/.test(source[prev])) continue

    const close = ends(source, i, '/')
    let end = close + 1
    while (end < source.length && /[dgimsuvy]/.test(source[end])) end++

    found.push(source.slice(i, end))
    i = end - 1
  }

  return found
}

function ends(source, start, quote) {
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i]

    if (char === '\\') {
      i++
      continue
    }

    if (char === quote) return i

    if (quote === '/' && char === '[') {
      while (++i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i++
      }
    }
  }

  return source.length
}

test('command - the declaration is the CLI', (t) => {
  const root = manifest.command
  const commands = Object.keys(root)
    .filter((key) => key.startsWith('command '))
    .map((key) => key.slice('command '.length))

  t.alike(
    commands,
    ['make', 'resolve', 'deps', 'release', 'install'],
    'five commands, make first because it is the default'
  )
  t.is(root.summary, manifest.description, 'the summary is the package description')

  const help = cli('--help')
  const printed = flagsIn(help)
  const declared = declaredIn(root)

  for (const hidden of ['--storage', '--update-window', '--updater']) {
    t.ok(declared.has(hidden), `${hidden} is declared`)
    t.absent(printed.has(hidden), 'and hidden')
    declared.delete(hidden)
  }

  t.alike([...declared].sort(), [...printed].sort(), 'every root flag is declared, and no others')

  for (const name of commands) {
    const listed = new RegExp(`^  ${name} `, 'm').test(help)

    if (root[`command ${name}`].hidden === true) t.absent(listed, `${name} is declared, and hidden`)
    else t.ok(listed, `${name} is listed`)

    const own = cli(name, '--help')
    const mine = declaredIn(root[`command ${name}`])

    t.alike(
      [...flagsIn(own)].sort(),
      [...new Set([...mine, ...declared])].sort(),
      `${name} takes its own flags and the ones every command takes`
    )
  }

  t.ok(/^  \[source\] {2,}Optional\./m.test(help), 'the project to build is the root argument')
  t.ok('arg [source]' in root, 'declared there, because make is the root')
  t.is(
    cli('make', '--help'),
    help,
    'and `make` in the command list points back at it rather than copying it'
  )

  const bin = fs.readFileSync(BIN, 'utf8')

  t.ok(bin.includes('Configuration.cli('), 'the CLI is built from that declaration')
  t.absent(/\bflag\(/.test(bin), 'nothing is declared twice')

  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'configuration.js'), 'utf8')

  t.absent(/\bflag\(/.test(lib), 'and nowhere else either')
  t.ok(lib.includes("require('paparam')"), 'a lifecycle line is read by the declaration')
  t.ok(lib.includes('Configuration.reads('), 'which is what reads one')

  const spelled = regexesIn(lib).filter((regex) => regex.includes('--'))

  t.absent(
    spelled.length > 0,
    spelled.length > 0
      ? `no flag is spelled out in a regex: ${spelled.join(' ')}`
      : 'no flag is spelled out in a regex'
  )
})

test('command - make is the default, by omission or with a source', (t) => {
  t.ok(cli('--version').startsWith('v'), 'a flag alone is still a make')
  t.ok(cli('install', '--help').includes('install [flags] [source]'), 'a command word is honoured')
  t.ok(
    cli('--json', 'resolve', '--help').includes('resolve [flags] [source]'),
    'and a flag in front of it does not hide it'
  )

  const link = 'git+pear://g3dgn6r8gey3uao3kfcfd7tgcxrx8upq4bee6g9ndkbt7c79qnky/app'
  const refused = spawnSync(process.execPath, [BIN, link], { encoding: 'utf8' })

  t.is(refused.status, 1)
  t.ok(
    refused.stderr.includes('install ' + link),
    'a repository is not built in place, and is told what to run instead'
  )

  const drive = 'pear://g3dgn6r8gey3uao3kfcfd7tgcxrx8upq4bee6g9ndkbt7c79qnky'
  const built = spawnSync(process.execPath, [BIN, drive], { encoding: 'utf8' })

  t.is(built.status, 1)
  t.ok(built.stderr.includes('install ' + drive), 'and an app that is already built is installed')
})

test('lib - a build, and nothing else', (t) => {
  const lib = path.join(__dirname, '..', 'lib')
  const external = new Set()

  t.alike(
    fs.readdirSync(lib).sort(),
    ['configuration.js', 'log.js', 'updater.js'],
    'a build, the updater that keeps this evergreen, and where it writes'
  )

  for (const name of fs.readdirSync(lib)) {
    if (name === 'updater.js' || name === 'log.js') continue

    const body = fs.readFileSync(path.join(lib, name), 'utf8')

    t.absent(/bare-subprocess|bare-tty/.test(body), 'spawning and asking are pear-repo own')

    for (const found of body.matchAll(/require\(['"]([^'".#][^'"]*)['"]\)/g)) {
      external.add(found[1])
    }
  }

  t.absent(external.has('pear-runtime'), [...external].sort().join(' '))
  t.ok(external.has('bare-build'), 'bare-build ships here')
  t.ok(external.has('pear-repo'), 'and everything that is not a build is pear-repo')
  t.absent(external.has('hyperdrive'), 'which is where the swarm went')
  t.absent(fs.existsSync(path.join(__dirname, '..', 'index.js')), 'pear-make is a command')
  t.absent('main' in manifest, 'so it has no main')
  t.absent('exports' in manifest, 'and nothing to export')
})
