const daemon = require('bare-daemon')
const fs = require('bare-fs')
const fsx = require('fs-native-extensions')
const path = require('bare-path')
const os = require('bare-os')
const { once } = require('bare-events')
const ReadyResource = require('ready-resource')
const goodbye = require('graceful-goodbye')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const PearRuntime = require('pear-runtime')
const { isWindows } = require('which-runtime')
const setupLog = require('./log.js')

class Updater extends ReadyResource {
  constructor(dir, app, version, upgrade, name, wait) {
    super()

    this.dir = dir
    this.app = app
    this.version = version
    this.upgrade = upgrade
    this.name = name
    this.wait = wait

    this.store = null
    this.swarm = null
    this.pear = null
    this.applying = null
    this.timer = null
  }

  async _open() {
    this.store = new Corestore(path.join(this.dir, 'pear-runtime', 'corestore'))
    this.swarm = new Hyperswarm()

    try {
      this.pear = new PearRuntime({
        dir: this.dir,
        app: this.app,
        updates: true,
        version: this.version,
        upgrade: this.upgrade,
        name: this.name,
        store: this.store,
        swarm: this.swarm
      })

      this.pear.on('error', (err) => this.emit('error', err))
      this.pear.updater.on('error', (err) => this.emit('error', err))
      this.pear.updater.on('updating', () => this.emit('updating'))
      this.pear.updater.on('updating-delta', (delta) => this.emit('updating-delta', delta))

      this.pear.updater.on('updated', () => {
        this.emit('updated')
        this.applying = this._applyUpdate()
      })

      await this.pear.ready()

      this.swarm.on('connection', (connection) => this.store.replicate(connection))
      this.swarm.join(this.pear.updater.drive.core.discoveryKey, {
        client: true,
        server: false
      })

      this.timer = setTimeout(async () => {
        try {
          if (this.pear.updater.updating) {
            // a failed download emits 'error' (already logged); just proceed to close
            await once(this.pear.updater, 'updated').catch(() => {})
          }
          await this.applying
          await this.close()
        } catch (err) {
          this.emit('error', err)
        }
      }, this.wait)
    } catch (err) {
      await this._close().catch(() => {})
      throw err
    }
  }

  async _applyUpdate() {
    try {
      await this.pear.updater.applyUpdate()
      this.emit('update-applied')
    } catch (err) {
      this.emit('error', err)
    }
  }

  async _close() {
    clearTimeout(this.timer)
    await this.swarm?.destroy()
    await this.pear?.close()
    await this.store?.close()
  }
}

function spawnUpdater(dir, app, entrypoint, updateWindow) {
  const args = entrypoint === null ? [] : [entrypoint]
  args.push('--updater', '--storage', dir)
  if (updateWindow !== undefined) {
    args.push('--update-window', String(updateWindow))
  }
  return daemon.spawn(app, args)
}

function acquireLock(dir) {
  const fd = fs.openSync(path.join(dir, 'updater.lock'), 'a+')
  if (fsx.tryLock(fd)) return fd
  fs.closeSync(fd)
  return -1
}

function releaseLock(fd) {
  fsx.unlock(fd)
  fs.closeSync(fd)
}

async function runUpdater(pkg, dir, wait, isDev, output, log, channel) {
  const lock = acquireLock(dir)
  if (lock === -1) {
    log.log('[updater] another updater is already running, exiting')
    output.close()
    return null
  }

  try {
    const appName = pkg.productName || pkg.name
    const updater = new Updater(
      dir,
      isDev ? null : os.execPath(),
      pkg.version,
      pkg.upgrade[channel],
      isWindows ? appName + '.exe' : appName,
      wait
    )
    setupLog(log, updater)

    goodbye(async () => {
      try {
        await updater.close()
      } finally {
        releaseLock(lock)
        output.close()
      }
    })

    await updater.ready()
    return updater
  } catch (err) {
    log.error('[app:error]', err)
    throw err
  }
}

module.exports = {
  spawnUpdater,
  runUpdater
}
