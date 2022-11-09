import { useState, useRef } from 'react';

import ReactCrop, { centerCrop, makeAspectCrop, Crop, PixelCrop } from 'react-image-crop';

import 'react-image-crop/dist/ReactCrop.css';

const TO_RADIANS = Math.PI / 180;

const centerAspectCrop = (mediaWidth: number, mediaHeight: number, aspect: number) => {
  return centerCrop(
    makeAspectCrop(
      {
        unit: '%',
        width: 90,
      },
      aspect,
      mediaWidth,
      mediaHeight
    ),
    mediaWidth,
    mediaHeight
  );
};

const ImageUploader = () => {
  const [imgSrc, setImgSrc] = useState('');
  const imgRef = useRef<HTMLImageElement>(null);
  const [crop, setCrop] = useState<Crop>();
  const [scale, setScale] = useState(1);
  const [rotate, setRotate] = useState(0);
  const [url, setUrl] = useState<string>();

  function onSelectFile(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      setCrop(undefined); // Makes crop preview update between images.
      const reader = new FileReader();
      reader.addEventListener('load', () => setImgSrc(reader.result?.toString() || ''));
      reader.readAsDataURL(e.target.files[0]);
    }
  }

  function onImageLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    setCrop(centerAspectCrop(width, height, 1));
  }

  function getCroppedImage(crop: PixelCrop) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const image = imgRef.current;
    if (ctx && image) {
      const scaleX = image.naturalWidth / image.width;
      const scaleY = image.naturalHeight / image.height;
      const pixelRatio = window.devicePixelRatio;
      canvas.width = Math.floor(crop.width * scaleX * pixelRatio);
      canvas.height = Math.floor(crop.height * scaleY * pixelRatio);
      ctx.scale(pixelRatio, pixelRatio);
      ctx.imageSmoothingQuality = 'high';
      const cropX = crop.x * scaleX;
      const cropY = crop.y * scaleY;
      const rotateRads = rotate * TO_RADIANS;
      const centerX = image.naturalWidth / 2;
      const centerY = image.naturalHeight / 2;
      ctx.save();
      ctx.translate(-cropX, -cropY);
      ctx.translate(centerX, centerY);
      ctx.rotate(rotateRads);
      ctx.scale(scale, scale);
      ctx.translate(-centerX, -centerY);
      ctx.drawImage(
        image,
        0,
        0,
        image.naturalWidth,
        image.naturalHeight,
        0,
        0,
        image.naturalWidth,
        image.naturalHeight
      );

      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Canvas is empty'));
            return;
          }
          const croppedImageUrl = window.URL.createObjectURL(blob);
          setUrl(croppedImageUrl);
          resolve(croppedImageUrl);
        }, 'image/jpeg');
      });
    }
  }

  return (
    <div className="App">
      <div className="Crop-Controls">
        <input type="file" accept="image/*" onChange={onSelectFile} />
        <div>
          <label>Scale: </label>
          <input
            type="range"
            value={scale}
            min=".5"
            max="5"
            step=".1"
            disabled={!imgSrc}
            onChange={(e) => setScale(Number(e.target.value))}
          />
          <span>{scale}</span>
        </div>
        <div>
          <label>Rotate: </label>
          <input
            type="range"
            value={rotate}
            min="-180"
            max="180"
            step="30"
            disabled={!imgSrc}
            onChange={(e) => setRotate(Math.min(180, Math.max(-180, Number(e.target.value))))}
          />
          <span>{rotate}°</span>
        </div>
      </div>
      {!!imgSrc && (
        <ReactCrop
          crop={crop}
          onChange={(_, percentCrop) => setCrop(percentCrop)}
          aspect={1}
          onComplete={(crop) => getCroppedImage(crop)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            alt="Crop me"
            src={imgSrc}
            style={{ transform: `scale(${scale}) rotate(${rotate}deg)`, maxWidth: '300px', maxHeight: '300px' }}
            onLoad={onImageLoad}
          />
        </ReactCrop>
      )}
      <a href={url} download>
        download
      </a>
    </div>
  );
};

export default ImageUploader;
