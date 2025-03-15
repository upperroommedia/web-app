import Typography from '@mui/material/Typography';
import Avatar, { AvatarProps } from '@mui/material/Avatar';
import Image from 'next/image';
import { User } from '../types/User';
import Skeleton from '@mui/material/Skeleton';

interface IUserAvatar extends AvatarProps {
  user?: User;
  loading?: boolean;
}
function stringToColor(string: string) {
  let hash = 0;
  let i;

  for (i = 0; i < string.length; i += 1) {
    hash = string.charCodeAt(i) + ((hash << 5) - hash);
  }

  let color = '#';

  for (i = 0; i < 3; i += 1) {
    const value = (hash >> (i * 8)) & 0xff;
    color += `00${value.toString(16)}`.slice(-2);
  }

  return color;
}

export default function UserAvatar({ user, children, sx, ...props }: IUserAvatar) {
  const displayName = user?.displayName || user?.email || '';
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('');
  const size = (sx as any)?.width || (sx as any)?.height || 40;
  const fontSize = Math.min(16, size * 0.4); // Scale font dynamically
  if (props.loading) {
    return (
      <Skeleton
        variant="circular"
        sx={{
          ...sx,
        }}
      />
    );
  }
  if (displayName) {
    return (
      <Avatar sx={{ ...sx, bgcolor: stringToColor(displayName), fontSize }} {...props}>
        {user?.photoURL ? (
          <Image src={user.photoURL} alt={`Image for ${displayName}`} fill></Image>
        ) : (
          <Typography
            sx={{
              fontSize: 'inherit', // Ensures it inherits the Avatar’s font size
              lineHeight: 1, // Prevents text from overflowing
            }}
          >
            {initials}
          </Typography>
        )}
        {children}
      </Avatar>
    );
  }
  return (
    <Avatar sx={{ ...sx, bgcolor: 'white' }} {...props}>
      <Image src={'/user.png'} alt={`Default User Image`} fill></Image>
      {children}
    </Avatar>
  );
}
