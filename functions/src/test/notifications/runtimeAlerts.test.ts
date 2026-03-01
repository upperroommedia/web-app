type RuntimeAlertTarget = {
  functionName: string;
  alertCode: string;
  requiredContextFields: string[];
};

const publishRuntimeAlertTargets: RuntimeAlertTarget[] = [
  {
    functionName: 'uploadToSubsplash',
    alertCode: 'PUBLISH_SUBSPLASH_UPLOAD_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'lockKey'],
  },
  {
    functionName: 'editSubsplashSermon',
    alertCode: 'PUBLISH_SUBSPLASH_EDIT_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'subsplashId'],
  },
  {
    functionName: 'deleteFromSubsplash',
    alertCode: 'PUBLISH_SUBSPLASH_DELETE_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'operationKey', 'subsplashId'],
  },
  {
    functionName: 'uploadToSoundCloud',
    alertCode: 'PUBLISH_SOUNDCLOUD_UPLOAD_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'audioStoragePath'],
  },
  {
    functionName: 'editSoundCloudSermon',
    alertCode: 'PUBLISH_SOUNDCLOUD_EDIT_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'trackId'],
  },
  {
    functionName: 'deleteFromSoundCloud',
    alertCode: 'PUBLISH_SOUNDCLOUD_DELETE_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'soundCloudTrackId'],
  },
];

const audioRuntimeAlertTargets: RuntimeAlertTarget[] = [
  {
    functionName: 'addintrooutrotaskgenerator',
    alertCode: 'AUDIO_TASK_GENERATOR_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'sermonId', 'audioSourceType', 'audioSource', 'taskRoute'],
  },
  {
    functionName: 'addintrooutrotaskhandler',
    alertCode: 'AUDIO_TASK_HANDLER_RUNTIME_FAILURE',
    requiredContextFields: ['functionName', 'sermonId', 'audioSourceType', 'audioSource', 'taskRoute'],
  },
];

const runtimeAlertTargets = [...publishRuntimeAlertTargets, ...audioRuntimeAlertTargets];

describe('runtime alert taxonomy contract', () => {
  it('declares deterministic alert codes and context requirements for each targeted catch path', () => {
    expect(runtimeAlertTargets).toHaveLength(8);

    for (const target of runtimeAlertTargets) {
      expect(target.alertCode).toMatch(/^[A-Z0-9_]+$/);
      expect(target.requiredContextFields).toEqual(expect.arrayContaining(['functionName']));
    }
  });

  it('uses unique alert codes across all targeted catch paths', () => {
    const codes = runtimeAlertTargets.map((target) => target.alertCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

