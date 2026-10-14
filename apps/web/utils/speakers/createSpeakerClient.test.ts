import { ImageType } from '../../types/Image';
import { buildCreateSpeakerPayload, shouldShowSpeakerListSuccess } from './createSpeakerClient';

const createSquareImage = (id = 'img-square'): ImageType => ({
  id,
  type: 'square',
  size: 'large',
  width: 600,
  height: 600,
  downloadLink: `https://example.com/${id}.jpg`,
  name: id,
  dateAddedMillis: 1,
});

describe('createSpeakerClient', () => {
  it('builds payload while preserving selected images and create-list toggle', () => {
    const squareImage = createSquareImage();
    const payload = buildCreateSpeakerPayload({
      name: '  New Speaker  ',
      shortDescription: '  Short desc  ',
      description: '  Long description  ',
      images: [squareImage],
      createSpeakerList: true,
    });

    expect(payload).toEqual({
      speaker: {
        name: 'New Speaker',
        shortDescription: 'Short desc',
        description: 'Long description',
        images: [squareImage],
      },
      createSpeakerList: true,
    });
    expect(payload.speaker.images[0]).toBe(squareImage);
  });

  it('omits optional fields when not supplied', () => {
    const squareImage = createSquareImage();
    const payload = buildCreateSpeakerPayload({
      name: 'No Optional Fields',
      shortDescription: '   ',
      description: '',
      images: [squareImage],
    });

    expect(payload).toEqual({
      speaker: {
        name: 'No Optional Fields',
        images: [squareImage],
      },
    });
  });

  it('interprets speaker-list creation responses for success popup visibility', () => {
    expect(shouldShowSpeakerListSuccess({ speakerListCreated: true })).toBe(true);
    expect(shouldShowSpeakerListSuccess({ speakerListCreated: false })).toBe(false);
  });
});
