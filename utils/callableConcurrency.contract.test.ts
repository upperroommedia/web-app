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

    expect(managePublishingPopup).toContain("createOperationKey('manage-publishing-upload', sermon.id)");
    expect(managePublishingPopup).toContain("createOperationKey('manage-publishing-list-add', sermon.id)");
    expect(managePublishingPopup).toContain("createOperationKey('manage-publishing-series-publish', sermon.id)");
    expect(managePublishingPopup).toContain('parseLockBusyDetails(');

    expect(seriesAdminPage).toContain("createOperationKey('series-admin-upload', sermon.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-add-item', seriesItem.id)");
    expect(seriesAdminPage).toContain("createOperationKey('series-admin-reorder', seriesId)");
    expect(seriesAdminPage).toContain("createRetryIntentKey('series-admin-bulk-add', seriesId, intentFingerprint)");
    expect(seriesAdminPage).toContain('expectedPublishedMembershipHash');
    expect(seriesAdminPage).toContain('parseLockBusyDetails(');

    expect(sermonAdminPage).toContain("createOperationKey('sermon-admin-upload', sermon.id)");
    expect(sermonAdminPage).toContain("createOperationKey('sermon-admin-list-add', sermon.id)");
    expect(sermonAdminPage).toContain("createOperationKey('sermon-admin-series-publish', sermon.id)");
    expect(sermonAdminPage).toContain('parseLockBusyDetails(');
  });

  it('propagates operation keys from API-layer mutation helpers', () => {
    const uploadFileApi = readFile('pages/api/uploadFile.tsx');
    const editSermonApi = readFile('pages/api/editSermon.ts');

    expect(uploadFileApi).toContain("createOperationKey('upload-file-add-intro-outro', props.sermon.id)");
    expect(editSermonApi).toContain("createOperationKey('edit-sermon-subsplash-edit', sermon.id)");
    expect(editSermonApi).toContain('parseLockBusyDetails(');
  });
});
