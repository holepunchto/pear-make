function setupLog(log, updater) {
  updater.on('updating', () => log.log('[updater] getting new update'))
  updater.on('updating-delta', (delta) => log.log('[updater]', delta))
  updater.on('updated', () => log.log('[updater] update complete... applying'))
  updater.on('update-applied', () =>
    log.log('[updater] applied update, restart to run latest version')
  )
  updater.on('error', (err) => log.error('[app:error]', err))
}

module.exports = setupLog
