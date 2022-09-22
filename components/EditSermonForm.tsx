import {
  DialogTitle,
  DialogContent,
  DialogActions,
  Dialog,
  Button,
} from '@mui/material';
import { getFirestore, query, collection, getDocs } from 'firebase/firestore';
import { ReactElement, useEffect, useState } from 'react';
import { firebase } from '../firebase/firebase';
import Uploader from '../pages/uploader';
import { Sermon } from '../types/Sermon';

interface EditSermonFormInfo {
  title: string;
  open: boolean;
  children: string | ReactElement;
  setOpen: any;
  sermon: Sermon;
}

const EditSermonForm = (props: EditSermonFormInfo) => {
  const { title, children, sermon, open, setOpen } = props;
  const [speakersArray, setSpeakersArray] = useState<string[]>([]);
  const [topicsArray, setTopicsArray] = useState<string[]>([]);
  const [seriesArray, setSeriesArray] = useState<string[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      const db = getFirestore(firebase);

      const speakersQuery = query(collection(db, 'speakers'));
      const speakersQuerySnapshot = await getDocs(speakersQuery);
      speakersQuerySnapshot.forEach((doc) => {
        const current = doc.data();
        setSpeakersArray((oldArray) => [...oldArray, current.name]);
      });

      const topicsQuery = query(collection(db, 'topics'));
      const topicsQuerySnapshot = await getDocs(topicsQuery);
      topicsQuerySnapshot.forEach((doc) => {
        const current = doc.data();
        setTopicsArray((oldArray) => [...oldArray, current.name]);
      });

      const seriesQuery = query(collection(db, 'series'));
      const seriesQuerySnapshot = await getDocs(seriesQuery);
      seriesQuerySnapshot.forEach((doc) => {
        const current = doc.data();
        setSeriesArray((oldArray) => [...oldArray, current.name]);
      });
    };
    fetchData();
  }, []);

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      aria-labelledby="confirm-dialog"
    >
      <DialogTitle id="confirm-dialog">{title}</DialogTitle>
      <DialogContent>
        <div>
          <Uploader
            speakers={speakersArray}
            topics={topicsArray}
            seriesArray={seriesArray}
            existingSermon={sermon}
          />
          {children}
        </div>
      </DialogContent>
      <DialogActions>
        <Button
          variant="contained"
          onClick={() => {
            setOpen(false);
          }}
          color="primary"
        >
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};
export default EditSermonForm;
