describe('uploadToSoundCloud callable config', () => {
  it('provisions extra memory for the SoundCloud upload callable', async () => {
    const onCallMock = jest.fn((_options: unknown, handler: unknown) => handler);

    jest.resetModules();
    jest.doMock('firebase-functions/v2/https', () => {
      const actual = jest.requireActual('firebase-functions/v2/https');
      return {
        ...actual,
        onCall: onCallMock,
      };
    });
    jest.doMock('../../soundcloudSecrets', () => ({
      runWithSoundCloudAccessToken: jest.fn(),
      soundcloudSecretsWithRuntimeAlerts: ['soundcloud-client-id'],
    }));
    jest.doMock('@upperroom/shared/firebase/firebaseAdmin', () => ({
      __esModule: true,
      default: {
        storage: () => ({
          bucket: jest.fn(),
        }),
      },
    }));
    jest.doMock('../../soundcloudClient', () => ({
      normalizeSoundCloudApiError: jest.fn(),
      uploadTrack: jest.fn(),
    }));
    jest.doMock('../../notifications/emitOperationalAlert', () => ({
      emitOperationalAlert: jest.fn(),
    }));
    jest.doMock('../../soundcloudAuthAlerting', () => ({
      emitSoundCloudReconnectAlertIfNeeded: jest.fn(),
    }));
    jest.doMock('../../sentry', () => ({
      startFunctionsSpan: jest.fn(),
    }));

    await jest.isolateModulesAsync(async () => {
      await import('../../uploadToSoundCloud');
    });

    expect(onCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: '512MiB',
        secrets: ['soundcloud-client-id'],
      }),
      expect.any(Function)
    );
  });
});
