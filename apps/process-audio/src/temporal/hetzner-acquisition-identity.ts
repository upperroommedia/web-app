import { readFile, readlink } from 'node:fs/promises';
import type { AcquisitionHostProcess } from './hetzner-acquisition-store';
const failure = () => new Error('YOUTUBE_NATIVE_IDENTITY_UNCONFIRMED');

/** Host-internal Linux inspection, never fields accepted from HTTP. Parent
 * authorization inspects only its own freshly forked isolated helper; the helper
 * may inspect itself after execution IPC. A build ID comes from trusted runtime
 * deployment configuration, which still requires independent image provenance.
 */
export async function inspectNativeYouTubeProcess(processId: number, buildId: string): Promise<AcquisitionHostProcess> {
  if (
    process.platform !== 'linux' ||
    !Number.isSafeInteger(processId) ||
    processId < 1 ||
    !/^[a-f0-9]{40}$/.test(buildId)
  )
    throw failure();
  const inspect = async () => {
    const text = await readFile(`/proc/${processId}/stat`, 'utf8');
    const fields = text
      .slice(text.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/);
    if (
      fields.length < 20 ||
      ['Z', 'X'].includes(fields[0]) ||
      (processId !== process.pid && Number(fields[1]) !== process.pid) ||
      Number(fields[2]) !== processId ||
      Number(fields[3]) !== processId ||
      !/^[1-9][0-9]*$/.test(fields[19])
    )
      throw failure();
    return fields[19];
  };
  try {
    const startTicks = await inspect();
    const [boot, pidNamespace, currentNamespace, status] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readlink(`/proc/${processId}/ns/pid`),
      readlink('/proc/self/ns/pid'),
      readFile(`/proc/${processId}/status`, 'utf8'),
    ]);
    const bootId = boot.trim();
    const uid = /^Uid:\s+([0-9]+)/m.exec(status)?.[1];
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId) ||
      !/^pid:\[[0-9]+\]$/.test(pidNamespace) ||
      pidNamespace !== currentNamespace ||
      uid === undefined ||
      Number(uid) !== process.getuid?.() ||
      (await inspect()) !== startTicks
    )
      throw failure();
    return { bootId, pidNamespace, processId, startTicks, buildId };
  } catch {
    throw failure();
  }
}
