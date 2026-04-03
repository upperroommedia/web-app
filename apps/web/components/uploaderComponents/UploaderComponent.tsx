/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import editSermon from '../../pages/api/editSermon';
import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';

import firestore, { collection, getDocs, query, where, doc, getDoc } from '../../firebase/firestore';
import { createEmptySermon } from '../../types/Sermon';
import { Sermon, sermonStatusType } from '../../types/SermonTypes';

import Button from '@mui/material/Button';
// import ImageUploader from '../components/ImageUploader';

import ImageViewer from '../ImageViewer';
import { ImageSizeType, ImageType, isImageType } from '../../types/Image';
import ListSelector from '../ListSelector';
import SeriesSelector from '../SeriesSelector';
import FormControl from '@mui/material/FormControl';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import YouTubeTrimmer from '../YouTubeTrimmer';
import Typography from '@mui/material/Typography';
import Head from 'next/head';
import { List, listConverter, ListTag, ListType, SundayHomiliesMonthList } from '../../types/List';
import { Series, seriesConverter } from '../../types/Series';
import SubtitleSelector from '../SubtitleSelector';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import { createFunctionV2 } from '../../utils/createFunction';
import { AddIntroOutroInputType } from '@upperroom/contracts/addIntroOutro/types';
import { getIntroAndOutro } from '../../utils/uploadUtils';
import { PROCESSED_SERMONS_BUCKET } from '../../constants/storage_constants';
import { User } from '../../types/User';
import { VerifiedUserUploaderProps } from './VerifiedUserUploaderComponent';
import { createFormErrorMessage, getErrorMessage, showAudioTrimmerBoolean, showError } from './utils';
import UploaderDatePicker from './UploaderDatePicker';
import { UploaderFieldError, UploadProgress } from '../../context/types';
import SpeakerSelector from './SpeakerSelector';
import SpeakerRequestPopup from './SpeakerRequestPopup';
import SundayHomilyMonthSelector from './SundayHomilyMonthSelector';
import { BIBLE_STUDIES_STRING, MAX_DURATION_SECONDS, SUNDAY_HOMILIES_STRING } from './consts';
import BibleChapterSelector from './BibleChapterSelector';
import UploadButton from './UploadButton';
import UploadProgressComponent from './UploadProgressComponent';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { AudioSource } from '../../pages/api/uploadFile';
import DropZone from '../DropZone';
import BundleListSelector from '../BundleListSelector';
import { getLatestListFromBundle, getSubtitlesFromBundle } from '../../utils/bundleHelpers';
import { isDiscoverableRootList } from '../../utils/algolia/searchRecords';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';

const AudioTrimmerComponent = dynamic(() => import('../audioTrimmerComponents/AudioTrimmerComponent'));

interface UploaderProps extends VerifiedUserUploaderProps {
  user: User;
}

const _fieldsToValidate = [
  'title',
  'subtitle',
  'series',
  'description',
  'audioSource',
  'speakers',
  'bibleChapter',
  'sundayHomiliesMonth',
  'durationSeconds',
  'topics',
] as const;

type FormErrors = {
  [K in (typeof _fieldsToValidate)[number]]?: UploaderFieldError;
};

const emptySermon = createEmptySermon();

const Uploader = (props: UploaderProps) => {
  const getFormErrorInitialState = useCallback(
    (): FormErrors =>
      !props.existingSermon
        ? {
          title: { error: true, message: createFormErrorMessage('title'), initialState: true },
          description: { error: true, message: createFormErrorMessage('description'), initialState: true },
          subtitle: { error: true, message: 'You must select a subtitle', initialState: true },
          series: { error: true, message: 'You must select a series', initialState: true },
          speakers: { error: true, message: 'You must select at least one speaker', initialState: true },
          audioSource: {
            error: true,
            message: 'You must select an audio source before uploading',
            initialState: true,
          },
          topics: { error: true, message: 'You must select at least one topic', initialState: true },
        }
        : {},
    [props.existingSermon]
  );
  // ======================== START OF STATE ========================
  const router = useRouter();
  const { invalidateSermonSearch } = useAlgoliaSearch();
  // Track intentional navigation (after successful save) to bypass unsaved changes warning
  const isIntentionalNavigation = useRef(false);
  const [sermon, setSermon] = useState<Sermon>(() => {
    if (props.existingSermon) {
      return props.existingSermon;
    }
    return createEmptySermon(props.user.uid);
  });
  const [sermonList, setSermonList] = useState<List[]>(props.existingList || []);
  const [audioSource, setAudioSource] = useState<AudioSource | undefined>();
  const [uploadProgress, setUploadProgress] = useState<UploadProgress>({ error: false, percent: 0, message: '' });
  const [invalidFormMessage, setInvalidFormMessage] = useState<string>();
  const [isUploading, setIsUploading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [useYouTubeUrl, setUseYouTubeUrl] = useState(false);
  const [uploadedSermon, setUploadedSermon] = useState<Sermon | null>(null);
  const [isNavigatingToSermon, setIsNavigatingToSermon] = useState(false);
  const [subtitles, setSubtitles] = useState<List[]>([]);
  const [subtitlesLoading, setSubtitlesLoading] = useState(true);
  const [formErrors, setFormErrors] = useState<FormErrors>(getFormErrorInitialState());
  const [showAdvancedListConfig, setShowAdvancedListConfig] = useState(false);
  const [speakerRequestPopupOpen, setSpeakerRequestPopupOpen] = useState(false);

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
  const [_hasTrimmed, setHasTrimmed] = useState(false);

  // Series selection (sermon can only be in one series)
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [uploadAsSeries, setUploadAsSeries] = useState<boolean>(() => Boolean(props.existingSermon?.seriesId));

  // Fetch series when editing existing sermon with seriesId
  useEffect(() => {
    const fetchSeriesForExistingSermon = async () => {
      if (!props.existingSermon?.seriesId) return;

      try {
        const seriesDoc = await getDoc(doc(firestore, 'series', props.existingSermon.seriesId).withConverter(seriesConverter));

        if (seriesDoc.exists()) {
          setSelectedSeries(seriesDoc.data());
        } else {
          // Series was deleted - silently ignore, sermon's seriesId will be cleaned up on next save
          console.warn(`Series ${props.existingSermon.seriesId} no longer exists`);
        }
      } catch (error) {
        // Permission error or series doesn't exist - silently ignore
        // The sermon's stale seriesId will be cleaned up when user saves
        console.warn('Could not fetch series for sermon:', error);
      }
    };

    fetchSeriesForExistingSermon();
  }, [props.existingSermon?.seriesId]);

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
        sermon1.seriesId === sermon2.seriesId &&
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
      // fetch subtitles using bundle system
      try {
        setSubtitlesLoading(true);
        const subtitlesFromBundle = await getSubtitlesFromBundle();
        setSubtitles(subtitlesFromBundle);
      } catch (error) {
        console.error('Error loading subtitles from bundle, falling back to Firestore:', error);
        // Fallback to manual fetch
        // Note: We can't use != filter here because Firestore requires inequality fields to be first in orderBy
        // Instead, we filter client-side after fetching
        const listQuery = query(
          collection(firestore, 'lists'),
          where('type', '==', ListType.CATEGORY_LIST)
        ).withConverter(listConverter);
        const listQuerySnapshot = await getDocs(listQuery);
        setSubtitles(
          listQuerySnapshot.docs
            .map((doc) => {
              const list = doc.data();
              return list;
            })
            .filter(isDiscoverableRootList)
        );
      } finally {
        setSubtitlesLoading(false);
      }

      // fetch latest list
      if (!props.existingSermon) {
        const latestListFromBundle = await getLatestListFromBundle();
        if (latestListFromBundle.length > 0) {
          const latestList = latestListFromBundle[0];
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
      if (isIntentionalNavigation.current) return;
      e.preventDefault();
      return (e.returnValue = warningText);
    };
    const handleBrowseAway = () => {
      // Skip warning if this is an intentional navigation (after successful save)
      if (isIntentionalNavigation.current) return;
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

  // ======================== START OF ERROR HANDLING ========================

  const setFormErrorCallback = useCallback(
    (
      key: (typeof _fieldsToValidate)[number],
      errorStatus: boolean,
      message?: string,
      initialState: boolean = false
    ) => {
      const newUploaderFieldError: UploaderFieldError = {
        error: errorStatus,
        message: message ?? '',
        initialState,
      };
      setFormErrors((prevFormErrors): FormErrors => {
        if (
          prevFormErrors[key]?.error === errorStatus &&
          prevFormErrors[key]?.message === (message ?? '') &&
          prevFormErrors[key]?.initialState === initialState
        ) {
          return prevFormErrors;
        }
        return {
          ...prevFormErrors,
          [key]: newUploaderFieldError,
        };
      });
      setInvalidFormMessage(undefined);
    },
    [setFormErrors, setInvalidFormMessage]
  );

  const setAudioSourceError = useCallback(
    (error: boolean, message: string) => {
      setFormErrorCallback('audioSource', error, message);
    },
    [setFormErrorCallback]
  );

  const setSubtitleError = useCallback(
    (error: boolean, message: string) => {
      setFormErrorCallback('subtitle', error, message);
    },
    [setFormErrorCallback]
  );

  const setBibleChapterError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('bibleChapter', error, message, initialState);
    },
    [setFormErrorCallback]
  );

  const setSundayHomiliesMonthError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('sundayHomiliesMonth', error, message, initialState);
    },
    [setFormErrorCallback]
  );
  const setSpeakerError = useCallback(
    (error: boolean, message: string) => {
      setFormErrorCallback('speakers', error, message);
    },
    [setFormErrorCallback]
  );

  const setTopicsError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('topics', error, message, initialState);
    },
    [setFormErrorCallback]
  );

  const setSeriesError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('series', error, message, initialState);
    },
    [setFormErrorCallback]
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormErrorCallback(
        event.target.name as (typeof _fieldsToValidate)[number],
        !event.target.validity.valid,
        createFormErrorMessage(event.target.name)
      );
      setSermon((prevSermon) => {
        return {
          ...prevSermon,
          [event.target.name]: event.target.value,
        };
      });
    },
    [setSermon, setFormErrorCallback]
  );

  const handleBlur = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const key = event.target.name as (typeof _fieldsToValidate)[number];
      setFormErrorCallback(key, !event.target.validity.valid, createFormErrorMessage(key));
    },
    [setFormErrorCallback]
  );

  const validateForm = useCallback((): boolean => {
    const isEditingExistingSermon = Boolean(props.existingSermon);
    const topicLists = sermonList.filter((list) => list.type === ListType.TOPIC_LIST);
    const shouldRequireBibleChapter = !uploadAsSeries && sermon.subtitle === BIBLE_STUDIES_STRING;
    const shouldRequireSundayMonth = !uploadAsSeries && sermon.subtitle === SUNDAY_HOMILIES_STRING;
    const shouldRequireAudioSource = !isEditingExistingSermon;

    const nextFormErrors: FormErrors = {
      title: {
        error: sermon.title.trim().length === 0,
        message: createFormErrorMessage('title'),
        initialState: false,
      },
      description: {
        error: sermon.description.trim().length === 0,
        message: createFormErrorMessage('description'),
        initialState: false,
      },
      speakers: {
        error: sermon.speakers.length === 0,
        message: 'You must select at least one speaker',
        initialState: false,
      },
      topics: {
        error: topicLists.length === 0,
        message: 'You must select at least one topic',
        initialState: false,
      },
      subtitle: {
        error: !uploadAsSeries && sermon.subtitle.trim().length === 0,
        message: 'You must select a subtitle',
        initialState: false,
      },
      series: {
        error: uploadAsSeries && !selectedSeries,
        message: 'You must select a series',
        initialState: false,
      },
      audioSource: {
        error: shouldRequireAudioSource && !audioSource,
        message: 'You must select an audio source before uploading',
        initialState: false,
      },
      bibleChapter: {
        error: shouldRequireBibleChapter && !selectedChapter,
        message: 'You must select a bible chapter',
        initialState: false,
      },
      sundayHomiliesMonth: {
        error: shouldRequireSundayMonth && !selectedSundayHomiliesMonth,
        message: 'You must select a sunday homily month',
        initialState: false,
      },
      durationSeconds: {
        error: false,
        message: '',
        initialState: false,
      },
    };

    if (audioSource) {
      if (sermon.durationSeconds <= 0) {
        nextFormErrors.durationSeconds = {
          error: true,
          message: 'Sermon audio duration must be longer than 0 seconds',
          initialState: false,
        };
      } else if (sermon.durationSeconds > MAX_DURATION_SECONDS) {
        nextFormErrors.durationSeconds = {
          error: true,
          message: `Sermon audio duration must be shorter than ${MAX_DURATION_SECONDS / 3600} hours`,
          initialState: false,
        };
      }
    }

    setFormErrors(nextFormErrors);
    return Object.values(nextFormErrors).every((uploaderFieldError) => !uploaderFieldError.error);
  }, [
    audioSource,
    props.existingSermon,
    selectedChapter,
    selectedSeries,
    selectedSundayHomiliesMonth,
    sermon.description,
    sermon.durationSeconds,
    sermon.speakers,
    sermon.subtitle,
    sermon.title,
    sermonList,
    uploadAsSeries,
  ]);

  // ======================== END OF ERROR HANDLING ========================

  const updateSermon = useCallback(
    <T extends keyof Sermon>(key: T, value: Sermon[T]) => {
      setSermon((oldSermon) => {
        if (oldSermon[key] === value) return oldSermon; // no change

        return { ...oldSermon, [key]: value };
      });
    },
    [setSermon]
  );

  // Convert selected topic lists to sermon.topics string array
  useEffect(() => {
    const topicNames = sermonList.filter((list) => list.type === ListType.TOPIC_LIST).map((list) => list.name);

    updateSermon('topics', topicNames);
  }, [sermonList, updateSermon]);

  // Update sermon.seriesId when selectedSeries changes
  useEffect(() => {
    updateSermon('seriesId', selectedSeries?.id);
  }, [selectedSeries, updateSermon]);

  useEffect(() => {
    if (!uploadAsSeries) return;
    if (selectedSeries) {
      setSeriesError(false, '');
    }
  }, [selectedSeries, setSeriesError, uploadAsSeries]);

  const handleUploadTargetToggle = useCallback(
    (isSeriesMode: boolean) => {
      setUploadAsSeries(isSeriesMode);
      if (isSeriesMode) {
        updateSermon('subtitle', '');
        setSubtitleError(false, '');
        setSeriesError(false, '');
        setSermonList((oldSermonList) =>
          oldSermonList.filter(
            (list) =>
              list.type !== ListType.CATEGORY_LIST ||
              Boolean(list.listTagAndPosition)
          )
        );
      } else {
        setSelectedSeries(null);
        setSeriesError(false, '');
        setSubtitleError(false, '');
      }
    },
    [setSeriesError, setSubtitleError, updateSermon]
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
      if (durationSeconds <= 0 && audioSource) {
        setFormErrorCallback('durationSeconds', true, 'Sermon audio duration must be longer than 0 seconds');
      } else if (durationSeconds > MAX_DURATION_SECONDS) {
        setFormErrorCallback(
          'durationSeconds',
          true,
          `Sermon audio duration must be shorter than ${MAX_DURATION_SECONDS / 3600} hours`
        );
      } else {
        setFormErrorCallback('durationSeconds', false, '');
      }
    },
    [updateSermon, setFormErrorCallback, audioSource]
  );

  const setTrimStartTime = useCallback(
    (trimStartTime: number) => {
      updateSermon('sourceStartTime', trimStartTime);
    },
    [updateSermon]
  );

  const clearAudioTrimmer = useCallback(() => {
    setAudioSourceError(true, 'You must select an audio source before uploading');
    setUseYouTubeUrl(false);
    setAudioSource(undefined);
    setTrimStartTime(0);
  }, [setAudioSource, setTrimStartTime, setAudioSourceError]);

  const clearForm = useCallback(() => {
    const latestListIds = new Set(emptyListWithLatest.map((list) => list.id));
    const nextDefaultLists = sermonList.filter((list) => latestListIds.has(list.id));
    setSermon(createEmptySermon(props.user.uid));
    setSermonList(nextDefaultLists);
    setSelectedSeries(null);
    setUploadAsSeries(false);
    setDate(new Date());
    clearAudioTrimmer();
    setFormErrors(getFormErrorInitialState());
  }, [clearAudioTrimmer, emptyListWithLatest, getFormErrorInitialState, props.user.uid, sermonList]);

  // Handle successful upload - store sermon for the success modal
  const handleUploadSuccess = useCallback(
    async (_sermonId: string) => {
      await invalidateSermonSearch();
      // Store the sermon data for the success modal
      setUploadedSermon({ ...sermon });
      setIsNavigatingToSermon(false);
    },
    [invalidateSermonSearch, sermon]
  );

  useEffect(() => {
    if (!uploadedSermon) return;
    const targetUrl = `/admin/sermons/${uploadedSermon.id}`;
    router.prefetch(targetUrl).catch((error) => {
      console.error('Failed to prefetch sermon details page:', error);
    });
  }, [uploadedSermon, router]);

  // Navigate to sermon details when user clicks "View Sermon"
  const navigateToSermon = useCallback(async () => {
    if (!uploadedSermon || isNavigatingToSermon) return;

    const targetUrl = `/admin/sermons/${uploadedSermon.id}`;

    // Mark navigation as intentional to skip unsaved changes warning
    isIntentionalNavigation.current = true;
    setIsNavigatingToSermon(true);

    try {
      const didNavigate = await router.push(targetUrl);
      if (!didNavigate) {
        isIntentionalNavigation.current = false;
        setIsNavigatingToSermon(false);
      }
    } catch (error) {
      console.error('Failed to navigate to sermon details:', error);
      isIntentionalNavigation.current = false;
      setIsNavigatingToSermon(false);
    }
  }, [uploadedSermon, isNavigatingToSermon, router]);

  // Dismiss the upload modal and stay on page
  const dismissUploadModal = useCallback(() => {
    const uploadSucceeded = !uploadProgress.error && uploadProgress.percent >= 100;
    setIsNavigatingToSermon(false);
    setIsUploading(false);
    setUploadedSermon(null);
    setUploadProgress({ error: false, percent: 0, message: '' });
    if (uploadSucceeded) {
      clearForm();
    }
  }, [clearForm, uploadProgress.error, uploadProgress.percent]);

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

  const audioSettingsChanged = useMemo(() => {
    if (!props.existingSermon) return false;

    return (
      Math.abs(sermon.sourceStartTime - props.existingSermon.sourceStartTime) > 0.05 ||
      Math.abs(sermon.durationSeconds - props.existingSermon.durationSeconds) > 0.05
    );
  }, [props.existingSermon, sermon.durationSeconds, sermon.sourceStartTime]);

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
            width: 1,
          }}
        >
          <Box sx={{ display: 'flex', gap: '1ch', width: 1, flexDirection: { xs: 'column', xl: 'row' } }}>
            <TextField
              sx={{
                display: 'block',
                width: 1,
                flexGrow: 2,
              }}
              fullWidth
              id="title-input"
              label="Title"
              name="title"
              variant="outlined"
              value={sermon.title}
              error={showError(formErrors.title)}
              helperText={getErrorMessage(formErrors.title)}
              onChange={handleChange}
              onBlur={handleBlur}
              required
            />
            <Box sx={{ flex: 1 }}>
              <UploaderDatePicker date={date} handleDateChange={handleDateChange} />
            </Box>
          </Box>
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
            onBlur={handleBlur}
            error={showError(formErrors.description)}
            helperText={getErrorMessage(formErrors.description)}
            required
          />
          {/* <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <ListSelector
              sermonList={sermonList}
              setSermonList={setSermonList}
              listType={ListType.SERIES}
              subtitle={
                sermon.subtitle !== '' ? subtitles.find((subtitle) => subtitle.name === sermon.subtitle) : undefined
              }
            />
          </div> */}
          <Box width={1} display="flex" justifyContent="flex-start" alignItems="center">
            <FormControlLabel
              control={
                <Switch
                  checked={uploadAsSeries}
                  onChange={(_, checked) => handleUploadTargetToggle(checked)}
                  name="uploadAsSeries"
                  inputProps={{ 'aria-label': 'Upload to series toggle' }}
                />
              }
              label="Upload to series"
            />
            <Tooltip
              title="If your sermon is part of a series you should use the series toggle. If it is not you must add it to one of the categories. The subtitle of the sermon will automatically assigned to either the series name or the category."
              enterTouchDelay={0}
              leaveTouchDelay={3000}
            >
              <IconButton size="small" aria-label="Series vs category info">
                <InfoOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          {uploadAsSeries ? (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
              <SeriesSelector
                selectedSeries={selectedSeries}
                setSelectedSeries={setSelectedSeries}
                required={uploadAsSeries}
                error={showError(formErrors.series)}
                helperText={getErrorMessage(formErrors.series)}
              />
            </div>
          ) : (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
              <SubtitleSelector
                subtitle={sermon.subtitle}
                sermonList={sermonList}
                setSermonList={setSermonList}
                setSermon={setSermon}
                subtitles={subtitles}
                subtitleError={formErrors?.subtitle}
                setSubtitleError={setSubtitleError}
                isLoading={subtitlesLoading}
                required={!uploadAsSeries}
              />
            </div>
          )}
          {!uploadAsSeries &&
            (sermon.subtitle === BIBLE_STUDIES_STRING || sermon.subtitle === SUNDAY_HOMILIES_STRING) && (
            <Box sx={{ display: 'flex', gap: '1ch', width: 1, flexDirection: { xs: 'column', xl: 'row' } }}>
              <BibleChapterSelector
                sermonSubtitle={sermon.subtitle}
                setSermonList={setSermonList}
                selectedChapter={selectedChapter}
                setSelectedChapter={setSelectedChapter}
                bibleChapterError={formErrors?.bibleChapter}
                setBibleChapterError={setBibleChapterError}
              />
              <SundayHomilyMonthSelector
                sermonSubtitle={sermon.subtitle}
                date={date}
                setSermonList={setSermonList}
                selectedSundayHomiliesMonth={selectedSundayHomiliesMonth}
                setSelectedSundayHomiliesMonth={setSelectedSundayHomiliesMonth}
                sundayHomiliesYear={sundayHomiliesYear}
                setSundayHomiliesYear={setSundayHomiliesYear}
                sundayHomiliesMonthError={formErrors?.sundayHomiliesMonth}
                setSundayHomiliesMonthError={setSundayHomiliesMonthError}
              />
            </Box>
          )}
          <SpeakerSelector
            sermonSpeakers={sermon.speakers}
            sermonImages={sermon.images}
            updateSermon={updateSermon}
            setSermon={setSermon}
            setSermonList={setSermonList}
            speakerError={formErrors?.speakers}
            setSpeakerError={setSpeakerError}
            showSpeakerRequestAction={!props.user.isAdmin()}
            onOpenSpeakerRequest={() => setSpeakerRequestPopupOpen(true)}
          />
          <SpeakerRequestPopup open={speakerRequestPopupOpen} setOpen={setSpeakerRequestPopupOpen} />
          <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
            <BundleListSelector
              sermonList={sermonList}
              setSermonList={setSermonList}
              listType={ListType.TOPIC_LIST}
              error={formErrors?.topics}
              setError={setTopicsError}
            />
          </div>
          <Box width={1} display="flex" alignItems="center" gap={0.5}>
            <Button
              size="small"
              variant="text"
              sx={{ minWidth: 'auto', px: 0.5, textTransform: 'none' }}
              onClick={() => setShowAdvancedListConfig((prev) => !prev)}
            >
              {showAdvancedListConfig ? 'Hide lists' : 'Advanced list config'}
            </Button>
            <Tooltip
              title="You can add or remove the sermon from specific lists. The lists get populated automatically when filling out the rest of the form"
              enterTouchDelay={0}
              leaveTouchDelay={3000}
            >
              <IconButton size="small" aria-label="Advanced list config info">
                <InfoOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
          {showAdvancedListConfig && (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center' }}>
              <ListSelector sermonList={sermonList} setSermonList={setSermonList} />
            </div>
          )}
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
                    trimStart={sermon.sourceStartTime}
                    trimDuration={sermon.durationSeconds}
                    setTrimStart={setTrimStartTime}
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
                    if (!validateForm()) {
                      setInvalidFormMessage('Please make sure all required fields are filled out');
                      return;
                    }
                    setInvalidFormMessage(undefined);
                    setIsEditing(true);
                    try {
                      const promises = [];

                      if (audioSettingsChanged) {
                        const pendingSermon = {
                          ...sermon,
                          status: {
                            ...sermon.status,
                            audioStatus: sermonStatusType.PENDING,
                            message: '',
                          },
                        };
                        const generateAddIntroOutroTask =
                          createFunctionV2<AddIntroOutroInputType>('addintrooutrotaskgenerator');
                        const { introRef, outroRef } = await getIntroAndOutro(sermon);
                        const data: AddIntroOutroInputType = {
                          id: sermon.id,
                          storageFilePath: `${PROCESSED_SERMONS_BUCKET}/${sermon.id}`,
                          startTime: sermon.sourceStartTime,
                          duration: sermon.durationSeconds,
                          deleteOriginal: false,
                          skipTranscode: true,
                          introUrl: introRef,
                          outroUrl: outroRef,
                        };
                        promises.push(generateAddIntroOutroTask(data));
                        promises.push(
                          editSermon(pendingSermon, sermonList, { originalSeriesId: props.existingSermon?.seriesId })
                        );
                      } else {
                        promises.push(editSermon(sermon, sermonList, { originalSeriesId: props.existingSermon?.seriesId }));
                      }

                      await Promise.all(promises);
                      // Mark as intentional navigation to bypass unsaved changes warning
                      isIntentionalNavigation.current = true;
                      props.setEditFormOpen?.(false);
                    } finally {
                      setIsEditing(false);
                    }
                  }}
                  disabled={
                    sermonsEqual(props.existingSermon, sermon) &&
                    listEqual(props.existingList, sermonList) &&
                    !audioSettingsChanged
                  }
                  variant="contained"
                >
                  {isEditing ? <CircularProgress size="1.5rem" /> : 'Update Sermon'}
                </Button>
              </div>
              {invalidFormMessage && (
                <Typography sx={{ textAlign: 'center', color: 'error.main' }}>{invalidFormMessage}</Typography>
              )}
            </Stack>
          ) : (
            <>
              {audioSource?.type === 'File' ? (
                <AudioTrimmerComponent
                  url={audioSource.source.preview}
                  trimStart={sermon.sourceStartTime}
                  setTrimStart={setTrimStartTime}
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
                        onChange={() => {
                          setTrimStartTime(0);
                          setUseYouTubeUrl((prevValue) => !prevValue);
                        }}
                        name="useYouTubeUrl"
                        inputProps={{ 'aria-label': 'Upload from Youtube Url toggle' }}
                      />
                    }
                    label="Upload from Youtube Url"
                  />
                  {useYouTubeUrl ? (
                    <YouTubeTrimmer
                      trimStart={sermon.sourceStartTime}
                      duration={sermon.durationSeconds}
                      setTrimStart={setTrimStartTime}
                      setDuration={setTrimDuration}
                      setAudioSource={setAudioSource}
                      audioSourceError={formErrors?.audioSource}
                      setAudioSourceError={setAudioSourceError}
                    />
                  ) : (
                    <DropZone
                      setAudioSource={setAudioSource}
                      audioSourceError={formErrors?.audioSource}
                      setAudioSourceError={setAudioSourceError}
                    />
                  )}
                </Box>
              )}
              <Box display="flex" flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
                <Typography
                  variant="caption"
                  color="error.dark"
                  textAlign="center"
                  visibility={showError(formErrors.durationSeconds) ? 'visible' : 'hidden'}
                >
                  {getErrorMessage(formErrors.durationSeconds)}
                </Typography>
                <Box display="flex" gap={2}>
                  <UploadButton
                    user={props.user}
                    sermon={sermon}
                    audioSource={audioSource}
                    trimStart={sermon.sourceStartTime}
                    sermonList={sermonList}
                    date={date}
                    validateForm={validateForm}
                    setUploadProgress={setUploadProgress}
                    setInvalidFormMessage={setInvalidFormMessage}
                    setIsUploading={setIsUploading}
                    onUploadSuccess={handleUploadSuccess}
                  />
                  <Button variant="outlined" color="secondary" onClick={() => clearForm()}>
                    Clear Form
                  </Button>
                </Box>
                {invalidFormMessage && (
                  <Typography sx={{ textAlign: 'center', color: 'error.main' }}>{invalidFormMessage}</Typography>
                )}
                <UploadProgressComponent
                  audioSource={audioSource}
                  isUploading={isUploading}
                  uploadProgress={uploadProgress}
                  sermon={uploadedSermon || undefined}
                  isNavigatingToSermon={isNavigatingToSermon}
                  onNavigateToSermon={navigateToSermon}
                  onDismiss={dismissUploadModal}
                />
              </Box>
            </>
          )}
        </Box>
      </FormControl>
    </>
  );
};

export default Uploader;
