import Typography from '@mui/material/Typography';
import Avatar, { AvatarProps } from '@mui/material/Avatar';
import Image from 'next/image';
import { User } from '../types/User';
import Skeleton from '@mui/material/Skeleton';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';

interface IUserAvatar extends AvatarProps {
  user?: User;
  loading?: boolean;
}

const BREAKPOINTS = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
type Breakpoint = (typeof BREAKPOINTS)[number];

// Hook to get the current MUI breakpoint
function useCurrentBreakpoint(): Breakpoint {
  const theme = useTheme();
  const isXl = useMediaQuery(theme.breakpoints.up('xl'));
  const isLg = useMediaQuery(theme.breakpoints.up('lg'));
  const isMd = useMediaQuery(theme.breakpoints.up('md'));
  const isSm = useMediaQuery(theme.breakpoints.up('sm'));

  if (isXl) return 'xl';
  if (isLg) return 'lg';
  if (isMd) return 'md';
  if (isSm) return 'sm';
  return 'xs';
}

// Resolves MUI responsive values like {xs: 20, sm: 40} to a single number
function resolveResponsiveValue(
  value: unknown,
  currentBreakpoint: Breakpoint,
  defaultValue: number = 40
): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const currentIndex = BREAKPOINTS.indexOf(currentBreakpoint);

    // Find the value for current breakpoint or the closest smaller one (MUI inheritance)
    for (let i = currentIndex; i >= 0; i--) {
      const bp = BREAKPOINTS[i];
      if (bp in obj) {
        const bpValue = obj[bp];
        if (typeof bpValue === 'number') return bpValue;
        if (typeof bpValue === 'string') {
          const parsed = parseFloat(bpValue);
          if (!isNaN(parsed)) return parsed;
        }
      }
    }
  }
  return defaultValue;
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

export default function UserAvatar({ user, children, sx, loading, ...props }: IUserAvatar) {
  const currentBreakpoint = useCurrentBreakpoint();
  const displayName = user?.displayName || user?.email || '';
  const initials = displayName
    .split(' ')
    .map((n) => n[0])
    .join('');
  const sxObj = sx as Record<string, unknown> | undefined;
  const size =
    resolveResponsiveValue(sxObj?.width, currentBreakpoint) ||
    resolveResponsiveValue(sxObj?.height, currentBreakpoint);
  const fontSize = Math.min(16, size * 0.4); // Scale font dynamically
  if (loading) {
    return (
      <Skeleton
        variant="circular"
        animation="wave"
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
          <Image src={user.photoURL} alt={`Image for ${displayName}`} fill sizes="40px"></Image>
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
      <Image src={'/user.png'} alt={`Default User Image`} fill sizes="40px"></Image>
      {children}
    </Avatar>
  );
}
