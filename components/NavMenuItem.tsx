// 'use client';
import { useRouter } from 'next/router';
import MenuItem, { MenuItemProps } from '@mui/material/MenuItem';

interface INavMenuItem extends MenuItemProps {
  path: string;
}

export default function NavMenuItem({ path, children, sx, ...props }: INavMenuItem) {
  const segment = useRouter().pathname;
  const active = (path === 'Home' && segment === '/') || `/${path.toLowerCase()}` === segment.toLocaleLowerCase();
  return (
    <MenuItem
      disableRipple
      sx={{
        '&:hover': {
          bgcolor: 'grey.700',
        },
        bgcolor: active ? 'grey.900' : 'grey.800',
        color: active ? 'grey.300' : 'grey.400',
        padding: '0.5rem',
        margin: '0.5rem',
        borderRadius: '0.375rem',
        fontWeight: '500',
        fontFamily: 'ui-sans-serif',
        ...sx,
      }}
      {...props}
    >
      {children}
    </MenuItem>
  );
}
