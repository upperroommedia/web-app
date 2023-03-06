import { sanitize } from 'dompurify';
import { ImageType } from '../types/Image';
import Image from 'next/image';
import Box from '@mui/material/Box';
import { BoxProps } from '@mui/system';

interface AvatarWithDefaultImageProps extends BoxProps {
  defaultImageURL: string;
  altName: string;
  width: number;
  height: number;
  image?: ImageType;
  borderRadius?: number;
}

export default function AvatarWithDefaultImage({
  image,
  altName,
  defaultImageURL,
  width,
  height,
  borderRadius = 0,
  ...props
}: AvatarWithDefaultImageProps) {
  const { sx, ...rest } = props;
  return (
    <Box
      sx={{
        borderRadius: `${borderRadius}px`,
        overflow: 'hidden',
        position: 'relative',
        width,
        height,
        backgroundColor: image?.averageColorHex ? image.averageColorHex : undefined,
        backgroundImage: image?.averageColorHex ? undefined : `url(${defaultImageURL})`,
        backgroundPosition: 'center center',
        backgroundSize: 'cover',
        ...sx,
      }}
      {...rest}
    >
      {image && <Image src={sanitize(image.downloadLink)} alt={`Image of ${altName}`} width={width} height={height} />}
    </Box>
  );
}
