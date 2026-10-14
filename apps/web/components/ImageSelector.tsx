import firestore, {
  query,
  collection,
  getDocs,
  limit,
  where,
  QueryDocumentSnapshot,
  DocumentData,
  orderBy,
  startAfter,
} from '../firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import { AlgoliaImage, AspectRatio, ImageType } from '../types/Image';
import Image from 'next/image';
// import ImageList from '@mui/material/ImageList';
// import ImageListItem from '@mui/material/ImageListItem';
import { ISpeaker } from '../types/Speaker';
import InfiniteScroll from 'react-infinite-scroll-component';
import ImageUploader from './ImageUploader';
import { CroppedImageData } from '../utils/cropImage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';

import styles from '../styles/ImageSelector.module.css';
import CircularProgress from '@mui/material/CircularProgress';
import { SearchResponse } from 'algoliasearch';
import { useAlgoliaSearch } from '../context/search/AlgoliaSearchContext';
import SearchAttribution from './algoliaComponents/SearchAttribution';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import InputAdornment from '@mui/material/InputAdornment';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { ingestDurableImage } from '../utils/durableImages';
import { useDurableJob } from '../hooks/useDurableJobs';
import JobStatusPanel from './jobs/JobStatusPanel';
import { doc, getDoc } from '../firebase/firestore';
import { reportHandledError } from '../utils/reportHandledError';

const InfinitScrollMessage = ({ message }: { message: string }) => (
  <p style={{ flexBasis: '100%', textAlign: 'center' }}>
    <b>{message}</b>
  </p>
);

const ImageSelector = (props: {
  selectedSpeaker?: ISpeaker;
  selectedImageFromSpeakerDetails: ImageType;
  newSelectedImage: ImageType | undefined;
  setNewSelectedImage: (image: ImageType) => void;
  confirmSelecedImage: (image: ImageType) => void;
  setPopupTitle: (title: string) => void;
}) => {
  const { sharedSearchClient: client } = useAlgoliaSearch();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchRevision = useRef(0);
  const pageInFlight = useRef(false);
  const [images, setImages] = useState<ImageType[]>([]);
  const [imageSearchResults, setImageSearchResults] = useState<AlgoliaImage[]>();
  const [imageSearchQuery, setImageQuery] = useState<string>('');
  useEffect(() => {
    searchRevision.current++;
    setImageSearchResults(undefined);
    setImageQuery('');
  }, [client]);

  const [title, setTitle] = useState(
    (props.selectedSpeaker && `${props.selectedSpeaker?.name.replaceAll(' ', '-')}`) || ''
  );
  const [lastImage, setLastImage] = useState<QueryDocumentSnapshot<DocumentData>>();
  const [imageUploading, setImageUploading] = useState<boolean>(false);
  const [imageJobId, setImageJobId] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();
  const { job: imageJob, stale: imageStale } = useDurableJob(imageJobId);
  const handledImageJob = useRef<string | undefined>(undefined);

  const imageBrowseRevision = useRef(0);
  const [imageBrowseError, setImageBrowseError] = useState<string>();
  const fetchImages = async (reset = false) => {
    if (!reset && (!lastImage || pageInFlight.current)) return;
    const revision = reset ? ++imageBrowseRevision.current : imageBrowseRevision.current;
    if (reset) {
      setImages([]);
      setLastImage(undefined);
    }
    pageInFlight.current = true;
    setImageBrowseError(undefined);
    try {
      const q = query(
        collection(firestore, 'images'),
        limit(25),
        where('type', '==', props.selectedImageFromSpeakerDetails.type),
        orderBy('dateAddedMillis', 'desc'),
        ...(reset ? [] : [startAfter(lastImage!)])
      );
      const snapshot = await getDocs(q);
      if (revision !== imageBrowseRevision.current) return;
      setLastImage(snapshot.size === 25 ? snapshot.docs.at(-1) : undefined);
      const nextImages = snapshot.docs.map((doc) => doc.data() as ImageType);
      setImages((previous) =>
        Array.from(new Map([...(reset ? [] : previous), ...nextImages].map((image) => [image.id, image])).values())
      );
    } catch {
      if (revision === imageBrowseRevision.current) setImageBrowseError('Unable to load images. Please try again.');
    } finally {
      if (revision === imageBrowseRevision.current) pageInFlight.current = false;
    }
  };
  const fetchMoreImages = () => fetchImages();

  const searchImages = async (query: string, hitsPerPage: number, page: number) => {
    const images: AlgoliaImage[] = [];
    if (client) {
      try {
        const response: SearchResponse<AlgoliaImage> = await client.searchSingleIndex({
          indexName: 'images',
          searchParams: {
            query,
            hitsPerPage,
            page,
            filters: `type:${props.selectedImageFromSpeakerDetails.type}`,
          },
        });
        response.hits.forEach((hit) => {
          images.push(hit);
        });
      } catch (error) {
        console.error('Search error:', error);
      }
    }
    return images;
  };

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return fetchImages(true);
    });
    return () => {
      active = false;
      // This generation invalidates pending reads, rather than referencing a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      imageBrowseRevision.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedImageFromSpeakerDetails.type]);

  useEffect(() => {
    const focusTimer = window.setTimeout(() => {
      searchInputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [props.selectedImageFromSpeakerDetails.id, props.selectedImageFromSpeakerDetails.type]);

  const saveImage = async (croppedImageData: CroppedImageData, name: string) => {
    setImageUploading(true);
    setUploadError(undefined);
    props.setPopupTitle(`Sending image ${name}`);
    try {
      const receipt = await ingestDurableImage(croppedImageData, name);
      setImageJobId(receipt.jobId);
      props.setPopupTitle('Image processing');
    } catch (error) {
      setUploadError(
        error instanceof Error ? error.message : 'Unable to confirm the image request. Your source has been kept.'
      );
      reportHandledError(error, { area: 'image-selector', action: 'save-image', extras: { name } });
      throw error;
    } finally {
      setImageUploading(false);
    }
  };

  useEffect(() => {
    if (imageJob?.state !== 'succeeded' || handledImageJob.current === imageJob.jobId) return;
    const imageId = imageJob.result?.imageId;
    if (typeof imageId !== 'string') return;
    let cancelled = false;
    getDoc(doc(firestore, 'images', imageId))
      .then((snapshot) => {
        if (cancelled || !snapshot.exists()) return;
        const image = { ...snapshot.data(), id: snapshot.id } as ImageType;
        handledImageJob.current = imageJob.jobId;
        setImages((previous) => [image, ...previous.filter((item) => item.id !== image.id)]);
        props.setNewSelectedImage(image);
        props.confirmSelecedImage(image);
      })
      .catch(() => {
        if (!cancelled)
          setUploadError(
            'The image finished processing, but its details could not be refreshed. Find it in the image library or Activity.'
          );
      });
    return () => {
      cancelled = true;
    };
  }, [imageJob, props]);

  return (
    <div>
      {uploadError && <Alert severity="error">{uploadError}</Alert>}
      {imageBrowseError && (
        <Alert severity="error" action={<Button onClick={() => void fetchImages(!lastImage)}>Retry</Button>}>
          {imageBrowseError}
        </Alert>
      )}
      {imageJob && <JobStatusPanel job={imageJob} stale={imageStale} compact />}
      {imageUploading ? (
        <CircularProgress />
      ) : (
        <>
          <TextField
            disabled={!client}
            helperText={!client ? 'Search is unavailable. Browse images below.' : undefined}
            autoFocus
            inputRef={searchInputRef}
            value={imageSearchQuery}
            onChange={async (e) => {
              setImageQuery(e.target.value);
              const revision = ++searchRevision.current;
              if (e.target.value.trim() === '') {
                setImageSearchResults(undefined);
                return;
              }
              const results = await searchImages(e.target.value, 100, 0);
              if (revision === searchRevision.current) setImageSearchResults(results);
            }}
            fullWidth
            placeholder="Search for an image"
            sx={{ paddingBottom: '5px' }}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <ImageUploader
                    onFinish={async (imgSrc, name) => saveImage(imgSrc, name)}
                    type={props.selectedImageFromSpeakerDetails.type}
                    title={title}
                    setTitle={setTitle}
                  />
                </InputAdornment>
              ),
            }}
          />
          {client && <SearchAttribution />}
          {imageSearchQuery !== '' && imageSearchResults ? (
            <InfiniteScroll
              next={() => {}}
              hasMore={false}
              loader={undefined}
              dataLength={imageSearchResults.length}
              height="500px"
              style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', paddingTop: '4px' }}
            >
              {imageSearchResults.map((image) => {
                return (
                  <Tooltip
                    key={image.id}
                    title={image.name.split('-').slice(0, -1).join(' ')}
                    placement="bottom"
                    PopperProps={{
                      sx: {
                        '& .MuiTooltip-tooltip': {
                          marginTop: '-10px !important',
                          bgcolor: 'grey !important',
                          opacity: '1.0 !important',
                        },
                      },
                    }}
                  >
                    <div
                      className={styles.imageContainer}
                      style={{
                        height: '164px',
                        aspectRatio: AspectRatio[image.type],
                        backgroundColor: image.averageColorHex || 'var(--placeholder-bg, #f1f5f9)',
                        boxShadow:
                          props.newSelectedImage?.id === image.id ? '0 0 0 4px var(--accent-primary, #f97316)' : 'none',
                      }}
                    >
                      <Image
                        src={image.downloadLink}
                        fill
                        sizes="164px"
                        alt={image.name}
                        style={{
                          borderRadius: '5px',
                          cursor: 'pointer',
                          objectFit: 'contain',
                        }}
                        onClick={() => {
                          props.setNewSelectedImage(image);
                        }}
                      />
                      {props.newSelectedImage?.id === image.id && (
                        <CheckCircleIcon
                          color="primary"
                          style={{
                            position: 'absolute',
                            backgroundColor: 'white',
                            borderRadius: '50%',
                            zIndex: 2,
                            top: '10px',
                            right: '10px',
                          }}
                        ></CheckCircleIcon>
                      )}
                    </div>
                  </Tooltip>
                );
              })}
            </InfiniteScroll>
          ) : (
            <InfiniteScroll
              dataLength={images.length}
              next={async () => await fetchMoreImages()}
              hasMore={lastImage !== undefined}
              loader={<InfinitScrollMessage message="Loading..." />}
              height="500px"
              style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', paddingTop: '4px' }}
              endMessage={<InfinitScrollMessage message="No More Images" />}
            >
              {images.map((image) => (
                <Tooltip
                  key={image.id}
                  title={image.name.split('-').slice(0, -1).join(' ')}
                  placement="bottom"
                  PopperProps={{
                    sx: {
                      '& .MuiTooltip-tooltip': {
                        marginTop: '-10px !important',
                        bgcolor: 'grey !important',
                        opacity: '1.0 !important',
                      },
                    },
                  }}
                >
                  <div
                    key={image.id}
                    className={styles.imageContainer}
                    style={{
                      height: '164px',
                      aspectRatio: AspectRatio[image.type],
                      backgroundColor: image.averageColorHex || '#f3f1f1',
                      boxShadow: props.newSelectedImage?.id === image.id ? ' 0 0 0 4px blue' : 'none',
                    }}
                  >
                    <Image
                      src={image.downloadLink}
                      fill
                      sizes="164px"
                      alt={image.name}
                      style={{
                        borderRadius: '5px',
                        cursor: 'pointer',
                        objectFit: 'contain',
                      }}
                      onClick={() => {
                        props.setNewSelectedImage(image);
                      }}
                    />
                    {props.newSelectedImage?.id === image.id && (
                      <CheckCircleIcon
                        color="primary"
                        style={{
                          position: 'absolute',
                          backgroundColor: 'white',
                          borderRadius: '50%',
                          zIndex: 2,
                          top: '10px',
                          right: '10px',
                        }}
                      ></CheckCircleIcon>
                    )}
                  </div>
                </Tooltip>
              ))}
            </InfiniteScroll>
          )}
        </>
      )}
    </div>
  );
};

export default ImageSelector;
