import { Button, TextField } from '@mui/material';
import dynamic from 'next/dynamic';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import addNewSeries from '../pages/api/addNewSeries';
import { Series } from '../types/Series';

const DynamicPopUp = dynamic(() => import('../components/PopUp'), { ssr: false });

interface NewSeriesPopupProps {
  newSeriesPopup: boolean;
  setNewSeriesPopup: Dispatch<SetStateAction<boolean>>;
  seriesArray: Series[];
}

const NewSeriesPopup = (props: NewSeriesPopupProps) => {
  const [newSeries, setNewSeries] = useState<string>('');
  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });
  const [userHasTypedInSeries, setUserHasTypedInSeries] = useState<boolean>(false);

  useEffect(() => {
    if (!userHasTypedInSeries) {
      setNewSeriesError({ error: false, message: '' });
      return;
    }

    if (newSeries === '') {
      setNewSeriesError({ error: true, message: 'Series cannot be empty' });
    } else if (props.seriesArray.map((series) => series.name.toLowerCase()).includes(newSeries.toLowerCase())) {
      setNewSeriesError({ error: true, message: 'Series already exists' });
    } else {
      setNewSeriesError({ error: false, message: '' });
    }
  }, [newSeries, userHasTypedInSeries, props.seriesArray]);

  return (
    <DynamicPopUp
      title={'Add new series'}
      open={props.newSeriesPopup}
      setOpen={props.setNewSeriesPopup}
      onClose={() => {
        setUserHasTypedInSeries(false);
        setNewSeries('');
      }}
      button={
        <Button
          variant="contained"
          disabled={
            newSeries === '' ||
            props.seriesArray.map((series) => series.name.toLowerCase()).includes(newSeries.toLowerCase())
          }
          onClick={async () => {
            try {
              const newSeriesId = await addNewSeries(newSeries);
              const seriesToAdd = { id: newSeriesId, name: newSeries, sermonIds: [] };
              props.setNewSeriesPopup(false);
              props.seriesArray.push(seriesToAdd);
              setNewSeries('');
            } catch (error) {
              setNewSeriesError({ error: true, message: JSON.stringify(error) });
            }
          }}
        >
          Submit
        </Button>
      }
    >
      <div style={{ display: 'flex', padding: '10px' }}>
        <TextField
          value={newSeries}
          onChange={(e) => {
            setNewSeries(e.target.value);
            !userHasTypedInSeries && setUserHasTypedInSeries(true);
          }}
          error={newSeriesError.error}
          label={newSeriesError.error ? newSeriesError.message : 'Series'}
        />
      </div>
    </DynamicPopUp>
  );
};

export default NewSeriesPopup;
