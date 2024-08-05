/**
 * The FIRESTORE_EMULATOR_HOST environment variable is set automatically
 * by "firebase emulators:exec", but if you want to provide the host and port manually
 * you can use the code below to use either.
 */
export function parseHostAndPort(hostAndPort: string | undefined): { host: string; port: number } | undefined {
  if (!hostAndPort) {
    return undefined;
  }
  const pieces = hostAndPort.split(':');
  return {
    host: pieces[0],
    port: parseInt(pieces[1], 10),
  };
}

export function getFirestoreCoverageMeta(projectId: string, firebaseJsonPath: string) {
  const { emulators } = require(firebaseJsonPath);
  const host = '127.0.0.1';
  const port = parseInt(emulators.firestore.port);
  // eslint-disable-next-line no-console
  console.log(`Attempting to connect to firestore at ${host}:${port}`);
  const coverageUrl = `http://${host}:${port}/emulator/v1/projects/${projectId}:ruleCoverage.html`;
  return {
    host,
    port,
    coverageUrl,
  };
}
