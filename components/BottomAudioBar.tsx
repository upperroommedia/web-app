/**
 * BottomAudioBar located at the bottom of all pages
 */
// import Image from 'next/image';
import { FunctionComponent, useEffect, useRef } from 'react';
import styles from '../styles/BottomAudioBar.module.css';
import { Sermon } from '../types/Sermon';

interface Props {
  sermon: Sermon;
  url: string;
}

const BottomAudioBar: FunctionComponent<Props> = ({ sermon, url }) => {
  const audioPlayer = useRef<HTMLAudioElement>(new Audio());
  useEffect(() => {
    audioPlayer.current?.load();
  }, [url]);
  return (
    <div className={styles.container}>
      <h1>{sermon.title}</h1>
      <audio className={styles.audio} ref={audioPlayer} controls autoPlay>
        <source src={url} />
      </audio>
    </div>
  );
};

export default BottomAudioBar;
