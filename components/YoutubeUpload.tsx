/**
 * YoutubeUpload: located at the top of all pages
 */
import { FunctionComponent, useState } from 'react';

const YoutubeUpload: FunctionComponent = () => {
  const [inputText, setInputText] = useState<string>('');

  const youtubeParser = (url: string) => {
    const regExp =
      /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[7].length === 11
      ? `https://youtube.com/embed/${match[7]}`
      : '';
  };

  const RenderYoutubeVideoIFrame = () => {
    const link = youtubeParser(inputText);
    return link ? (
      <iframe
        src={link}
        frameBorder="0"
        allow="autoplay; encrypted-media"
        allowFullScreen
        title="video"
      />
    ) : (
      <></>
    );
  };

  return (
    <div>
      <input
        placeholder="insert a youtube link here"
        onChange={(e) => setInputText(e.target.value)}
        value={inputText}
      />
      {<RenderYoutubeVideoIFrame />}
    </div>
  );
};

export default YoutubeUpload;
