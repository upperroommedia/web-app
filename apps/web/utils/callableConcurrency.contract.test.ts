import fs from 'fs';
import path from 'path';

const readFile = (relativePath: string): string => {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
};

describe('caller lock/idempotency contract adoption', () => {
  it('wires operation keys + lock busy parsing in admin publishing surfaces', () => {
    const managePublishingPopup = readFile('components/ManagePublishingPopup.tsx');
    const seriesAdminPage = readFile('pages/admin/series/[seriesId].tsx');
    const sermonAdminPage = readFile('pages/admin/sermons/[sermonId].tsx');
    const seriesListAdminPage = readFile('pages/admin/series.tsx');
    const sermonsListAdminPage = readFile('pages/admin/sermons.tsx');

    expect(managePublishingPopup).toContain("createSubsplashUploadIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashListCreateIntentKey('manage-publishing-list-create', sermon.id, list.id)");
    expect(managePublishingPopup).toContain("createSubsplashListAddIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashListRemoveIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashDeleteIntentKey('manage-publishing-delete', sermon.id)");
    expect(managePublishingPopup).toContain("createSubsplashSeriesCreateIntentKey('manage-publishing-series-create', series.id)");
    expect(managePublishingPopup).toContain("createSubsplashSeriesPublishIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashSeriesReorderIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashSeriesRollbackIntentKey(");
    expect(managePublishingPopup).toContain("createSubsplashSeriesUnpublishIntentKey(");
    expect(managePublishingPopup).toContain('parseLockBusyDetails(');

    expect(seriesAdminPage).toContain("createOperationKey('series-admin-upload', sermon.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-add-item', seriesItem.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-reorder', seriesId)");
    expect(seriesAdminPage).toContain("createRetryIntentKey('series-admin-bulk-add', seriesId, intentFingerprint)");
    expect(seriesAdminPage).toContain('expectedPublishedMembershipHash');
    expect(seriesAdminPage).toContain('parseLockBusyDetails(');

    expect(sermonAdminPage).toContain("createSubsplashUploadIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashListCreateIntentKey('sermon-admin-list-create', sermon.id, list.id)");
    expect(sermonAdminPage).toContain("createSubsplashListAddIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashListRemoveIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashDeleteIntentKey('sermon-admin-delete', sermon.id)");
    expect(sermonAdminPage).toContain("createSubsplashSeriesCreateIntentKey('sermon-admin-series-create', targetSeries.id)");
    expect(sermonAdminPage).toContain("createSubsplashSeriesPublishIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashSeriesReorderIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashSeriesRollbackIntentKey(");
    expect(sermonAdminPage).toContain("createSubsplashSeriesUnpublishIntentKey(");
    expect(sermonAdminPage).toContain('parseLockBusyDetails(');

    expect(seriesListAdminPage).toContain("createOperationKey('series-admin-delete', selectedSeries.id)");
    expect(seriesListAdminPage).toContain('parseLockBusyDetails(');
    expect(seriesListAdminPage).toContain('formatLockBusyRetryMessage(');

    expect(sermonsListAdminPage).toContain('parseLockBusyDetails(');
    expect(sermonsListAdminPage).toContain('formatLockBusyRetryMessage(');
  });

  it('propagates operation keys from API-layer mutation helpers', () => {
    const uploadFileApi = readFile('pages/api/uploadFile.tsx');
    const editSermonApi = readFile('pages/api/editSermon.ts');

    expect(uploadFileApi).toContain("createOperationKey('upload-file-add-intro-outro', props.sermon.id)");
    expect(editSermonApi).toContain("createOperationKey('edit-sermon-subsplash-edit', sermon.id)");
    expect(editSermonApi).toContain('parseLockBusyDetails(');
  });
});
