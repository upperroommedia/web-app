import React, { useCallback, useState } from 'react';
import { Sermon, sermonStatusType } from '../types/SermonTypes';
import ReplayIcon from '@mui/icons-material/Replay';
import IconButton from '@mui/material/IconButton';
import { createFunctionV2 } from '../utils/createFunction';
import { AddIntroOutroInputType } from '../functions/src/addIntroOutro/types';
import { getIntroAndOutro } from '../utils/uploadUtils';
import storage, { ref } from '../firebase/storage';
import Tooltip from '@mui/material/Tooltip';
import firestore, { doc, updateDoc } from '../firebase/firestore';
import { sermonConverter } from '../types/Sermon';
import CircularProgress from '@mui/material/CircularProgress';

interface RetryProcessButtonProps {
  sermon: Sermon;
}

export default function RetryProcessButton({ sermon }: RetryProcessButtonProps) {
  const [loading, setLoading] = useState(false);
  const handleRetry = useCallback(async (sermon: Sermon) => {
    try {
      setLoading(true);
      const { introRef, outroRef } = await getIntroAndOutro(sermon);
      const storageRef = ref(storage, `sermons/${sermon.id}`);
      const generateAddIntroOutroTask = createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
      const data: AddIntroOutroInputType = {
        id: sermon.id,
        storageFilePath: storageRef.fullPath,
        startTime: 0,
        duration: sermon.durationSeconds,
        deleteOriginal: true,
        introUrl: introRef,
        outroUrl: outroRef,
      };
      await generateAddIntroOutroTask(data);
    } catch (e) {
      let errorMessage: string;
      if (e instanceof Object && 'message' in e) {
        errorMessage = e.message as string;
      } else {
        errorMessage = JSON.stringify(e, Object.getOwnPropertyNames(e));
      }
      const sermonRef = doc(firestore, 'sermons', sermon.id).withConverter(sermonConverter);
      await updateDoc(sermonRef, {
        status: { ...sermon.status, audioStatus: sermonStatusType.ERROR, message: errorMessage },
      });

      // eslint-disable-next-line no-console
      console.error('Error generatingAddIntroOutroTask', e);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <>
      <Tooltip title="Retry Process Sermon">
        <IconButton onClick={() => handleRetry(sermon)}>
          {loading ? <CircularProgress size={24} /> : <ReplayIcon />}
        </IconButton>
      </Tooltip>
    </>
  );
}
