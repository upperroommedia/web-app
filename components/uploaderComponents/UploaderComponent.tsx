/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import editSermon from '../../pages/api/editSermon';
import styles from '../../styles/Uploader.module.css';
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from 'react';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';

import firestore, { collection, getDocs, query, where } from '../../firebase/firestore';
import { createEmptySermon } from '../../types/Sermon';
import { Sermon, sermonStatusType } from '../../types/SermonTypes';

import Button from '@mui/material/Button';
// import ImageUploader from '../components/ImageUploader';

import ImageViewer from '../ImageViewer';
import { ImageSizeType, ImageType, isImageType } from '../../types/Image';
import ListSelector from '../ListSelector';
import FormControl from '@mui/material/FormControl';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import YouTubeTrimmer from '../YouTubeTrimmer';
import Typography from '@mui/material/Typography';
import Head from 'next/head';
import { List, listConverter, ListTag, ListType, SundayHomiliesMonthList } from '../../types/List';
import SubtitleSelector from '../SubtitleSelector';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { AddIntroOutroInputType } from '../../functions/src/addIntroOutro/types';
import { getIntroAndOutro } from '../../utils/uploadUtils';
import { PROCESSED_SERMONS_BUCKET } from '../../constants/storage_constants';
import { User } from '../../types/User';
import { VerifiedUserUploaderProps } from './VerifiedUserUploaderComponent';
import { showAudioTrimmerBoolean } from './utils';
import UploaderDatePicker from './UploaderDatePicker';
import { UploaderFieldError, UploadProgress } from '../../context/types';
import SpeakerSelector from './SpeakerSelector';
import SundayHomilyMonthSelector from './SundayHomilyMonthSelector';
import { SUNDAY_HOMILIES_STRING, BIBLE_STUDIES_STRING } from './consts';
import BibleChapterSelector from './BibleChapterSelector';
import UploadButton from './UploadButton';
import UploadProgressComponent from './UploadProgressComponent';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { AudioSource } from '../../pages/api/uploadFile';
import DropZone from '../DropZone';

const AudioTrimmerComponent = dynamic(() => import('../audioTrimmerComponents/AudioTrimmerComponent'));

interface UploaderProps extends VerifiedUserUploaderProps {
  user: User;
}

const emptySermon = createEmptySermon();

const Uploader = (props: UploaderProps) => {
  // ======================== START OF STATE ========================
  const router = useRouter();
  const [sermon, setSermon] = useState<Sermon>(() => {
    if (props.existingSermon) {
      return props.existingSermon;
    }
    return createEmptySermon(props.user.uid);
  });
  const [sermonList, setSermonList] = useState<List[]>(props.existingList || []);
  const [audioSource, setAudioSource] = useState<AudioSource | undefined>();
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({ error: false, percent: 0, message: '' });
  const [speakerError, setSpeakerError] = useState<UploaderFieldError>({ error: false, message: '' });
  const [isUploading, setIsUploading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [useYouTubeUrl, setUseYouTubeUrl] = useState(false);
  const [subtitles, setSubtitles] = useState<List[]>([]);

  // Bible Study Helpers
  const [selectedChapter, setSelectedChapter] = useState<List | null>(
    props.existingList?.find((list) => list.listTagAndPosition?.listTag === ListTag.BIBLE_CHAPTER) || null
  );

  // Sunday Homilies Helpers
  const [selectedSundayHomiliesMonth, setSelectedSundayHomiliesMonth] = useState<SundayHomiliesMonthList | null>(
    props.existingList?.find(
      (list) => list.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH
    ) as SundayHomiliesMonthList | null
  );

  const [sundayHomiliesYear, setSundayHomiliesYear] = useState<number>(() => {
    const sundayHomilyList = props.existingList?.find(
      (list) => list.listTagAndPosition?.listTag === ListTag.SUNDAY_HOMILY_MONTH
    );

    if (sundayHomilyList?.listTagAndPosition && 'year' in sundayHomilyList.listTagAndPosition) {
      return sundayHomilyList.listTagAndPosition.year;
    } else {
      return new Date().getFullYear();
    }
  });

  const [trimStart, setTrimStart] = useState<number>(0);
  const [hasTrimmed, setHasTrimmed] = useState(false);

  // TODO: REFACTOR THESE INTO SERMON DATA
  const [date, setDate] = useState<Date>(() =>
    props.existingSermon ? new Date(props.existingSermon.dateMillis) : new Date()
  );

  const [emptyListWithLatest, setEmptyListWithLatest] = useState<List[]>([]);

  // ======================== END OF STATE ========================

  const sermonsEqual = useCallback(
    (sermon1: Sermon, sermon2: Sermon): boolean => {
      const sermon1Date = new Date(sermon1.dateMillis);
      return (
        sermon1.title === sermon2.title &&
        sermon1.subtitle === sermon2.subtitle &&
        sermon1.description === sermon2.description &&
        sermon1Date.getDate() === date?.getDate() &&
        sermon1Date.getMonth() === date?.getMonth() &&
        sermon1Date.getFullYear() === date?.getFullYear() &&
        JSON.stringify(sermon1.images) === JSON.stringify(sermon2.images) &&
        JSON.stringify(sermon1.speakers) === JSON.stringify(sermon2.speakers) &&
        JSON.stringify(sermon1.topics) === JSON.stringify(sermon2.topics)
      );
    },
    [date]
  );

  const listEqual = (list1: List[], list2: List[]): boolean => {
    return JSON.stringify(list1) === JSON.stringify(list2);
  };

  const sermonEdited =
    !sermonsEqual(sermon, props.existingSermon || emptySermon) ||
    !listEqual(sermonList, props.existingList || emptyListWithLatest);

  const addList = useCallback(
    (list: List) => {
      setSermonList((previousList) => {
        if (previousList.find((prevList) => prevList.id === list.id)) {
          return previousList;
        }
        return [...previousList, list];
      });
    },
    [setSermonList]
  );

  useEffect(() => {
    const fetchData = async () => {
      // fetch subtitles
      const listQuery = query(
        collection(firestore, 'lists'),
        where('type', '==', ListType.CATEGORY_LIST)
      ).withConverter(listConverter);
      const listQuerySnapshot = await getDocs(listQuery);
      setSubtitles(
        listQuerySnapshot.docs.map((doc) => {
          const list = doc.data();
          return list;
        })
      );

      // fetch latest list
      if (!props.existingSermon) {
        const latestQuery = query(collection(firestore, 'lists'), where('type', '==', ListType.LATEST)).withConverter(
          listConverter
        );
        const latestSnap = await getDocs(latestQuery);
        if (latestSnap.docs.length > 0) {
          const latestList = latestSnap.docs[0].data();
          setEmptyListWithLatest([latestList]);
          addList(latestList);
        }
      }
    };
    fetchData();
  }, [addList, props.existingSermon]);

  useEffect(() => {
    if (props.existingList) {
      setSermonList(props.existingList);
    }
  }, [props.existingList]);

  useEffect(() => {
    const warningText = 'You have unsaved changes - are you sure you wish to leave this page?';
    const handleWindowClose = (e: BeforeUnloadEvent) => {
      if (!sermonEdited && !isUploading) return;
      e.preventDefault();
      return (e.returnValue = warningText);
    };
    const handleBrowseAway = () => {
      if (!sermonEdited && !isUploading) return;
      if (window.confirm(warningText)) return;
      router.events.emit('routeChangeError');
      throw new Error('routeChange aborted.');
    };
    window.addEventListener('beforeunload', handleWindowClose);
    router.events.on('routeChangeStart', handleBrowseAway);
    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
      router.events.off('routeChangeStart', handleBrowseAway);
    };
  }, [router.events, sermonEdited, isUploading]);

  const baseButtonDisabled =
    sermon.title === '' ||
    date === null ||
    sermon.speakers.length === 0 ||
    sermon.subtitle === '' ||
    sermon.description === '' ||
    (sermon.subtitle === BIBLE_STUDIES_STRING && !selectedChapter) ||
    (sermon.subtitle === SUNDAY_HOMILIES_STRING && !selectedSundayHomiliesMonth) ||
    sermon.durationSeconds <= 0 ||
    isUploading ||
    isEditing;

  const clearAudioTrimmer = useCallback(() => {
    setUseYouTubeUrl(false);
    setAudioSource(undefined);
    setTrimStart(0);
  }, [setAudioSource, setTrimStart]);

  const clearForm = () => {
    setSpeakerError({ error: false, message: '' });
    setSermon(createEmptySermon(props.user.uid));
    setEmptyListWithLatest([]);
    setSermonList([]);
    setDate(new Date());
    clearAudioTrimmer();
  };

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setSermon((prevSermon) => {
        return {
          ...prevSermon,
          [event.target.name]: event.target.value,
        };
      });
    },
    [setSermon]
  );

  const updateSermon = useCallback(
    <T extends keyof Sermon>(key: T, value: Sermon[T]) => {
      setSermon((oldSermon) => ({ ...oldSermon, [key]: value }));
    },
    [setSermon]
  );

  const handleDateChange = useCallback(
    (newValue: Date) => {
      setDate(newValue);
      updateSermon('dateMillis', newValue.getTime());
    },
    [setDate, updateSermon]
  );

  const setTrimDuration = useCallback(
    (durationSeconds: number) => {
      updateSermon('durationSeconds', durationSeconds);
    },
    [updateSermon]
  );

  const handleNewImage = useCallback(
    (image: ImageType | ImageSizeType) => {
      setSermon((oldSermon) => {
        // check if image is ImageType or ImageSizeType
        if (isImageType(image)) {
          const castedImage = image as ImageType;
          let newImages: ImageType[] = [];
          if (oldSermon.images.find((img) => img.type === castedImage.type)) {
            newImages = oldSermon.images.map((img) => (img.type === castedImage.type ? castedImage : img));
          } else {
            newImages = [...oldSermon.images, castedImage];
          }
          return {
            ...oldSermon,
            images: newImages,
          };
        } else {
          const imageSizeType = image as ImageSizeType;
          return {
            ...oldSermon,
            images: oldSermon.images.filter((img) => img.type !== imageSizeType),
          };
        }
      });
    },
    [setSermon]
  );

  const showAudioTrimmer = useMemo(() => {
    return showAudioTrimmerBoolean(props.existingSermon?.status.soundCloud, props.existingSermon?.status.subsplash);
  }, [props.existingSermon?.status.soundCloud, props.existingSermon?.status.subsplash]);

  return (
    <>
      <Head>
        <title>Uploader</title>
        <meta property="og:title" content="Uploader" key="title" />
        <meta name="description" content="Upload christian sermons to Upper Room Meida" key="description" />
      </Head>
      <FormControl
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'auto', md: '4fr 1fr' },
          maxWidth: '80%',
          gap: '1ch 100px',
          margin: 'auto',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <h1 style={{ justifySelf: 'center', gridColumn: '1/-1' }}>
          {props.existingSermon ? 'Edit Sermon' : 'Uploader'}
        </h1>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1ch',
            margin: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <TextField
            sx={{
              display: 'block',
              width: 1,
            }}
            fullWidth
            id="title-input"
            label="Title"
            name="title"
            variant="outlined"
            value={sermon.title}
            onChange={handleChange}
            required
          />
          <Box sx={{ display: 'flex', gap: '1ch', width: 1 }}>
            <SubtitleSelector
              subtitle={sermon.subtitle}
              sermonList={sermonList}
              setSermonList={setSermonList}
              setSermon={setSermon}
              subtitles={subtitles}
            />
            <UploaderDatePicker date={date} handleDateChange={handleDateChange} />
          </Box>
          <BibleChapterSelector
            sermonSubtitle={sermon.subtitle}
            setSermonList={setSermonList}
            selectedChapter={selectedChapter}
            setSelectedChapter={setSelectedChapter}
          />
          <SundayHomilyMonthSelector
            sermonSubtitle={sermon.subtitle}
            date={date}
            setSermonList={setSermonList}
            selectedSundayHomiliesMonth={selectedSundayHomiliesMonth}
            setSelectedSundayHomiliesMonth={setSelectedSundayHomiliesMonth}
            sundayHomiliesYear={sundayHomiliesYear}
            setSundayHomiliesYear={setSundayHomiliesYear}
          />
          <TextField
            sx={{
              display: 'block',
            }}
            fullWidth
            rows={4}
            id="description-text"
            label="Description"
            name="description"
            placeholder="Description"
            multiline
            value={sermon.description}
            onChange={handleChange}
            required
          />
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector
              sermonList={sermonList}
              setSermonList={setSermonList}
              listType={ListType.SERIES}
              subtitle={
                sermon.subtitle !== '' ? subtitles.find((subtitle) => subtitle.name === sermon.subtitle) : undefined
              }
            />
          </div>
          <SpeakerSelector
            sermonSpeakers={sermon.speakers}
            sermonImages={sermon.images}
            updateSermon={updateSermon}
            speakerError={speakerError}
            setSpeakerError={setSpeakerError}
            setSermon={setSermon}
            setSermonList={setSermonList}
          />
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector sermonList={sermonList} setSermonList={setSermonList} listType={ListType.TOPIC_LIST} />
          </div>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector sermonList={sermonList} setSermonList={setSermonList} />
          </div>
        </Box>
        <Box sx={{ margin: 'auto' }} width={1} maxWidth={300} minWidth={200}>
          <ImageViewer
            images={sermon.images}
            speaker={sermon.speakers[0]}
            newImageCallback={handleNewImage}
            vertical={true}
          />
        </Box>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '1ch',
            margin: 'auto',
            alignItems: 'center',
            justifyContent: 'center',
            width: 1,
          }}
        >
          {props.existingSermon && props.existingList ? (
            <Stack width={1}>
              {showAudioTrimmer ? (
                props.existingSermonUrl?.status === 'success' ? (
                  <AudioTrimmerComponent
                    url={props.existingSermonUrl.url}
                    trimStart={trimStart}
                    setTrimStart={setTrimStart}
                    setTrimDuration={setTrimDuration}
                    clearAudioTrimmer={clearAudioTrimmer}
                    setHasTrimmed={setHasTrimmed}
                  />
                ) : props.existingSermonUrl?.status === 'loading' ? (
                  <Stack alignItems="center" flexDirection="row" gap="1rem">
                    <CircularProgress size={24} />
                    <Typography variant="caption" sx={{ textAlign: 'center' }}>
                      Loading audio...
                    </Typography>
                  </Stack>
                ) : (
                  <Typography variant="caption">
                    Something went wrong loading the audio. Please try again later
                  </Typography>
                )
              ) : (
                <Typography variant="caption" sx={{ textAlign: 'center' }}>
                  Cannot edit audio when sermon has been uploaded to SoundCloud or Subsplash
                </Typography>
              )}
              <div style={{ display: 'grid', margin: 'auto', paddingTop: '20px' }}>
                <Button
                  onClick={async () => {
                    setIsEditing(true);
                    const promises = [];
                    const pendingSermon = sermon;
                    if (hasTrimmed) {
                      pendingSermon.status.audioStatus = sermonStatusType.PENDING;
                      pendingSermon.status.message = '';
                      const generateAddIntroOutroTask =
                        createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
                      const { introRef, outroRef } = await getIntroAndOutro(sermon);
                      const data: AddIntroOutroInputType = {
                        id: sermon.id,
                        storageFilePath: `${PROCESSED_SERMONS_BUCKET}/${sermon.id}`,
                        startTime: trimStart,
                        duration: sermon.durationSeconds,
                        deleteOriginal: false,
                        skipTranscode: true,
                        introUrl: introRef,
                        outroUrl: outroRef,
                      };
                      promises.push(generateAddIntroOutroTask(data));
                      promises.push(editSermon(pendingSermon, sermonList));
                      await Promise.all(promises);
                    }
                    promises.push(editSermon(sermon, sermonList));
                    setIsEditing(false);
                    props.setEditFormOpen?.(false);
                  }}
                  disabled={
                    (sermonsEqual(props.existingSermon, sermon) &&
                      listEqual(props.existingList, sermonList) &&
                      !hasTrimmed) ||
                    baseButtonDisabled
                  }
                  variant="contained"
                >
                  {isEditing ? <CircularProgress size="1.5rem" /> : 'Update Sermon'}
                </Button>
              </div>
            </Stack>
          ) : (
            <>
              {audioSource?.type === 'File' ? (
                <AudioTrimmerComponent
                  url={audioSource.source.preview}
                  trimStart={trimStart}
                  setTrimStart={setTrimStart}
                  setTrimDuration={setTrimDuration}
                  clearAudioTrimmer={clearAudioTrimmer}
                />
              ) : (
                <Box
                  display="flex"
                  flexDirection="column"
                  width={1}
                  justifyContent="center"
                  alignItems="center"
                  gap={1}
                >
                  <FormControlLabel
                    control={
                      <Switch
                        checked={useYouTubeUrl}
                        onChange={() => setUseYouTubeUrl((prevValue) => !prevValue)}
                        inputProps={{ 'aria-label': 'controlled' }}
                      />
                    }
                    label="Upload from Youtube Url"
                  />
                  {useYouTubeUrl ? (
                    <YouTubeTrimmer
                      trimStart={trimStart}
                      duration={sermon.durationSeconds}
                      setTrimStart={setTrimStart}
                      setDuration={setTrimDuration}
                      setAudioSource={setAudioSource}
                    />
                  ) : (
                    <DropZone setAudioSource={setAudioSource} />
                  )}
                </Box>
              )}
              <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
                <Box display="flex">
                  <UploadButton
                    user={props.user}
                    sermon={sermon}
                    audioSource={audioSource}
                    trimStart={trimStart}
                    sermonList={sermonList}
                    baseButtonDisabled={baseButtonDisabled}
                    date={date}
                    setUploadProgress={setUploadProgress}
                    setIsUploading={setIsUploading}
                    clearForm={clearForm}
                  />
                  <button type="button" className={styles.button} onClick={() => clearForm()}>
                    Clear Form
                  </button>
                </Box>
                <UploadProgressComponent isUploading={isUploading} uploadProgress={uploadProgress} />
              </Box>
            </>
          )}
        </Box>
      </FormControl>
    </>
  );
};

export default Uploader;
