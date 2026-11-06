#!/usr/bin/env node
'use strict'

const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const host = process.env.HOST || `${process.platform}-${process.arch}`
const channel = process.env.CHANNEL || 'production'

const supportedHosts = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64'
])

if (!supportedHosts.has(host)) {
  console.error(`Unsupported platform/arch: ${host}`)
  console.error(
    'Supported targets: darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64'
  )
  process.exit(1)
}

const supportedChannels = new Set(['production', 'stage', 'dev'])

if (!supportedChannels.has(channel)) {
  console.error(`Unsupported channel: ${channel}`)
  console.error('Supported channels: production, stage, dev')
  process.exit(1)
}

const entry = path.join('targets', `bin.${channel}.mjs`)
const isWindows = process.platform === 'win32'
const buildArgs = ['--standalone', '--host', host, '--out', './out/make', entry]
const opts = {
  cwd: root,
  stdio: 'inherit'
}
const res = isWindows
  ? spawnSync('bare-build', buildArgs, { ...opts, shell: true })
  : spawnSync('bare-build', buildArgs, opts)
if (res.error) {
  console.error(res.error.message)
  process.exit(1)
}
if (res.status !== 0) process.exit(res.status || 1)
