import firestore, { setDoc, collection, doc } from '../../firebase/firestore';
import { Series, seriesConverter } from '../../types/Series';

const addNewSeries = async (series: Series) => {
  // create series on firestore
  const newSeriesRef = doc(collection(firestore, 'series')).withConverter(seriesConverter);
  await setDoc(newSeriesRef, {
    id: newSeriesRef.id,
    name: series.name,
    sermonsInSubsplash: series.sermonsInSubsplash,
    allSermons: series.allSermons,
    overflowBehavior: series.overflowBehavior,
    images: series.images,
  });
  return newSeriesRef.id;
};

export default addNewSeries;
