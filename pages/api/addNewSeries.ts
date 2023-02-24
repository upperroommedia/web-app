import firestore, { setDoc, collection, doc } from '../../firebase/firestore';
import { Series, seriesConverter } from '../../types/Series';
import { createFunctionV2 } from '../../utils/createFunction';
import {
  CreateNewSubsplashListInputType,
  CreateNewSubsplashListOutputType,
} from '../../functions/src/createNewSubsplashList';

const addNewSeries = async (series: Series) => {
  // TODO: REMOVE THIS TO OCCUR ONLY AFTER THE SERMON WITH THE LIST IS UPLOADED
  // create list on subsplash
  const createNewSubsplashList = createFunctionV2<CreateNewSubsplashListInputType, CreateNewSubsplashListOutputType>(
    'createnewsubsplashlist'
  );
  const { listId } = await createNewSubsplashList({ title: series.name, subtitle: '', images: series.images });

  // create series on firestore
  const newSeriesRef = doc(collection(firestore, 'series')).withConverter(seriesConverter);
  await setDoc(newSeriesRef, {
    id: newSeriesRef.id,
    name: series.name,
    sermonIds: [],
    subsplashId: listId,
    images: series.images,
  });
  return listId;
};

export default addNewSeries;
