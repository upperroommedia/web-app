/**
 * YoutubeUpload: located at the top of all pages
 */
import { FunctionComponent, useState, useEffect, ReactElement } from 'react';

const YoutubeUpload: FunctionComponent = () => {
  const [inputText, setInputText] = useState<string>('');
  const [startTime, setStartTime] = useState<string>('');
  const [endTime, setEndTime] = useState<string>('');
  const [iFrame, setIFrame] = useState<ReactElement>(<></>);

  const youtubeParser = (url: string) => {
    const regExp =
      /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
    const match = url.match(regExp);
    return match && match[7].length === 11
      ? `https://youtube.com/embed/${match[7]}`
      : '';
  };

  useEffect(() => {
    const link = youtubeParser(inputText);
    setIFrame(
      link ? (
        <iframe
          src={link}
          frameBorder="0"
          allow="autoplay; encrypted-media"
          allowFullScreen
          title="video"
        />
      ) : (
        <></>
      )
    );
  }, [inputText]);

  return (
    <div style={{ alignItems: 'center' }}>
      <input
        placeholder="insert a youtube link here"
        onChange={(e) => setInputText(e.target.value)}
        value={inputText}
      />
      {iFrame}
      <input
        placeholder="start time"
        onChange={(e) => setStartTime(e.target.value)}
        value={startTime}
      />
      <input
        placeholder="end time"
        onChange={(e) => setEndTime(e.target.value)}
        value={endTime}
      />
    </div>
  );
};

export default YoutubeUpload;
