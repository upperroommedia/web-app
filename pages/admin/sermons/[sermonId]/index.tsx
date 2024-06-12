import firestore, { doc } from '../../../../firebase/firestore';
import { useRouter } from 'next/router';
import { useDocumentData } from 'react-firebase-hooks/firestore';

import { sermonConverter } from '../../../../types/Sermon';
import EditSermonForm from '../../../../components/EditSermonForm';
import { useSearchParams } from 'next/navigation';
import Button from '@mui/material/Button';
import { removeQueryParams } from '../../../../utils/utils';

const DetailedSermonView = () => {
  const router = useRouter();

  const listId = router.query.sermonId as string;
  const [sermon, _loading, _error] = useDocumentData(
    doc(firestore, `sermons/${listId}`).withConverter(sermonConverter)
  );

  const searchParams = useSearchParams();
  const isEditing = searchParams.has('edit');

  const getContent = () => {
    if (_loading) {
      return <div>Loading...</div>;
    }

    if (_error || !sermon) {
      return <div>Error loading sermon</div>;
    }

    if (isEditing) {
      return (
        <EditSermonForm
          sermon={sermon}
          onCancel={() => router.push(removeQueryParams(router.asPath), undefined, { shallow: true })}
        />
      );
    }

    return <>Detailed sermon view from uploader</>;
  };

  return (
    <>
      {!isEditing && (
        <Button
          onClick={() =>
            router.push({ pathname: removeQueryParams(router.asPath), query: 'edit' }, undefined, { shallow: true })
          }
        >
          Edit
        </Button>
      )}
      {getContent()}
    </>
  );
};

export default DetailedSermonView;
