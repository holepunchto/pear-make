const build = require('bare-build/standalone')

module.exports = class App {
  static build({ entry, name, host, pathDir }) {
    return build(entry, {
      name,
      hosts: host,
      out: pathDir
    })
  }
}
