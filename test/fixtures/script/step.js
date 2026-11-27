const fs = require('fs')
fs.writeFileSync(
  'step.json',
  JSON.stringify({
    argv: process.argv.slice(2),
    host: process.env.PEAR_MAKE_HOST,
    confirm: process.env.PEAR_MAKE_CONFIRM
  })
)
