import { connect } from 'node:net';
import { lstat, readFile, realpath } from 'node:fs/promises';

export type HostWorkKind = 'legacy-full' | 'canary' | 'acquisition';
const SOCKET = '/run/urm-host-media/coordinator.sock';
const unavailable = () => new Error('HOST_RESOURCE_UNAVAILABLE');
export interface HostResourceReply {
  v: 1;
  id: string;
  state: 'intent' | 'reserved' | 'enrolling' | 'enrolled' | 'closed' | 'unstarted';
  directory?: string;
  peerBound?: true;
  groupAbsent?: true;
  descendantsStopped?: true;
  receiptHash?: string;
}
export function hostIsolationEnabled(runtimeProfile: string): boolean {
  const value = process.env.URM_HOST_RESOURCE_PROTOCOL;
  if (value === undefined) return false;
  if (runtimeProfile !== 'hetzner' || value !== 'isolated-v1') throw unavailable();
  return true;
}
async function assertNativeSocket(): Promise<void> {
  if (process.platform !== 'linux' || process.env.NODE_ENV !== 'production') throw unavailable();
  if ((await realpath(SOCKET)) !== SOCKET) throw unavailable();
  const socket = await lstat(SOCKET);
  if (!socket.isSocket() || socket.uid !== 0) throw unavailable();
  // A root UID inside an application container is not server authentication.
  // The coordinator directory must be a separate read-only native bind and the
  // container must lack mount administration, so it cannot replace that socket.
  const [mountinfo, status] = await Promise.all([
    readFile('/proc/self/mountinfo', 'utf8'),
    readFile('/proc/self/status', 'utf8'),
  ]);
  const mounts = mountinfo.split('\n').map((line) => line.split(' '));
  if (!mounts.some((fields) => fields[4] === '/run/urm-host-media' && fields[5]?.split(',').includes('ro')))
    throw unavailable();
  const cap = /^CapEff:\s+([0-9a-f]+)$/im.exec(status)?.[1];
  if (!cap || (BigInt(`0x${cap}`) & (1n << 21n)) !== 0n) throw unavailable();
}
/** Fixed local physical-resource protocol. This is never task/actor authority.
 * Unknown acknowledgements cannot be retried as mutations; callers may only GET
 * the exact original ID. The whole native socket observation/ACK has one budget. */
export async function hostResourceRequest(
  id: string,
  action: 'reserve' | 'get' | 'enroll' | 'verify' | 'stop' | 'close' | 'unstarted',
  extra: { kind?: HostWorkKind; childPid?: number } = {}
): Promise<HostResourceReply> {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw unavailable();
  const wall = Date.now(),
    mono = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let socket: ReturnType<typeof connect> | undefined;
  const fresh = () => {
    if (Date.now() < wall || Date.now() - wall >= 5000 || performance.now() - mono >= 5000) throw unavailable();
  };
  const work = async () => {
    await assertNativeSocket();
    fresh();
    return await new Promise<HostResourceReply>((resolve, reject) => {
      socket = connect(SOCKET);
      let bytes = '';
      socket.once('error', () => reject(unavailable()));
      socket.once('connect', () => {
        try {
          fresh();
          socket!.write(JSON.stringify({ v: 1, action, id, ...extra }) + '\n');
        } catch {
          socket!.destroy();
          reject(unavailable());
        }
      });
      socket.on('data', (chunk) => {
        bytes += chunk.toString('utf8');
        if (Buffer.byteLength(bytes) > 16384) {
          socket!.destroy();
          reject(unavailable());
          return;
        }
        if (!bytes.endsWith('\n')) return;
        try {
          fresh();
          const value = JSON.parse(bytes);
          if (
            !value ||
            value.v !== 1 ||
            value.id !== id ||
            value.peerBound !== true ||
            Object.keys(value).some(
              (key) =>
                ![
                  'v',
                  'id',
                  'state',
                  'directory',
                  'peerBound',
                  'groupAbsent',
                  'descendantsStopped',
                  'receiptHash',
                ].includes(key)
            ) ||
            !['intent', 'reserved', 'enrolling', 'enrolled', 'closed', 'unstarted'].includes(value.state) ||
            (value.directory !== undefined && value.directory !== `/workspace/host-resource/${id}`) ||
            (value.groupAbsent !== undefined && value.groupAbsent !== true) ||
            (value.descendantsStopped !== undefined && value.descendantsStopped !== true) ||
            (value.receiptHash !== undefined && !/^[a-f0-9]{64}$/.test(value.receiptHash))
          )
            throw unavailable();
          if (value.state === 'closed' && (value.groupAbsent !== true || !value.receiptHash)) throw unavailable();
          resolve(value);
        } catch {
          reject(unavailable());
        }
        socket!.destroy();
      });
      socket.once('end', () => {
        if (!bytes.endsWith('\n')) reject(unavailable());
      });
    });
  };
  try {
    const result = await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unavailable()), 5000);
      }),
    ]);
    fresh();
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    socket?.destroy();
  }
}
