const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = fs.realpathSync(process.env.KIT_DEPLOYMENT_ROOT);
const layer = fs.realpathSync(process.env.KIT_FRAMEWORK_ROOT);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const inside = (file, parent) => file === parent || file.startsWith(parent + path.sep);
const nameOf = (name) => (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);
const original = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
  if (
    parent &&
    inside(parent.filename, path.join(root, 'lib')) &&
    !Module.isBuiltin(name) &&
    !name.startsWith('.') &&
    !manifest.dependencies?.[nameOf(name)]
  )
    throw Error('Undeclared kit runtime dependency: ' + name);
  const file = original.call(this, name, parent, ...rest);
  if (!Module.isBuiltin(name) && !inside(fs.realpathSync(file), root) && !inside(fs.realpathSync(file), layer))
    throw Error('Kit runtime dependency escaped isolated upload/layer: ' + name);
  return file;
};
let externalNetworkAttempts = 0;
const deny = () => {
  externalNetworkAttempts++;
  throw Error('Kit startup attempted external network');
};
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  const host = typeof first === 'object' ? first.host : typeof args[1] === 'string' ? args[1] : 'localhost';
  const port = typeof first === 'object' ? first.port : first;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host ?? 'localhost') || Number(port) !== Number(process.env.PORT))
    return deny();
  return connect.apply(this, args);
};
global.fetch = deny;
// Block DNS and datagram egress too: SDK discovery must not read metadata/ADC.
const dns = require('node:dns');
for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveTxt', 'resolveSrv']) {
  const originalDns = dns[method];
  dns[method] = function (host, ...args) {
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return deny();
    return originalDns.call(this, host, ...args);
  };
  if (dns.promises[method]) {
    const originalPromise = dns.promises[method];
    dns.promises[method] = function (host, ...args) {
      if (!['localhost', '127.0.0.1', '::1'].includes(host)) return deny();
      return originalPromise.call(this, host, ...args);
    };
  }
}
require('node:dgram').Socket.prototype.send = deny;
process.on('exit', () => {
  const loaded = Object.keys(require.cache);
  fs.writeFileSync(
    process.env.KIT_STARTUP_PROOF,
    JSON.stringify({
      externalNetworkAttempts,
      nativeSharpLinuxX64: loaded.some((file) => /[\\/]@img[\\/]sharp-linux-x64[\\/].*\.node$/.test(file)),
      nativeFiles: loaded.filter((file) => file.endsWith('.node')).map((file) => path.relative(root, file)),
    })
  );
});

process.once('SIGTERM', () => process.exit(0));
