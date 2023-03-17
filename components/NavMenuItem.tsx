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
          bgcolor: 'rgb(55,65,81)',
        },
        bgcolor: active ? 'rgb(17 24 39)' : 'rgb(31 41 55)',
        color: active ? 'rgb(209 213 219)' : 'rgb(156 163 175)',
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
