/**
 * Page for uploaders to use to upload, trim, and add intro/outro to audio file
 */
import editSermon from '../../utils/editSermon';
import { isSermonProcessingConflict } from '../../utils/sermonEditing';
import { ChangeEvent, useCallback, useEffect, useMemo, useState, useRef } from 'react';
import TextField from '@mui/material/TextField';
import Box from '@mui/material/Box';

import {
  loadUploaderCatalog,
  readCompleteUploaderCatalog,
  applyLatestUploaderDefault,
  catalogBlocksNewAdmission,
} from '../../utils/uploaderCatalog';
import type { Dispatch, SetStateAction } from 'react';
import type { QueryDocumentSnapshot } from 'firebase/firestore';
import firestore, { collection, getDocs, query, where, doc, getDoc, limit, startAfter } from '../../firebase/firestore';
import { createEmptySermon } from '../../types/Sermon';
import { Sermon } from '../../types/SermonTypes';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormLabel from '@mui/material/FormLabel';

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
import {
  type HolyWeekDayList,
  type HolyWeekYearList,
  List,
  listConverter,
  ListTag,
  ListType,
  SundayHomiliesMonthList,
} from '../../types/List';
import { Series, seriesConverter } from '../../types/Series';
import SubtitleSelector from '../SubtitleSelector';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import Alert from '@mui/material/Alert';
import type { DurableJob } from '@upperroom/contracts/temporal';
import { User } from '../../types/User';
import { VerifiedUserUploaderProps } from './VerifiedUserUploaderComponent';
import { createFormErrorMessage, getErrorMessage, showError } from './utils';
import UploaderDatePicker from './UploaderDatePicker';
import { UploaderFieldError } from '../../context/types';
import SpeakerSelector from './SpeakerSelector';
import SpeakerRequestPopup from './SpeakerRequestPopup';
import SundayHomilyMonthSelector from './SundayHomilyMonthSelector';
import { BIBLE_STUDIES_STRING, MAX_DURATION_SECONDS, PASCHA_WEEK_STRING, SUNDAY_HOMILIES_STRING } from './consts';
import BibleChapterSelector from './BibleChapterSelector';
import HolyWeekSelector from './HolyWeekSelector';
import UploadButton from './UploadButton';
import UploadProgressComponent from './UploadProgressComponent';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import uploadFile, {
  AudioAdmissionReceipt,
  AudioTransferProgress,
  readAudioJob,
  sourceUploadSession,
  transferAudioSource,
} from '../../utils/uploadFile';
import { useDurableJob } from '../../hooks/useDurableJobs';
import JobStatusPanel from '../jobs/JobStatusPanel';
import LinearProgress from '@mui/material/LinearProgress';
import DropZone from '../DropZone';
import { useOwnedAudioSource } from '../../hooks/useOwnedAudioSource';
import BundleListSelector from '../BundleListSelector';
import { getLatestListFromBundle, getSubtitlesFromBundle } from '../../utils/bundleHelpers';
import { isDiscoverableRootList } from '../../utils/algolia/searchRecords';
import { useAlgoliaSearch } from '../../context/search/AlgoliaSearchContext';
import {
  canEditSermonAudio,
  requiresSoundCloudAudioPolicy,
  canEditSermonRecord,
  isSermonProcessingLocked,
} from '../../utils/sermonEditing';
import {
  clearIntentionalNavigation,
  isIntentionalNavigation,
  markIntentionalNavigation,
} from '../../utils/intentionalNavigation';
import { removeCategoryScopedLists } from '../../utils/categoryScopedLists';

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
  'holyWeekYear',
  'holyWeekDay',
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
  const resumeJobId = typeof router.query.resumeJob === 'string' ? router.query.resumeJob : undefined;
  const { job: resumeJob, loading: resumeLoading, error: resumeError, stale: resumeStale } = useDurableJob(resumeJobId);
  const [resumeFile, setResumeFile] = useState<File>();
  const { invalidateSermonSearch } = useAlgoliaSearch();
  const [sermon, setSermon] = useState<Sermon>(() => {
    if (props.existingSermon) {
      return props.existingSermon;
    }
    return createEmptySermon(props.user.uid);
  });
  const destinationEdited = useRef(false);
  const latestDefaultApplied = useRef(false);
  const [sermonList, setSermonListState] = useState<List[]>(props.existingList || []);
  const setSermonList = useCallback<Dispatch<SetStateAction<List[]>>>((next) => {
    // Explicit clearing is a choice too; neither a late default nor Retry may undo it.
    destinationEdited.current = true;
    setSermonListState(next);
  }, []);
  const [audioSource, setAudioSource, selectAudioFile] = useOwnedAudioSource();
  const [uploadProgress, setUploadProgress] = useState<AudioTransferProgress>({
    error: false,
    percent: 0,
    message: '',
  });
  const [invalidFormMessage, setInvalidFormMessage] = useState<string>();
  const [isUploading, setIsUploading] = useState(false);
  const sourceRetryInFlight = useRef(false);
  const [uploadReceipt, setUploadReceipt] = useState<AudioAdmissionReceipt>();
  const [isEditing, setIsEditing] = useState(false);
  const [soundcloudPolicy, setSoundcloudPolicy] = useState<'recreate_track' | 'keep_existing_audio'>('recreate_track');
  const [useYouTubeUrl, setUseYouTubeUrl] = useState(false);
  const [uploadedSermon, setUploadedSermon] = useState<Sermon | null>(null);
  const [isNavigatingToSermon, setIsNavigatingToSermon] = useState(false);
  const [subtitles, setSubtitles] = useState<List[]>([]);
  const [subtitlesLoading, setSubtitlesLoading] = useState(true);
  const [latestListLoading, setLatestListLoading] = useState(!props.existingSermon);
  const [catalogErrors, setCatalogErrors] = useState<{ subtitles?: boolean; latest?: boolean }>({});
  const [catalogAttempt, setCatalogAttempt] = useState(0);
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
  const [selectedHolyWeekYear, setSelectedHolyWeekYear] = useState<HolyWeekYearList | null>(
    props.existingList?.find(
      (list) =>
        list.listTagAndPosition?.listTag === ListTag.HOLY_WEEK &&
        'holyWeekKind' in list.listTagAndPosition &&
        list.listTagAndPosition.holyWeekKind === 'year'
    ) as HolyWeekYearList | null
  );
  const [selectedHolyWeekDay, setSelectedHolyWeekDay] = useState<HolyWeekDayList | null>(
    props.existingList?.find(
      (list) =>
        list.listTagAndPosition?.listTag === ListTag.HOLY_WEEK &&
        'holyWeekKind' in list.listTagAndPosition &&
        list.listTagAndPosition.holyWeekKind === 'day'
    ) as HolyWeekDayList | null
  );
  const [_hasTrimmed, setHasTrimmed] = useState(false);

  // Series selection (sermon can only be in one series)
  const [selectedSeries, setSelectedSeries] = useState<Series | null>(null);
  const [uploadAsSeries, setUploadAsSeries] = useState<boolean>(() => Boolean(props.existingSermon?.seriesId));

  // Fetch series when editing existing sermon with seriesId
  useEffect(() => {
    const fetchSeriesForExistingSermon = async () => {
      if (!props.existingSermon?.seriesId) return;

      try {
        const seriesDoc = await getDoc(
          doc(firestore, 'series', props.existingSermon.seriesId).withConverter(seriesConverter)
        );

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

  useEffect(() => {
    let cancelled = false;
    setSubtitlesLoading(true);
    setLatestListLoading(!props.existingSermon);
    setCatalogErrors({});
    // Observe these independently: default lookup must not wait on a category fallback.
    void loadUploaderCatalog(
      async () => (await getSubtitlesFromBundle()).filter(isDiscoverableRootList),
      async () => {
        const items = await readCompleteUploaderCatalog<List, QueryDocumentSnapshot<List>>(
          async (cursor, count) => {
            const listQuery = query(
              collection(firestore, 'lists'),
              where('type', '==', ListType.CATEGORY_LIST),
              ...(cursor ? [startAfter(cursor)] : []),
              limit(count)
            ).withConverter(listConverter);
            const snapshot = await getDocs(listQuery);
            return { items: snapshot.docs.map((item) => item.data()), cursor: snapshot.docs.at(-1) };
          },
          () => !cancelled
        );
        return items.filter(isDiscoverableRootList);
      },
      () => !cancelled
    ).then((result) => {
      if (cancelled) return;
      if (result.ok) setSubtitles(result.items);
      setCatalogErrors((previous) => ({ ...previous, subtitles: !result.ok }));
      setSubtitlesLoading(false);
    });
    if (!props.existingSermon) {
      void loadUploaderCatalog(
        getLatestListFromBundle,
        async () => {
          const snapshot = await getDocs(
            query(collection(firestore, 'lists'), where('type', '==', ListType.LATEST), limit(1)).withConverter(
              listConverter
            )
          );
          return snapshot.docs.map((item) => item.data());
        },
        () => !cancelled
      ).then((result) => {
        if (cancelled) return;
        if (result.ok) {
          const defaults = result.items.slice(0, 1);
          setEmptyListWithLatest(defaults);
          const firstResolvedLoad = !latestDefaultApplied.current;
          latestDefaultApplied.current = true;
          setSermonListState((previous) =>
            applyLatestUploaderDefault(previous, defaults, firstResolvedLoad, destinationEdited.current)
          );
        }
        setCatalogErrors((previous) => ({ ...previous, latest: !result.ok }));
        setLatestListLoading(false);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [catalogAttempt, props.existingSermon]);

  useEffect(() => {
    if (props.existingSermon && props.existingList) {
      setSermonListState(props.existingList);
    }
  }, [props.existingList, props.existingSermon]);

  useEffect(() => {
    clearIntentionalNavigation();
  }, []);

  useEffect(() => {
    const warningText = 'You have unsaved changes - are you sure you wish to leave this page?';
    const handleWindowClose = (e: BeforeUnloadEvent) => {
      if ((!sermonEdited || uploadReceipt || resumeJobId) && !isUploading) return;
      if (isIntentionalNavigation()) return;
      e.preventDefault();
      return (e.returnValue = warningText);
    };
    const handleBrowseAway = () => {
      // Skip warning if this is an intentional navigation (after successful save)
      if (isIntentionalNavigation()) return;
      if ((!sermonEdited || uploadReceipt || resumeJobId) && !isUploading) return;
      if (window.confirm(warningText)) return;
      router.events.emit('routeChangeError');
      const routeAbortError = Object.assign(new Error('routeChange aborted.'), { cancelled: true });
      throw routeAbortError;
    };
    window.addEventListener('beforeunload', handleWindowClose);
    router.events.on('routeChangeStart', handleBrowseAway);
    return () => {
      window.removeEventListener('beforeunload', handleWindowClose);
      router.events.off('routeChangeStart', handleBrowseAway);
    };
  }, [router.events, sermonEdited, isUploading, uploadReceipt, resumeJobId]);

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
  const setHolyWeekYearError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('holyWeekYear', error, message, initialState);
    },
    [setFormErrorCallback]
  );
  const setHolyWeekDayError = useCallback(
    (error: boolean, message: string, initialState: boolean = false) => {
      setFormErrorCallback('holyWeekDay', error, message, initialState);
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
    const shouldRequireHolyWeekYear = !uploadAsSeries && sermon.subtitle === PASCHA_WEEK_STRING;
    const shouldRequireHolyWeekDay = !uploadAsSeries && sermon.subtitle === PASCHA_WEEK_STRING;
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
      holyWeekYear: {
        error: shouldRequireHolyWeekYear && !selectedHolyWeekYear,
        message: 'You must select a Pascha week year',
        initialState: false,
      },
      holyWeekDay: {
        error: shouldRequireHolyWeekDay && !selectedHolyWeekDay,
        message: 'You must select a Holy Week day',
        initialState: false,
      },
      durationSeconds: {
        error: false,
        message: '',
        initialState: false,
      },
    };

    if (audioSource) {
      if ((sermon.trimDurationSeconds ?? 0) <= 0) {
        nextFormErrors.durationSeconds = {
          error: true,
          message: 'Sermon audio duration must be longer than 0 seconds',
          initialState: false,
        };
      } else if ((sermon.trimDurationSeconds ?? 0) > MAX_DURATION_SECONDS) {
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
    selectedHolyWeekDay,
    selectedHolyWeekYear,
    selectedSeries,
    selectedSundayHomiliesMonth,
    sermon.description,
    sermon.trimDurationSeconds,
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
    if (!props.existingSermon) return;
    if (audioSource?.type !== 'YoutubeUrl') return;
    updateSermon('youtubeUrl', audioSource.source);
  }, [audioSource, props.existingSermon, updateSermon]);

  useEffect(() => {
    if (sermon.subtitle !== BIBLE_STUDIES_STRING) {
      setSelectedChapter(null);
    }
    if (sermon.subtitle !== SUNDAY_HOMILIES_STRING) {
      setSelectedSundayHomiliesMonth(null);
    }
    if (sermon.subtitle !== PASCHA_WEEK_STRING) {
      setSelectedHolyWeekYear(null);
      setSelectedHolyWeekDay(null);
    }
  }, [sermon.subtitle]);

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
        setSermonList((oldSermonList) => removeCategoryScopedLists(oldSermonList));
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
      updateSermon('trimDurationSeconds', durationSeconds);
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
    async (sermonId: string) => {
      await invalidateSermonSearch();
      // Store the sermon data for the success modal
      setUploadedSermon({ ...sermon, id: sermonId });
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
  const navigateToSermon = useCallback(
    async (canonicalSermonId?: string) => {
      const sermonId = canonicalSermonId ?? uploadedSermon?.id;
      if (!sermonId || isNavigatingToSermon) return;

      const targetUrl = `/admin/sermons/${sermonId}`;

      // Mark navigation as intentional to skip unsaved changes warning
      markIntentionalNavigation();
      setIsNavigatingToSermon(true);

      try {
        const didNavigate = await router.push(targetUrl);
        if (!didNavigate) {
          clearIntentionalNavigation();
          setIsNavigatingToSermon(false);
        }
      } catch (error) {
        console.error('Failed to navigate to sermon details:', error);
        clearIntentionalNavigation();
        setIsNavigatingToSermon(false);
      }
    },
    [uploadedSermon, isNavigatingToSermon, router]
  );

  const retryRetainedSource = useCallback(
    async (job: DurableJob) => {
      if (
        sourceRetryInFlight.current ||
        !audioSource ||
        !uploadReceipt ||
        job.jobId !== uploadReceipt.jobId ||
        job.kind !== 'upload.create' ||
        job.requestedBy !== props.user.uid ||
        job.result?.mediaJobId ||
        job.result?.mediaJobRef ||
        !['cancelled', 'failed', 'superseded'].includes(job.state)
      )
        return;
      sourceRetryInFlight.current = true;
      setIsUploading(true);
      try {
        const receipt = await uploadFile({
          retryOfJobId: job.jobId,
          receipt: uploadReceipt,
          audioSource,
          setUploadProgress,
          trimStart: sermon.sourceStartTime,
          sermon,
          sermonList,
          onAdmission: (admitted) => {
            setUploadReceipt(admitted);
            if (admitted.sermonId) setUploadedSermon({ ...sermon, id: admitted.sermonId });
          },
        });
        if (receipt.sermonId && receipt.alreadyComplete) {
          await navigateToSermon(receipt.sermonId);
        } else if (receipt.sermonId) {
          await handleUploadSuccess(receipt.sermonId);
        }
      } catch (error) {
        // The original source and receipt remain available until a new admission is confirmed.
        setUploadProgress({
          error: true,
          percent: 0,
          message:
            error instanceof Error
              ? error.message
              : 'The new attempt could not be confirmed. Your source has been kept. Check Activity before trying again.',
        });
      } finally {
        sourceRetryInFlight.current = false;
        setIsUploading(false);
      }
    },
    [audioSource, uploadReceipt, props.user.uid, sermon, sermonList, handleUploadSuccess, navigateToSermon]
  );

  // Dismiss the upload modal and stay on page
  const dismissUploadModal = useCallback(() => {
    const hasDurableRequest = Boolean(uploadReceipt);
    setIsNavigatingToSermon(false);
    setIsUploading(false);
    setUploadedSermon(null);
    setUploadReceipt(undefined);
    setUploadProgress({ error: false, percent: 0, message: '' });
    if (hasDurableRequest) {
      clearForm();
    }
  }, [clearForm, uploadReceipt]);

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

  const canEditExistingSermon = useMemo(
    () => (props.existingSermon ? canEditSermonRecord(props.existingSermon) : true),
    [props.existingSermon]
  );

  const canEditExistingAudio = useMemo(
    () =>
      props.existingSermon
        ? canEditSermonAudio(
            props.existingSermon,
            props.existingList || [],
            props.existingSermonUrl?.status === 'success'
          )
        : false,
    [props.existingList, props.existingSermon, props.existingSermonUrl?.status]
  );
  const existingSermonHasSavedTrimSettings = useMemo(
    () =>
      Boolean(
        props.existingSermon &&
          typeof props.existingSermon.trimDurationSeconds === 'number' &&
          props.existingSermon.trimDurationSeconds > 0
      ),
    [props.existingSermon]
  );
  const canReprocessExistingAudio = useMemo(
    () => canEditExistingAudio && existingSermonHasSavedTrimSettings,
    [canEditExistingAudio, existingSermonHasSavedTrimSettings]
  );

  const isExistingYouTubeSermon = Boolean(props.existingSermon?.youtubeUrl);

  const existingAudioEditMessage = useMemo(() => {
    if (!props.existingSermon) return null;
    if (isSermonProcessingLocked(props.existingSermon)) {
      return 'This sermon cannot be edited while audio is queued or processing.';
    }
    if (!existingSermonHasSavedTrimSettings) {
      return 'This sermon audio cannot be edited because it does not have saved trim-source settings.';
    }
    if (!isExistingYouTubeSermon && props.existingSermonUrl?.status === 'error') {
      return 'This sermon audio cannot be edited because the source audio file is unavailable.';
    }
    if (!isExistingYouTubeSermon && props.existingSermonUrl?.status === 'unavailable') {
      return 'This sermon audio cannot be edited because the source audio file is unavailable.';
    }
    return null;
  }, [
    existingSermonHasSavedTrimSettings,
    isExistingYouTubeSermon,
    props.existingList,
    props.existingSermon,
    props.existingSermonUrl?.status,
  ]);

  const audioSettingsChanged = useMemo(() => {
    if (!props.existingSermon || !canReprocessExistingAudio) return false;

    return (
      Math.abs(sermon.sourceStartTime - props.existingSermon.sourceStartTime) > 0.05 ||
      Math.abs((sermon.trimDurationSeconds ?? 0) - (props.existingSermon.trimDurationSeconds ?? 0)) > 0.05 ||
      (sermon.youtubeUrl ?? '') !== (props.existingSermon.youtubeUrl ?? '')
    );
  }, [
    canReprocessExistingAudio,
    props.existingSermon,
    sermon.sourceStartTime,
    sermon.trimDurationSeconds,
    sermon.youtubeUrl,
  ]);

  const existingSermonHasChanges = useMemo(() => {
    if (!props.existingSermon) return true;

    return (
      !sermonsEqual(sermon, props.existingSermon) ||
      !listEqual(sermonList, props.existingList || emptyListWithLatest) ||
      audioSettingsChanged
    );
  }, [
    audioSettingsChanged,
    emptyListWithLatest,
    props.existingList,
    props.existingSermon,
    sermon,
    sermonList,
    sermonsEqual,
  ]);

  if (resumeJobId) {
    return (
      <Box sx={{ maxWidth: 720, mx: 'auto', p: 3 }}>
        <Head>
          <title>Resume audio upload</title>
        </Head>
        <Typography variant="h4" sx={{ mb: 2 }}>
          Resume audio upload
        </Typography>
        {resumeLoading && <Typography role="status">Loading saved upload…</Typography>}
        {(resumeError || resumeStale) && (
          <Alert severity="info">Reconnecting. Wait for current status before sending the file.</Alert>
        )}
        {resumeJob && <JobStatusPanel job={resumeJob} stale={resumeStale} />}
        {resumeJob?.state === 'awaiting_source' && (
          <Stack spacing={2} sx={{ mt: 2 }}>
            <Typography>
              Select the original audio file. We check its content before sending it to the saved upload session.
            </Typography>
            <input
              type="file"
              accept="audio/*"
              aria-label="Original audio file"
              disabled={isUploading}
              onChange={(event) => {
                setResumeFile(event.target.files?.[0]);
                setUploadProgress({ error: false, percent: 0, message: '' });
              }}
            />
            <Button
              variant="contained"
              disabled={!resumeFile || isUploading || resumeStale}
              onClick={async () => {
                if (!resumeFile || isUploading) return;
                setIsUploading(true);
                try {
                  const currentJob = await readAudioJob(resumeJobId);
                  sourceUploadSession(currentJob);
                  await transferAudioSource(currentJob, resumeFile, setUploadProgress);
                  setUploadProgress({
                    error: false,
                    percent: 100,
                    message: 'File received. Follow processing in Activity.',
                  });
                } catch (error) {
                  setUploadProgress({
                    error: true,
                    percent: 0,
                    message:
                      error instanceof Error
                        ? error.message
                        : 'The file transfer could not be confirmed. Your source has been retained.',
                  });
                } finally {
                  setIsUploading(false);
                }
              }}
            >
              {isUploading ? 'Sending file…' : 'Send original file'}
            </Button>
          </Stack>
        )}
        {isUploading && (
          <LinearProgress
            aria-label="Audio file transfer"
            variant={uploadProgress.phase === 'transferring' ? 'determinate' : 'indeterminate'}
            value={uploadProgress.phase === 'transferring' ? uploadProgress.percent : undefined}
            sx={{ mt: 2 }}
          />
        )}
        {uploadProgress.message && (
          <Alert severity={uploadProgress.error ? 'warning' : 'info'} sx={{ mt: 2 }}>
            {uploadProgress.message}
          </Alert>
        )}
        {user.isAdmin() && (
          <Button sx={{ mt: 2 }} onClick={() => void router.push('/admin/activity')}>
            Open Activity
          </Button>
        )}
      </Box>
    );
  }

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
        {(catalogErrors.subtitles || catalogErrors.latest) && (
          <Alert
            severity="warning"
            sx={{ gridColumn: '1/-1' }}
            action={
              <Button color="inherit" onClick={() => setCatalogAttempt((attempt) => attempt + 1)}>
                Retry
              </Button>
            }
          >
            {catalogErrors.subtitles ? 'Categories could not be loaded completely. ' : ''}
            {catalogErrors.latest ? 'The default destination could not be verified. ' : ''}
            {!props.existingSermon && !uploadReceipt
              ? 'Uploading is paused until categories and the default destination are available. Your local audio and choices are kept.'
              : 'Your existing destinations and local changes are kept.'}
          </Alert>
        )}
        {!props.existingSermon && (subtitlesLoading || latestListLoading) && (
          <Typography role="status" sx={{ gridColumn: '1/-1' }}>
            Checking categories and default destination… Local audio controls remain available.
          </Typography>
        )}

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
            (sermon.subtitle === BIBLE_STUDIES_STRING ||
              sermon.subtitle === SUNDAY_HOMILIES_STRING ||
              sermon.subtitle === PASCHA_WEEK_STRING) && (
              <Box sx={{ display: 'flex', gap: '1ch', width: 1, flexDirection: { xs: 'column', xl: 'row' } }}>
                {(sermon.subtitle === BIBLE_STUDIES_STRING || sermon.subtitle === SUNDAY_HOMILIES_STRING) && (
                  <>
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
                  </>
                )}
                {sermon.subtitle === PASCHA_WEEK_STRING && (
                  <HolyWeekSelector
                    sermonSubtitle={sermon.subtitle}
                    setSermonList={setSermonList}
                    selectedHolyWeekYear={selectedHolyWeekYear}
                    setSelectedHolyWeekYear={setSelectedHolyWeekYear}
                    selectedHolyWeekDay={selectedHolyWeekDay}
                    setSelectedHolyWeekDay={setSelectedHolyWeekDay}
                    holyWeekYearError={formErrors?.holyWeekYear}
                    setHolyWeekYearError={setHolyWeekYearError}
                    holyWeekDayError={formErrors?.holyWeekDay}
                    setHolyWeekDayError={setHolyWeekDayError}
                  />
                )}
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
            showOptionalityChip={false}
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
              {canEditExistingAudio ? (
                isExistingYouTubeSermon ? (
                  <YouTubeTrimmer
                    initialUrl={props.existingSermon?.youtubeUrl}
                    allowUrlEdit={false}
                    trimStart={sermon.sourceStartTime}
                    duration={sermon.trimDurationSeconds ?? 0}
                    setDuration={setTrimDuration}
                    setTrimStart={setTrimStartTime}
                    setAudioSource={setAudioSource}
                    audioSourceError={formErrors?.audioSource}
                    setAudioSourceError={setAudioSourceError}
                  />
                ) : props.existingSermonUrl?.status === 'success' ? (
                  <AudioTrimmerComponent
                    url={props.existingSermonUrl.url}
                    trimStart={sermon.sourceStartTime}
                    trimDuration={sermon.trimDurationSeconds}
                    setTrimStart={setTrimStartTime}
                    setTrimDuration={setTrimDuration}
                    clearAudioTrimmer={clearAudioTrimmer}
                    setHasTrimmed={setHasTrimmed}
                    showClearButton={false}
                  />
                ) : props.existingSermonUrl?.status === 'loading' ? (
                  <Stack alignItems="center" flexDirection="row" gap="1rem">
                    <CircularProgress size={24} />
                    <Typography variant="caption" sx={{ textAlign: 'center' }}>
                      Loading audio...
                    </Typography>
                  </Stack>
                ) : (
                  <Alert severity="info">{existingAudioEditMessage || 'Something went wrong loading the audio.'}</Alert>
                )
              ) : (
                <Alert severity="info">{existingAudioEditMessage || 'This sermon audio cannot be edited.'}</Alert>
              )}
              {audioSettingsChanged && requiresSoundCloudAudioPolicy(props.existingSermon) && (
                <FormControl sx={{ mt: 2 }}>
                  <FormLabel id="soundcloud-audio-policy-label">SoundCloud audio update</FormLabel>
                  <RadioGroup
                    aria-labelledby="soundcloud-audio-policy-label"
                    value={soundcloudPolicy}
                    onChange={(_event, value) => {
                      if (value === 'recreate_track' || value === 'keep_existing_audio') setSoundcloudPolicy(value);
                    }}
                  >
                    <FormControlLabel
                      value="recreate_track"
                      control={<Radio />}
                      label="Replace the SoundCloud track with the updated audio"
                    />
                    <FormControlLabel
                      value="keep_existing_audio"
                      control={<Radio />}
                      label="Keep the existing SoundCloud audio"
                    />
                  </RadioGroup>
                  <Alert severity="info">
                    {soundcloudPolicy === 'recreate_track'
                      ? 'SoundCloud requires a new track for changed audio. Saving creates a new track link. Engagement and comments do not transfer to the new track. The existing track remains available until replacement is confirmed.'
                      : 'SoundCloud will keep its current audio. The updated audio will be used in this app and other publication destinations.'}
                  </Alert>
                </FormControl>
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
                      const sermonToPersist =
                        props.existingSermon && !canReprocessExistingAudio
                          ? {
                              ...sermon,
                              sourceStartTime: props.existingSermon.sourceStartTime,
                              trimDurationSeconds: props.existingSermon.trimDurationSeconds,
                              youtubeUrl: props.existingSermon.youtubeUrl,
                            }
                          : sermon;
                      await editSermon(sermonToPersist, sermonList, {
                        originalSermon: props.existingSermon,
                        ...(audioSettingsChanged
                          ? {
                              processAudio: {
                                startTime: sermonToPersist.sourceStartTime,
                                duration: sermonToPersist.trimDurationSeconds ?? 0,
                                ...(requiresSoundCloudAudioPolicy(props.existingSermon) ? { soundcloudPolicy } : {}),
                              },
                            }
                          : {}),
                      });
                      // Mark as intentional navigation to bypass unsaved changes warning
                      markIntentionalNavigation();
                      props.setEditFormOpen?.(false);
                    } catch (error) {
                      setInvalidFormMessage(
                        error instanceof Error
                          ? error.message
                          : 'The update could not be confirmed. Your changes have been kept.'
                      );
                      if (!isSermonProcessingConflict(error)) {
                        console.error('Error editing sermon:', error);
                      }
                    } finally {
                      setIsEditing(false);
                    }
                  }}
                  disabled={!canEditExistingSermon || !existingSermonHasChanges}
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
                  audioBlob={audioSource.source.file}
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
                      duration={sermon.trimDurationSeconds ?? 0}
                      setTrimStart={setTrimStartTime}
                      setDuration={setTrimDuration}
                      setAudioSource={setAudioSource}
                      audioSourceError={formErrors?.audioSource}
                      setAudioSourceError={setAudioSourceError}
                    />
                  ) : (
                    <DropZone
                      selectAudioFile={selectAudioFile}
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
                  <Box
                    component="fieldset"
                    disabled={catalogBlocksNewAdmission(
                      Boolean(uploadReceipt),
                      subtitlesLoading || latestListLoading || Boolean(catalogErrors.subtitles || catalogErrors.latest)
                    )}
                    sx={{ border: 0, p: 0, m: 0 }}
                  >
                    <UploadButton
                      user={props.user}
                      sermon={sermon}
                      audioSource={audioSource}
                      trimStart={sermon.sourceStartTime}
                      sermonList={sermonList}
                      date={date}
                      validateForm={() =>
                        !catalogBlocksNewAdmission(
                          Boolean(uploadReceipt),
                          subtitlesLoading ||
                            latestListLoading ||
                            Boolean(catalogErrors.subtitles || catalogErrors.latest)
                        ) && validateForm()
                      }
                      setUploadProgress={setUploadProgress}
                      setInvalidFormMessage={setInvalidFormMessage}
                      setIsUploading={setIsUploading}
                      receipt={uploadReceipt}
                      onAdmission={(receipt) => {
                        setUploadReceipt(receipt);
                        if (receipt.sermonId) setUploadedSermon({ ...sermon, id: receipt.sermonId });
                      }}
                      onUploadSuccess={handleUploadSuccess}
                    />
                  </Box>
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
                  receipt={uploadReceipt}
                  sermon={uploadedSermon || undefined}
                  isNavigatingToSermon={isNavigatingToSermon}
                  onNavigateToSermon={navigateToSermon}
                  onDismiss={dismissUploadModal}
                  requesterUid={props.user.uid}
                  onRetrySource={retryRetainedSource}
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
