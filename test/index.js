const { test } = require("brittle");
const fs = require("bare-fs");
const os = require("bare-os");
const path = require("bare-path");
const { spawnSync } = require("bare-subprocess");
const App = require("../app.js");

test("builds basic app", { timeout: 120000 }, async (t) => {
  const dir = path.join(os.cwd(), "test", "fixture");

  const entry = path.join(dir, "entry.js").replace(/\\/g, "/");
  const pathDir = path.join(dir, "out");
  const name = "bin";

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
  for await (const resource of App.build({ entry, host, pathDir, name })) {
    resources.push(resource);
  }

  t.alike(
    resources.map((resource) =>
      path.relative(pathDir, resource).replace(/\\/g, "/"),
    ),
    [
      `arm64/${name}.exe`,
      `x64/${name}.exe`,
      name,
      `aarch64/${name}`,
      `x86_64/${name}`,
    ],
    "yields expected executable paths",
  );

  const paths = {
    "win32-arm64": `arm64/${name}.exe`,
    "win32-x64": `x64/${name}.exe`,
    "darwin-arm64": `${name}`,
    "darwin-x64": name,
    "linux-arm64": `aarch64/${name}`,
    "linux-x64": `x86_64/${name}`,
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
