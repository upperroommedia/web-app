import firestore, {
  query,
  collection,
  getDocs,
  limit,
  updateDoc,
  doc,
  where,
  QueryDocumentSnapshot,
  DocumentData,
  orderBy,
  startAfter,
} from '../firebase/firestore';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import { ImageType } from '../types/Image';
import ImageList from '@mui/material/ImageList';
import ImageListItem from '@mui/material/ImageListItem';
import { ISpeaker } from '../types/Speaker';
import Button from '@mui/material/Button';
import InfiniteScroll from 'react-infinite-scroll-component';
import ImageUploader from './ImageUploader';
import { createFunction } from '../utils/createFunction';
import { SaveImageInputType } from '../functions/src/saveImage';

const ImageSelector = (props: {
  setSpeakers: Dispatch<SetStateAction<ISpeaker[]>>;
  selectedSpeaker: ISpeaker;
  selectedImageFromSpeakerDetails: ImageType;
  setImageSelectorPopup: Dispatch<SetStateAction<boolean>>;
  setSpeakerDetailsPopup: Dispatch<SetStateAction<boolean>>;
}) => {
  const [images, setImages] = useState<ImageType[]>([]);
  const [selectedImage, setSelectedImage] = useState<ImageType | undefined>(
    props.selectedImageFromSpeakerDetails?.id ===
      props.selectedSpeaker?.images.find((image) => image.type === props.selectedImageFromSpeakerDetails?.type)?.id
      ? props.selectedSpeaker?.images.find((image) => image.type === props.selectedImageFromSpeakerDetails?.type)
      : undefined
  );
  const [lastImage, setLastImage] = useState<QueryDocumentSnapshot<DocumentData>>();
  const [hasMore] = useState(lastImage === undefined);

  const fetchImages = async () => {
    const q = query(
      collection(firestore, 'images'),
      limit(25),
      where('type', '==', props.selectedImageFromSpeakerDetails.type),
      orderBy('dateAddedMillis', 'desc')
    );
    const querySnapshot = await getDocs(q);
    setLastImage(querySnapshot.docs[querySnapshot.docs.length - 1]);
    const res: ImageType[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data() as ImageType);
    });
    setImages(res);
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

  const setSpeakerImage = async () => {
    try {
      await updateDoc(doc(firestore, 'speakers', props.selectedSpeaker.id), {
        images: props.selectedSpeaker.images.find((image) => image.type === props.selectedImageFromSpeakerDetails?.type)
          ? props.selectedSpeaker.images.map((image) => {
              if (image.type === props.selectedImageFromSpeakerDetails?.type) {
                return selectedImage;
              }
              return image;
            })
          : [...props.selectedSpeaker.images, selectedImage],
      });
      props.setSpeakers((oldSpeakers) =>
        oldSpeakers.map((speaker) => {
          if (speaker.id === props.selectedSpeaker.id) {
            return {
              ...speaker,
              images: speaker.images.find((image) => image.type === props.selectedImageFromSpeakerDetails?.type)
                ? speaker.images.map((image) => {
                    if (image.type === props.selectedImageFromSpeakerDetails?.type) {
                      return selectedImage!;
                    }
                    return image;
                  })
                : [...speaker.images, selectedImage!],
            };
          }
          return speaker;
        })
      );
      props.setImageSelectorPopup(false);
      props.setSpeakerDetailsPopup(false);
    } catch (e) {
      alert(e);
    }
  };

  useEffect(() => {
    const g = async () => {
      await fetchImages();
    };
    g();
  }, []);

  const saveImage = (url: string, name: string) => {
    const saveImage = createFunction<SaveImageInputType, void>('saveimage');
    saveImage({ url, name });
  };

  return (
    <div>
      <InfiniteScroll
        dataLength={images.length + 1}
        next={async () => await fetchMoreImages()}
        hasMore={hasMore}
        loader={undefined}
        scrollableTarget="scrollableDiv"
        endMessage={
          <p style={{ textAlign: 'center' }}>
            <b>That{"'"}s all!</b>
          </p>
        }
      >
        <ImageList sx={{ width: 500, height: 450 }} cols={3} rowHeight={164} id="scrollableDiv">
          {images
            // .filter((image) => image.type === props.selectedImageFromSpeakerDetails.type)
            .map((image) => (
              <ImageListItem key={image.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${image.downloadLink}?fit=crop&auto=format`}
                  width="164px"
                  height="164px"
                  alt={image.id}
                  loading="lazy"
                  style={{
                    border: selectedImage?.id === image.id ? '4px solid blue' : 'none',
                    borderRadius: '5px',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSelectedImage(image);
                  }}
                />
              </ImageListItem>
            ))}
        </ImageList>
      </InfiniteScroll>
      <ImageUploader
        onFinish={async (imgSrc) =>
          saveImage(
            imgSrc,
            `${props.selectedSpeaker.name.replaceAll(' ', '-')}-${props.selectedImageFromSpeakerDetails.type}.jpeg`
          )
        }
      />
      <Button
        disabled={selectedImage === undefined || selectedImage.id === props.selectedImageFromSpeakerDetails.id}
        onClick={setSpeakerImage}
      >
        Set Speaker Image
      </Button>
    </div>
  );
};

export default ImageSelector;
