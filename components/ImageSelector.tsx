import firestore, { query, collection, getDocs, limit, updateDoc, doc } from '../firebase/firestore';
import { Dispatch, SetStateAction, useEffect, useState } from 'react';
import { ImageType } from '../types/Image';
import ImageList from '@mui/material/ImageList';
import ImageListItem from '@mui/material/ImageListItem';
import { ISpeaker } from '../types/Speaker';
import Button from '@mui/material/Button';

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

  const fetchImages = async () => {
    const q = query(collection(firestore, 'images'), limit(25));
    const querySnapshot = await getDocs(q);
    const res: ImageType[] = [];
    querySnapshot.forEach((doc) => {
      res.push(doc.data() as ImageType);
    });
    return res;
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
      setImages(await fetchImages());
    };
    g();
  }, []);

  return (
    <div>
      <ImageList sx={{ width: 500, height: 450 }} cols={3} rowHeight={164}>
        {images
          .filter((image) => image.type === props.selectedImageFromSpeakerDetails?.type)
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
