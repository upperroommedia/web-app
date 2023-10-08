import { CircularProgressProps } from '@mui/material/CircularProgress';
import { Sermon } from '../types/SermonTypes';
import CircularProgressWithLabel from './CircularProgressWithLabel';

interface CountOfUploadsCircularProgressProps extends CircularProgressProps {
  sermon: Sermon;
}

const CountOfUploadsCircularProgress = ({ sermon, ...props }: CountOfUploadsCircularProgressProps) => {
  const value =
    sermon?.numberOfLists > 0 && sermon?.numberOfListsUploadedTo !== undefined
      ? (sermon.numberOfListsUploadedTo / sermon.numberOfLists) * 100
      : 0;
  return (
    <CircularProgressWithLabel
      value={value}
      customLabel={`${sermon?.numberOfListsUploadedTo || 0}/${sermon?.numberOfLists || 0}`}
      color={value === 100 ? 'success' : 'primary'}
      {...props}
    />
  );
};

export default CountOfUploadsCircularProgress;
