import axios from 'axios';
import updateSubsplashSermonTopics from '../../helpers/updateSubsplashTagsHelper';
import { withSubsplashLocks } from '../../locks/withSubsplashLocks';

jest.mock('../../subsplashUtils', () => ({
  createAxiosConfig: jest.fn((url: string, token: string, method: string, data?: unknown) => ({
    url,
    token,
    method,
    data,
    headers: {},
  })),
}));

jest.mock('axios');
jest.mock('../../locks/withSubsplashLocks', () => ({
  withSubsplashLocks: jest.fn(async (_lockKeys: string[], run: () => Promise<unknown>) => run()),
}));

const mockAxios = axios as jest.MockedFunction<typeof axios>;
const mockWithSubsplashLocks = withSubsplashLocks as jest.MockedFunction<typeof withSubsplashLocks>;

describe('updateSubsplashTagsHelper lock contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxios.mockResolvedValue({ data: {} } as never);
    mockWithSubsplashLocks.mockImplementation(async (_lockKeys, run) => run());
  });

  it('wraps media item tag patch with media-item lock key', async () => {
    await updateSubsplashSermonTopics(
      {
        id: 'sermon-1',
        subsplashId: 'media-item-1',
        topics: ['Grace', 'Faith'],
        speakers: [{ name: 'John Doe' }],
      } as never,
      'token'
    );

    expect(mockWithSubsplashLocks).toHaveBeenCalledWith(
      ['media-item:media-item-1'],
      expect.any(Function)
    );
    expect(mockAxios).toHaveBeenCalledTimes(1);
  });

  it('skips locking and mutation when sermon has no subsplashId', async () => {
    await updateSubsplashSermonTopics(
      {
        id: 'sermon-2',
        topics: ['Grace'],
      } as never,
      'token'
    );

    expect(mockWithSubsplashLocks).not.toHaveBeenCalled();
    expect(mockAxios).not.toHaveBeenCalled();
  });
});
