export type AddIntroOutroInputType = {
    storageFilePath: string,
    startTime: number,
    endTime: number,
    introUrl?: string,
    outroUrl?: string
  }
  
  
  export type FilePaths = {
    INTRO?: string;
    OUTRO?: string;
  };
  
  export type CustomMetadata = { duration: number, title?: string, introUrl?: string; outroUrl?: string }