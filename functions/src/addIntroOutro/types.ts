type BaseAddIntroOutroInputType = {
  id: string;
  startTime: number;
  duration: number;
  deleteOriginal?: boolean;
  skipTranscode?: boolean;
  introUrl?: string;
  outroUrl?: string;
};

export type AddIntroOutroInputType =
  | (BaseAddIntroOutroInputType & { storageFilePath: string })
  | (BaseAddIntroOutroInputType & { youtubeUrl: string });

export type FilePaths = {
  INTRO?: string;
  OUTRO?: string;
};

export type AudioSource =
  | {
      source: YouTubeUrl;
      id: string;
      type: 'YouTubeUrl';
    }
  | {
      source: string;
      id: string;
      type: 'StorageFilePath';
    };

export type CustomMetadata = { duration: number; title?: string; introUrl?: string; outroUrl?: string };

export type YouTubeUrl = string;
