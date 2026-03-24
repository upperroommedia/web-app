import type { GetYouTubeCookieStatusInput, GetYouTubeCookieStatusOutputType } from '@upperroom/contracts/getYouTubeCookieStatus';
import type { SetYouTubeCookiesInput, SetYouTubeCookiesOutputType } from '@upperroom/contracts/setYouTubeCookies';

type TextFileLike = {
  name: string;
  text(): Promise<string>;
};

type SetYouTubeCookiesCallable = (input: SetYouTubeCookiesInput) => Promise<SetYouTubeCookiesOutputType>;
type GetYouTubeCookieStatusCallable = (
  input: GetYouTubeCookieStatusInput
) => Promise<GetYouTubeCookieStatusOutputType>;

const TEXT_FILE_EXTENSION = /\.txt$/iu;

export const encodeTextToBase64 = (value: string): string => {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64');
  }

  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
};

export const readYouTubeCookieFileAsBase64 = async (file: TextFileLike): Promise<string> => {
  if (!TEXT_FILE_EXTENSION.test(file.name.trim())) {
    throw new Error('YouTube cookies must be uploaded as a .txt file.');
  }

  const contents = await file.text();
  if (!contents.trim()) {
    throw new Error('YouTube cookies file is empty.');
  }

  return encodeTextToBase64(contents);
};

export const uploadYouTubeCookiesFromFile = async ({
  file,
  setYouTubeCookies,
  getYouTubeCookieStatus,
}: {
  file: TextFileLike;
  setYouTubeCookies: SetYouTubeCookiesCallable;
  getYouTubeCookieStatus: GetYouTubeCookieStatusCallable;
}): Promise<GetYouTubeCookieStatusOutputType> => {
  const cookiesBase64 = await readYouTubeCookieFileAsBase64(file);

  await setYouTubeCookies({
    cookiesBase64,
    fileName: file.name,
  });

  return await getYouTubeCookieStatus({});
};
