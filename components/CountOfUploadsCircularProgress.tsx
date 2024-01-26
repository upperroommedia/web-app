import { CircularProgressProps } from '@mui/material/CircularProgress';
import CircularProgressWithLabel from './CircularProgressWithLabel';
import { memo } from 'react';

interface CountOfUploadsCircularProgressProps extends CircularProgressProps {
  sermonNumberOfListsUploadedTo: number | undefined;
  sermonNumberOfLists: number | undefined;
}

const CountOfUploadsCircularProgress = ({
  sermonNumberOfListsUploadedTo,
  sermonNumberOfLists,
  ...props
}: CountOfUploadsCircularProgressProps) => {
  const value =
    sermonNumberOfLists && sermonNumberOfListsUploadedTo !== undefined
      ? (sermonNumberOfListsUploadedTo / sermonNumberOfLists) * 100
      : 0;
  return (
    <CircularProgressWithLabel
      value={value}
      customLabel={`${sermonNumberOfListsUploadedTo || 0}/${sermonNumberOfLists || 0}`}
      color={value === 100 ? 'success' : 'primary'}
      {...props}
    />
  );
};

export default memo(CountOfUploadsCircularProgress);
