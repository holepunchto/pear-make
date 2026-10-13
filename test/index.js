const { test } = require("brittle");
const fs = require("bare-fs");
const os = require("bare-os");
const path = require("bare-path");
const { spawnSync } = require("bare-subprocess");
const App = require("../app.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "swap-test-"));
}

test("builds basic app", { timeout: 120000 }, async (t) => {
  const dir = tmp();
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const entry = path.join(dir, "entry.js").replace(/\\/g, "/");
  const pathDir = path.join(dir, "out");

  fs.writeFileSync(entry, 'console.log("hello")');

  const host = [
    "win32-arm64",
    "win32-x64",
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ];

  const resources = [];
  for await (const resource of App.build({ entry, host, pathDir })) {
    resources.push(resource);
  }

  t.alike(
    resources.map((resource) =>
      path.relative(pathDir, resource).replace(/\\/g, "/"),
    ),
    [
      "arm64/pear-make.exe",
      "x64/pear-make.exe",
      "pear-make",
      "aarch64/pear-make",
      "x86_64/pear-make",
    ],
    "yields expected executable paths",
  );

  const paths = {
    "win32-arm64": "arm64/pear-make.exe",
    "win32-x64": "x64/pear-make.exe",
    "darwin-arm64": "pear-make",
    "darwin-x64": "pear-make",
    "linux-arm64": "aarch64/pear-make",
    "linux-x64": "x86_64/pear-make",
  };

  const currentHost = `${os.platform()}-${os.arch()}`;
  const executable = path.join(pathDir, paths[currentHost]);

  t.ok(executable, `executable found for host ${currentHost}`);
  t.ok(fs.existsSync(executable), "current host executable exists");

  const result = spawnSync(executable, [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.is(result.error, undefined, "executable starts successfully");
  t.is(result.status, 0, "executable exits successfully");
  t.is(result.stdout.toString().trim(), "hello", "prints expected output");
});
