import { posix } from 'node:path';
const stable = (value) =>
  JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b))));
export function deployedKitSources(firebase) {
  return [
    ...new Set(
      (Array.isArray(firebase.functions) ? firebase.functions : [firebase.functions])
        .filter((entry) => entry?.kit)
        .map((entry) => entry.source)
    ),
  ];
}
function dependencyLocation(packages, parent, name) {
  let current = parent;
  while (true) {
    const candidate = posix.join(current, 'node_modules', name);
    if (packages[candidate]) return candidate;
    if (!current) return undefined;
    current = posix.dirname(current);
    if (current === '.') current = '';
  }
}
export function validateSharpPlatformClosure(lock) {
  for (const [location, packageEntry] of Object.entries(lock.packages ?? {})) {
    if (!/(^|\/)node_modules\/sharp$/.test(location)) continue;
    const optional = Object.entries(packageEntry.optionalDependencies ?? {}).filter(([name]) =>
      name.startsWith('@img/sharp-')
    );
    if (!optional.length) throw Error(`Sharp native optional graph is missing: ${location}`);
    for (const [name, spec] of optional) {
      const path = dependencyLocation(lock.packages, location, name),
        entry = path && lock.packages[path];
      if (!entry || entry.version !== spec || !entry.integrity || entry.optional !== true)
        throw Error(`Sharp optional platform package missing or inconsistent: ${location} -> ${name}`);
    }
    for (const name of ['@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) {
      const entry = lock.packages[dependencyLocation(lock.packages, location, name)];
      if (
        !entry ||
        !entry.os?.includes('linux') ||
        !entry.cpu?.includes('x64') ||
        (entry.libc && !entry.libc.includes('glibc'))
      )
        throw Error(`Sharp Linux native package has wrong platform metadata: ${name}`);
    }
  }
}
export function validateKitNpmLock(manifest, lock) {
  const root = lock.packages?.[''];
  if (
    lock.lockfileVersion !== 3 ||
    !root ||
    lock.name !== manifest.name ||
    root.name !== manifest.name ||
    root.version !== manifest.version
  )
    throw Error('Kit npm lock does not describe the exact upload manifest');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines']) {
    if (stable(root[field]) !== stable(manifest[field])) throw Error(`Kit npm lock manifest mismatch: ${field}`);
  }
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (
      entry.link ||
      !location.startsWith('node_modules/') ||
      !entry.version ||
      !entry.integrity ||
      !entry.resolved?.startsWith('https://registry.npmjs.org/')
    )
      throw Error(`Kit dependency is not an integrity-pinned registry package: ${location}`);
  }
  validateSharpPlatformClosure(lock);
}
