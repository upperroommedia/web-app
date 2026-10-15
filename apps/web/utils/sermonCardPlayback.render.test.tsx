import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEmptySermon } from '../types/Sermon';
import { sermonStatusType } from '../types/SermonTypes';

let mockDesktop = true;
jest.mock('next/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@mui/material/useMediaQuery', () => ({
  __esModule: true,
  default: (query: string) => (mockDesktop ? query.includes('min-width') : query.includes('max-width')),
}));
jest.mock('../context/user/UserContext', () => ({
  __esModule: true,
  default: () => ({ user: { uid: 'uploader', isAdmin: () => false, canPublish: () => false } }),
}));
jest.mock('../firebase/firestore', () => ({
  __esModule: true,
  default: {},
  doc: () => ({ withConverter: () => ({}) }),
  getDoc: jest.fn(),
}));
jest.mock('react-firebase-hooks/firestore', () => ({ useDocument: () => [undefined, false, undefined] }));
jest.mock('../utils/createFunction', () => ({ createFunctionV2: jest.fn() }));
jest.mock('../hooks/useDurableJobs', () => ({ useEntityJobSummary: () => ({ job: undefined, stale: false }) }));
jest.mock('../components/UserAvatar', () => ({ __esModule: true, default: () => null }));
jest.mock('../components/AvatarWithDefaultImage', () => ({ __esModule: true, default: () => null }));

import SermonListCard from '../components/SermonListCard';
const sermon = { ...createEmptySermon('uploader'), id: 'sermon', title: 'An owned sermon' };
sermon.status.audioStatus = sermonStatusType.PROCESSED;

function render(playing: boolean, selected: string | undefined, processed = true) {
  return renderToStaticMarkup(
    <SermonListCard
      sermon={
        processed ? sermon : { ...sermon, status: { ...sermon.status, audioStatus: sermonStatusType.PROCESSING } }
      }
      playing={playing}
      audioPlayerCurrentSermonId={selected}
      audioPlayerSetCurrentSermon={jest.fn()}
      remainingTimeComponent={null}
      trackProgressComponent={null}
      subscriptionOwnedByParent
      enableSeriesRealtime={false}
    />
  );
}
describe.each([true, false])('card playback accessibility (desktop=%s)', (desktop) => {
  beforeEach(() => {
    mockDesktop = desktop;
  });
  it.each([
    [false, undefined, 'Play sermon'],
    [false, 'sermon', 'Play sermon'],
    [true, 'other-sermon', 'Play sermon'],
    [true, 'sermon', 'Pause sermon'],
  ])('names the actual playback button for playing=%s selected=%s', (playing, selected, label) => {
    const html = render(Boolean(playing), typeof selected === 'string' ? selected : undefined);
    const buttons = Array.from(html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([button]) => button);
    // Use the button's own accessible name; no icon test identifiers are needed.
    const playback = buttons.filter((button) => button.includes(`aria-label="${label}"`));
    expect(playback).toHaveLength(1);
    expect(playback[0]).toContain('<svg');
    expect(
      buttons.some((button) =>
        button.includes(`aria-label="${label === 'Play sermon' ? 'Pause sermon' : 'Play sermon'}"`)
      )
    ).toBe(false);
  });
  it('does not offer playback before audio processing completes', () => {
    expect(render(false, undefined, false)).not.toMatch(/aria-label="(?:Play|Pause) sermon"/);
  });
});
