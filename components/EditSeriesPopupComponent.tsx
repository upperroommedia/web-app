import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import { FunctionComponent, useEffect, useState } from 'react';
import firestore, { doc, updateDoc } from '../firebase/firestore';
import { Series, seriesConverter } from '../types/Series';
import { sermonConverter } from '../types/Sermon';
import PopUp from './PopUp';

interface EditSeriesPopupComponentProps {
  series: Series[];
  setSeries: React.Dispatch<React.SetStateAction<Series[]>>;
  editSeriesPopup: boolean;
  setEditSeriesPopup: React.Dispatch<React.SetStateAction<boolean>>;
  newSeriesName: string;
  setNewSeriesName: React.Dispatch<React.SetStateAction<string>>;
  selectedSeries: Series | undefined;
  setSelectedSeries: React.Dispatch<React.SetStateAction<Series | undefined>>;
}

const EditSeriesComponent: FunctionComponent<EditSeriesPopupComponentProps> = ({
  series,
  setSeries,
  editSeriesPopup,
  setEditSeriesPopup,
  newSeriesName,
  setNewSeriesName,
  selectedSeries,
  setSelectedSeries,
}: EditSeriesPopupComponentProps) => {
  const [userHasTypedInSeries, setUserHasTypedInSeries] = useState<boolean>(false);
  const [newSeriesError, setNewSeriesError] = useState<{ error: boolean; message: string }>({
    error: false,
    message: '',
  });

  useEffect(() => {
    if (!userHasTypedInSeries) {
      setNewSeriesError({ error: false, message: '' });
      return;
    }

    if (newSeriesName === '') {
      setNewSeriesError({ error: true, message: 'Series cannot be empty' });
    } else if (series.map((series) => series.name.toLowerCase()).includes(newSeriesName.toLowerCase())) {
      setNewSeriesError({ error: true, message: 'Series already exists' });
    } else {
      setNewSeriesError({ error: false, message: '' });
    }
  }, [newSeriesName, userHasTypedInSeries, series]);
  return (
    <PopUp
      title="Edit Series"
      open={editSeriesPopup}
      setOpen={setEditSeriesPopup}
      onClose={() => {
        setUserHasTypedInSeries(false);
        setNewSeriesName('');
        setSelectedSeries(undefined);
      }}
      button={
        <Button
          variant="contained"
          disabled={
            newSeriesName === '' ||
            series.map((series) => series.name.toLowerCase()).includes(newSeriesName.toLowerCase())
          }
          onClick={async () => {
            try {
              const seriesRef = doc(firestore, 'series', selectedSeries!.id).withConverter(seriesConverter);
              await updateDoc(seriesRef, {
                name: newSeriesName,
              });
              setSeries((oldSeries) =>
                oldSeries.map((s) => {
                  if (s.name === selectedSeries?.name) {
                    return { ...s, name: newSeriesName };
                  }
                  return s;
                })
              );
              selectedSeries?.sermonIds.forEach((id) => {
                const sermonRef = doc(firestore, 'sermons', id).withConverter(sermonConverter);
                updateDoc(sermonRef, {
                  series: { ...selectedSeries, name: newSeriesName },
                });
              });
              setEditSeriesPopup(false);
            } catch (e) {
              alert(e);
            }
          }}
        >
          Submit
        </Button>
      }
    >
      <>
        <div style={{ display: 'flex', padding: '20px', gap: '10px' }}>
          <TextField
            value={newSeriesName}
            onChange={(e) => {
              setNewSeriesName(e.target.value);
              !userHasTypedInSeries && setUserHasTypedInSeries(true);
            }}
            error={newSeriesError.error}
            label={newSeriesError.error ? newSeriesError.message : 'Series'}
          />
        </div>
      </>
    </PopUp>
  );
};

export default EditSeriesComponent;
