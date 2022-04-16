import { Dispatch, SetStateAction } from 'react';
import Select from 'react-select';

interface speakerListProps {
  setSpeaker: Dispatch<SetStateAction<string>>;
}

const options = [
  { value: 'chocolate', label: 'Chocolate' },
  { value: 'strawberry', label: 'Strawberry' },
  { value: 'vanilla', label: 'Vanilla' },
];

const SpeakersList = (props: speakerListProps) => {
  return (
    <Select
      options={options}
      onChange={(e) => {
        if (e !== null) props.setSpeaker(e.value);
      }}
    />
  );
};

export default SpeakersList;
