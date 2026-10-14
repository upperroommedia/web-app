import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Timestamp, DocumentSnapshot } from 'firebase-admin/firestore';
import { assertLegacyEmailClaimWindow } from '../../src/temporal/release';
const vectors = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../scripts/tests/fixtures/legacy-continuation-window.json'), 'utf8')
) as Array<{
  name: string;
  read: [number, number] | null;
  allowed: boolean;
  cutoff?: [number, number];
  noCutoff?: boolean;
  state?: Record<string, unknown>;
}>;
describe('server-clock legacy claim conformance', () => {
  for (const vector of vectors)
    it(vector.name, () => {
      const cutoff = vector.cutoff
        ? { seconds: vector.cutoff[0], nanoseconds: vector.cutoff[1] }
        : new Timestamp(1000, 123456789);
      const control = {
        exists: true,
        data: () => ({ ...(!vector.noCutoff ? { legacyAdmissionCutoff: cutoff } : {}), releaseId: 'release' }),
        readTime: vector.read ? { seconds: vector.read[0], nanoseconds: vector.read[1] } : undefined,
      } as unknown as DocumentSnapshot;
      const state = {
        data: () => ({
          mode: 'initial-cutover',
          releaseId: 'release',
          legacySettlingCutoff: new Timestamp(1000, 123456789),
          compatibilityVerifiedAt: new Timestamp(1000, 123456789),
          legacySettlingGraceSeconds: 3600,
          maximumLegacyExecutionSeconds: 3570,
          ...vector.state,
        }),
      } as unknown as DocumentSnapshot;
      if (vector.allowed) expect(() => assertLegacyEmailClaimWindow(control, state)).not.toThrow();
      else expect(() => assertLegacyEmailClaimWindow(control, state)).toThrow();
    });
  it('uses actual server time despite a forged client wall clock', () => {
    const spy = jest.spyOn(Date, 'now').mockReturnValue(0);
    const cutoff = new Timestamp(1000, 123456789);
    const c = {
      data: () => ({ releaseId: 'release', legacyAdmissionCutoff: cutoff }),
      readTime: new Timestamp(9000, 0),
    } as unknown as DocumentSnapshot;
    const s = {
      data: () => ({
        releaseId: 'release',
        mode: 'initial-cutover',
        legacySettlingCutoff: cutoff,
        compatibilityVerifiedAt: cutoff,
        legacySettlingGraceSeconds: 3600,
        maximumLegacyExecutionSeconds: 3570,
      }),
    } as unknown as DocumentSnapshot;
    try {
      expect(() => assertLegacyEmailClaimWindow(c, s)).toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});
