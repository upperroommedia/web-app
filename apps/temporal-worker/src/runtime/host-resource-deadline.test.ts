import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { hostResourceRequest } from '../../../process-audio/src/host/resources';
jest.mock('node:net', () => ({ connect: jest.fn() }));
jest.mock('node:fs/promises', () => ({
  realpath: async (path: string) => path,
  lstat: async () => ({ isSocket: () => true, uid: 0, mode: 0o140666 }),
  readFile: async (path: string) =>
    path.endsWith('mountinfo') ? '1 0 1:1 / /run/urm-host-media ro - tmpfs tmpfs rw\n' : 'CapEff:\t0000000000000000\n',
}));
test('late queued socket connect cannot send a physical mutation after original observation expiry', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const environment = process.env.NODE_ENV;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  process.env.NODE_ENV = 'production';
  const socket = Object.assign(new EventEmitter(), { write: jest.fn(), destroy: jest.fn() });
  jest.mocked(connect).mockReturnValue(socket as never);
  let clock = 10000;
  const wall = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    const pending = hostResourceRequest('00000000-0000-4000-8000-000000000001', 'reserve', { kind: 'legacy-full' });
    const rejected = expect(pending).rejects.toThrow('HOST_RESOURCE_UNAVAILABLE');
    await new Promise((done) => setImmediate(done));
    expect(connect).toHaveBeenCalledTimes(1);
    clock += 5001;
    socket.emit('connect');
    await rejected;
    expect(socket.write).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();
  } finally {
    wall.mockRestore();
    Object.defineProperty(process, 'platform', platform);
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
  }
});
