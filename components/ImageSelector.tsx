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
import { useEffect, useState } from 'react';
import { AspectRatio, ImageType } from '../types/Image';
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

const ImageSelector = (props: {
  selectedSpeaker?: ISpeaker;
  selectedImageFromSpeakerDetails: ImageType;
  newSelectedImage: ImageType | undefined;
  setNewSelectedImage: (image: ImageType) => void;
}) => {
  const [images, setImages] = useState<ImageType[]>([]);
  const [title, setTitle] = useState(
    `${props.selectedSpeaker?.name.replaceAll(' ', '-')}-${props.selectedImageFromSpeakerDetails.type}.jpeg` || ''
  );
  const [lastImage, setLastImage] = useState<QueryDocumentSnapshot<DocumentData>>();
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

  useEffect(() => {
    const g = async () => {
      await fetchImages();
    };
    g();
  }, []);

  const saveImage = async (croppedImageData: CroppedImageData, name: string) => {
    try {
      // TODO make this work
      console.log('HTETRHERHSDFHWEHSDF');
      const imageRef = ref(imageStorage, `speaker-images/${name}`);
      await uploadBytes(imageRef, croppedImageData.blob, {
        contentType: croppedImageData.contentType,
        customMetadata: { name, size: 'original', type: croppedImageData.type },
      });
      console.log('Done Uploading', name);
    } catch (e) {
      alert(e);
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
      <InfiniteScroll
        dataLength={images.length + 1}
        next={async () => await fetchMoreImages()}
        hasMore={lastImage !== undefined}
        loader={<InfinitScrollMessage message="Loading..." />}
        height="500px"
        // scrollableTarget="scrollableDiv"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', paddingTop: '4px' }}
        endMessage={<InfinitScrollMessage message="No More Images" />}
      >
        {/* <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', overflow: 'hidden' }} id="scrollableDiv"> */}
        {images
          // .filter((image) => image.type === props.selectedImageFromSpeakerDetails.type)
          .map((image) => (
            <div
              key={image.id}
              className={styles.imageContainer}
              style={{
                aspectRatio: AspectRatio[image.type],
                backgroundColor: image.averageColorHex || '#f3f1f1',
                boxShadow: props.newSelectedImage?.id === image.id ? ' 0 0 0 4px blue' : 'none',
              }}
            >
              <Image
                src={sanitize(image.downloadLink)}
                height="164px"
                alt={image.name}
                style={{
                  borderRadius: '5px',
                  cursor: 'pointer',
                }}
                layout="fill"
                objectFit="contain"
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
          ))}
        {/* </div> */}
      </InfiniteScroll>
      <ImageUploader
        onFinish={async (imgSrc) => saveImage(imgSrc, title)}
        type={props.selectedImageFromSpeakerDetails.type}
        title={title}
        setTitle={setTitle}
      />
    </div>
  );
};

export default ImageSelector;
