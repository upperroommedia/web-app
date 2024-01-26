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
  onSnapshot,
} from '../firebase/firestore';
import { useEffect, useState } from 'react';
import { AlgoliaImage, AspectRatio, ImageType } from '../types/Image';
import Image from 'next/image';
// import ImageList from '@mui/material/ImageList';
// import ImageListItem from '@mui/material/ImageListItem';
import { ISpeaker } from '../types/Speaker';
import InfiniteScroll from 'react-infinite-scroll-component';
import ImageUploader from './ImageUploader';
import { imageStorage, ref, uploadBytes } from '../firebase/storage';
import { CroppedImageData } from '../utils/cropImage';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { sanitize } from 'dompurify';
import styles from '../styles/ImageSelector.module.css';
import CircularProgress from '@mui/material/CircularProgress';
import { createInMemoryCache } from '@algolia/cache-in-memory';
import algoliasearch from 'algoliasearch';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';

const client =
  process.env.NEXT_PUBLIC_ALGOLIA_APP_ID && process.env.NEXT_PUBLIC_ALGOLIA_API_KEY
    ? algoliasearch(process.env.NEXT_PUBLIC_ALGOLIA_APP_ID, process.env.NEXT_PUBLIC_ALGOLIA_API_KEY, {
        responsesCache: createInMemoryCache(),
        requestsCache: createInMemoryCache({ serializable: false }),
      })
    : undefined;
const imagesIndex = client?.initIndex('images');

const ImageSelector = (props: {
  selectedSpeaker?: ISpeaker;
  selectedImageFromSpeakerDetails: ImageType;
  newSelectedImage: ImageType | undefined;
  setNewSelectedImage: (image: ImageType) => void;
}) => {
  const [images, setImages] = useState<ImageType[]>([]);
  const [imageSearchResults, setImageSearchResults] = useState<AlgoliaImage[]>();
  const [imageSearchQuery, setImageQuery] = useState<string>('');

  const [title, setTitle] = useState(
    (props.selectedSpeaker && `${props.selectedSpeaker?.name.replaceAll(' ', '-')}`) || ''
  );
  const [lastImage, setLastImage] = useState<QueryDocumentSnapshot<DocumentData>>();
  const [imageUploading, setImageUploading] = useState<boolean>(false);

  const fetchMoreImages = async () => {
    const q = query(
      collection(firestore, 'images'),
      limit(25),
      where('type', '==', props.selectedImageFromSpeakerDetails.type),
      orderBy('dateAddedMillis', 'desc'),
      startAfter(lastImage)
    );
    const querySnapshot = await getDocs(q);
    setLastImage(querySnapshot.docs[querySnapshot.docs.length - 1]);
    querySnapshot.forEach((doc) => {
      setImages((oldImages) => [...oldImages, doc.data() as ImageType]);
    });
  };

  const searchImages = async (query: string, hitsPerPage: number, page: number) => {
    const images: AlgoliaImage[] = [];
    if (imagesIndex) {
      const response = await imagesIndex.search<AlgoliaImage>(query, {
        hitsPerPage,
        page,
        filters: `type:${props.selectedImageFromSpeakerDetails.type}`,
      });
      response.hits.forEach((hit) => {
        images.push(hit);
      });
    }
    return images;
  };

  useEffect(() => {
    const fetchImages = async () => {
      const q = query(
        collection(firestore, 'images'),
        limit(25),
        where('type', '==', props.selectedImageFromSpeakerDetails.type),
        orderBy('dateAddedMillis', 'desc')
      );
      const querySnapshot = await getDocs(q);
      setLastImage(querySnapshot.docs[querySnapshot.docs.length - 1]);
      setImages(querySnapshot.docs.map((doc) => doc.data() as ImageType));
    };

    const g = async () => {
      await fetchImages();
    };
    g();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveImage = async (croppedImageData: CroppedImageData, name: string) => {
    try {
      setImageUploading(true);
      const q = query(collection(firestore, 'images'), where('name', '==', name));
      const querySnapshot = await getDocs(q);
      if (querySnapshot.empty) {
        // TODO make this work
        const imageRef = ref(imageStorage, `speaker-images/${name}`);
        await uploadBytes(imageRef, croppedImageData.blob, {
          contentType: croppedImageData.contentType,
          customMetadata: { name, size: 'original', type: croppedImageData.type },
        });

        const unsubscribe = onSnapshot(q, (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              const imageAddedToFirestore = change.doc.data() as ImageType;
              setImages((oldImages) => [imageAddedToFirestore, ...oldImages]);
              props.setNewSelectedImage(imageAddedToFirestore);
              setImageUploading(false);
              unsubscribe();
            }
          });
        });
      } else {
        alert('An image with this name already exists, please use a different name');
        setImageUploading(false);
      }
    } catch (e) {
      alert(e);
      setImageUploading(false);
    }
  };

  const InfinitScrollMessage = ({ message }: { message: string }) => {
    return (
      <p style={{ flexBasis: '100%', textAlign: 'center' }}>
        <b>{message}</b>
      </p>
    );
  };

  return (
    <div>
      {imageUploading ? (
        <CircularProgress />
      ) : (
        <>
          <TextField
            value={imageSearchQuery}
            onChange={async (e) => {
              setImageQuery(e.target.value);
              if (e.target.value !== null || e.target.value !== '') {
                setImageSearchResults(await searchImages(e.target.value, 100, 0));
              }
            }}
            fullWidth
            placeholder="Search for an image"
            sx={{ paddingBottom: '5px' }}
          />
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
                delete image._highlightResult;
                delete image?.nbHits;
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
                        backgroundColor: image.averageColorHex || '#f3f1f1',
                        boxShadow: props.newSelectedImage?.id === image.id ? ' 0 0 0 4px blue' : 'none',
                      }}
                    >
                      <Image
                        src={sanitize(image.downloadLink)}
                        fill
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
                      src={sanitize(image.downloadLink)}
                      fill
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
          <ImageUploader
            onFinish={async (imgSrc, name) => saveImage(imgSrc, name)}
            type={props.selectedImageFromSpeakerDetails.type}
            title={title}
            setTitle={setTitle}
          />
        </>
      )}
    </div>
  );
};

export default ImageSelector;
