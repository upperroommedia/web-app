jest.mock('@upperroom/shared/firebase/firebaseAdmin', () => ({
  __esModule: true,
  default: { app: () => ({ options: { projectId: 'urm-app' } }) },
}));
jest.mock('../../notifications/emitOperationalAlert', () => ({ emitOperationalAlert: jest.fn() }));
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { createAxiosConfig } from '../../subsplashUtils';
describe('single-attempt Subsplash mutation transports', () => {
  it.each([307, 308])('never repeats a mutation through an HTTP %i redirect', async (status) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url!);
      request.resume();
      if (request.url === '/original') {
        response.writeHead(status, { Location: '/redirected' });
        response.end();
      } else {
        response.writeHead(200);
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const config = createAxiosConfig(`http://127.0.0.1:${port}/original`, 'synthetic-test-token', 'PATCH', {
        title: 'Synthetic',
      });
      expect(config.maxRedirects).toBe(0);
      await expect(axios(config)).rejects.toMatchObject({ response: { status } });
      expect(requests).toEqual(['/original']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
