import { Dispatch, SetStateAction } from 'react';

const SpeakerItem = (props: { hit: any; setSpeaker: Dispatch<SetStateAction<string[]>> }) => {
  const handleSpeakerClick = () => {
    props.setSpeaker((oldSpeakers) => [...oldSpeakers, props.hit.name]);
  };
  return (
    <div onClick={handleSpeakerClick}>
      <p>{props.hit.name}</p>
    </div>
  );
};

export default SpeakerItem;
