'use client';
import { Disclosure } from '@headlessui/react';
import { Bars3Icon, BellIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Image from 'next/image';
import { useAuth } from '../auth/hooks';
import Link from 'next/link';
import { classNames } from '../utils/utils';
import NavBarMenu from './NavBarMenu';
import { usePathname } from 'next/navigation';

const isCurrent = (item: { name: string; href: string }) => {
  const pathname = usePathname();
  return pathname === item.href;
};

export default function Navbar() {
  const { tenant } = useAuth();
  const adminPages =
    tenant?.customClaims?.role === 'admin'
      ? [
          { name: 'Uploader', href: '/uploader' },
          { name: 'Admin', href: '/admin' },
        ]
      : [];
  const navigation = [
    { name: 'Home', href: '/' },
    { name: 'Sermons', href: '/sermons' },
    { name: 'About', href: '/about' },
    ...adminPages,
  ];
  return (
    <Disclosure as="nav" className="bg-gray-800">
      {({ open }) => (
        <>
          <div className="mx-auto max-w-7xl px-2 sm:px-6 lg:px-8">
            <div className="relative flex h-16 items-center justify-between">
              <div className="absolute inset-y-0 left-0 flex items-center sm:hidden">
                {/*  Mobile menu button */}
                <Disclosure.Button className="inline-flex items-center justify-center rounded-md p-2 text-gray-400 hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white">
                  <span className="sr-only">Open main menu</span>
                  {open ? (
                    <XMarkIcon className="block h-6 w-6" aria-hidden="true" />
                  ) : (
                    <Bars3Icon className="block h-6 w-6" aria-hidden="true" />
                  )}
                </Disclosure.Button>
              </div>
              <div className="flex flex-1 items-center justify-center sm:items-stretch sm:justify-start">
                <div className="flex flex-shrink-0 items-center">
                  <div className="block h-8 w-auto lg:hidden">
                    <Image src="/URM_icon.png" alt="Upper Room Media Logo" width={32} height={32} />
                  </div>
                  <div className="hidden h-8 w-auto lg:block">
                    <Image src="/URM_icon.png" alt="Upper Room Media Logo" width={32} height={32} />
                  </div>
                </div>
                <div className="hidden sm:ml-6 sm:block">
                  <div className="flex space-x-4">
                    {navigation.map((item) => (
                      <Link
                        key={item.name}
                        href={item.href}
                        className={classNames(
                          isCurrent(item)
                            ? 'bg-gray-900 text-white'
                            : 'text-gray-300 hover:bg-gray-700 hover:text-white',
                          'rounded-md px-3 py-2 text-sm font-medium'
                        )}
                        aria-current={isCurrent(item) ? 'page' : undefined}
                      >
                        {item.name}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
              <div className="absolute inset-y-0 right-0 flex items-center pr-2 sm:static sm:inset-auto sm:ml-6 sm:pr-0">
                <button
                  type="button"
                  className="rounded-full bg-gray-800 p-1 text-gray-400 hover:text-white focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-gray-800"
                >
                  <span className="sr-only">View notifications</span>
                  <BellIcon className="h-6 w-6" aria-hidden="true" />
                </button>

                {/* Profile dropdown */}
                <NavBarMenu />
              </div>
            </div>
          </div>

          <Disclosure.Panel className="sm:hidden">
            <div className="space-y-1 px-2 pb-3 pt-2">
              {navigation.map((item) => (
                <Disclosure.Button
                  key={item.name}
                  as="a"
                  href={item.href}
                  className={classNames(
                    isCurrent(item) ? 'bg-gray-900 text-white' : 'text-gray-300 hover:bg-gray-700 hover:text-white',
                    'block rounded-md px-3 py-2 text-base font-medium'
                  )}
                  aria-current={isCurrent(item) ? 'page' : undefined}
                >
                  {item.name}
                </Disclosure.Button>
              ))}
            </div>
          </Disclosure.Panel>
        </>
      )}
    </Disclosure>
  );
}

// 'use client';
// /**
//  * Navbar: located at the top of all pages
//  */
// import AppBar from '@mui/material/AppBar';
// import Box from '@mui/material/Box';
// import Toolbar from '@mui/material/Toolbar';
// import IconButton from '@mui/material/IconButton';
// import Typography from '@mui/material/Typography';
// import Menu from '@mui/material/Menu';
// import MenuIcon from '@mui/icons-material/Menu';
// import Container from '@mui/material/Container';
// import Avatar from '@mui/material/Avatar';
// import Tooltip from '@mui/material/Tooltip';
// import MenuItem from '@mui/material/MenuItem';
// import Image from 'next/image';
// import styles from 'styles/Navbar.module.css';
// import NavMenuItem from './NavMenuItem';
// import UserAvatar from './UserAvatar';
// import { useState } from 'react';
// import { useAuth } from '../auth/hooks';
// import Link from 'next/link';
// import useTheme from '@mui/system/useTheme';
// import useMediaQuery from '@mui/material/useMediaQuery';
// import { usePathname } from 'next/navigation';
// import auth from '../firebase/auth';

// function Navbar() {
//   const { tenant } = useAuth();
//   const pathname = usePathname();
//   const adminPages = tenant?.customClaims?.role === 'admin' ? ['Uploader', 'Admin'] : [];
//   const pages = ['Home', 'Sermons', 'About', ...adminPages];
//   const settings = tenant ? ['Profile', 'Logout'] : ['Login'];
//   const [anchorElNav, setAnchorElNav] = useState<null | HTMLElement>(null);
//   const [anchorElUser, setAnchorElUser] = useState<null | HTMLElement>(null);
//   const theme = useTheme();
//   const mdMatches = useMediaQuery(theme.breakpoints.up('md'));

//   const handleOpenNavMenu = (event: React.MouseEvent<HTMLElement>) => {
//     setAnchorElNav(event.currentTarget);
//   };
//   const handleOpenUserMenu = (event: React.MouseEvent<HTMLElement>) => {
//     setAnchorElUser(event.currentTarget);
//   };

//   const handleCloseNavMenu = () => {
//     setAnchorElNav(null);
//   };

//   const handleCloseUserMenu = () => {
//     setAnchorElUser(null);
//   };

//   const MenuItemLink = ({ page, children }: { page: string; children: React.ReactNode }) => (
//     <Link
//       style={{ textDecoration: 'none' }}
//       href={`/${page === 'Home' ? '' : page === 'Admin' ? 'admin/sermons' : page.toLowerCase()}`}
//       passHref
//     >
//       {children}
//     </Link>
//   );

//   return (
//     <AppBar
//       position="static"
//       elevation={3}
//       style={{
//         backgroundColor: 'rgb(31 41 55)',
//       }}
//     >
//       <Container maxWidth="xl">
//         <Toolbar disableGutters>
//           <Link
//             href="/"
//             style={{
//               marginRight: '16px',
//               display: mdMatches ? 'flex' : 'none',
//               fontSize: '1.25rem',
//               fontWeight: 700,
//               letterSpacing: '.3rem',
//               color: 'inherit',
//               textDecoration: 'none',
//             }}
//           >
//             Upper Room Media
//           </Link>
//           <Box sx={{ flexGrow: 1, display: { xs: 'flex', md: 'none' } }}>
//             <IconButton
//               size="large"
//               aria-label="account of current user"
//               aria-controls="menu-appbar"
//               aria-haspopup="true"
//               onClick={handleOpenNavMenu}
//               color="inherit"
//             >
//               <MenuIcon />
//             </IconButton>
//             <Menu
//               id="menu-appbar"
//               anchorEl={anchorElNav}
//               anchorOrigin={{
//                 vertical: 'bottom',
//                 horizontal: 'left',
//               }}
//               keepMounted
//               transformOrigin={{
//                 vertical: 'top',
//                 horizontal: 'left',
//               }}
//               open={Boolean(anchorElNav)}
//               onClose={handleCloseNavMenu}
//               sx={{
//                 display: { xs: 'block', md: 'none' },
//               }}
//             >
//               {pages.map((page) => (
//                 <MenuItemLink key={page} page={page}>
//                   <MenuItem
//                     onClick={() => {
//                       handleCloseNavMenu();
//                       // handlePageClicked(page);
//                     }}
//                   >
//                     {page}
//                   </MenuItem>
//                 </MenuItemLink>
//               ))}
//             </Menu>
//           </Box>
//           <Avatar variant="square" sx={{ bgcolor: 'transparent' }}>
//             <Image src="/URM_icon.png" alt="Upper Room Media Logo" width={40} height={40} />
//           </Avatar>{' '}
//           <Link
//             href="/"
//             style={{
//               marginRight: '16px',
//               display: mdMatches ? 'none' : 'flex',
//               flexGrow: 1,
//               fontSize: '1.25rem',
//               fontWeight: 700,
//               letterSpacing: '.3rem',
//               color: 'inherit',
//               textDecoration: 'none',
//             }}
//           >
//             URM
//           </Link>
//           <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'flex' } }}>
//             {pages.map((page) => (
//               <MenuItemLink key={page} page={page}>
//                 <NavMenuItem path={page}>
//                   <Typography textAlign="center">{page}</Typography>
//                 </NavMenuItem>
//               </MenuItemLink>
//             ))}
//           </Box>
//           <Box sx={{ flexGrow: 0 }}>
//             <Tooltip title="Open settings">
//               <IconButton onClick={handleOpenUserMenu} sx={{ p: 0 }}>
//                 <UserAvatar tenant={tenant} />
//               </IconButton>
//             </Tooltip>
//             <Menu
//               sx={{ mt: '45px' }}
//               id="menu-appbar"
//               anchorEl={anchorElUser}
//               anchorOrigin={{
//                 vertical: 'top',
//                 horizontal: 'right',
//               }}
//               keepMounted
//               transformOrigin={{
//                 vertical: 'top',
//                 horizontal: 'right',
//               }}
//               open={Boolean(anchorElUser)}
//               onClose={handleCloseUserMenu}
//             >
//               {settings.map((setting) => {
//                 if (setting === 'Logout') {
//                   return (
//                     <MenuItem
//                       key={setting}
//                       onClick={() => {
//                         handleCloseUserMenu();
//                         logoutUser();
//                       }}
//                       className={styles.menu_item}
//                     >
//                       <Typography textAlign="center">{setting}</Typography>
//                     </MenuItem>
//                   );
//                 } else {
//                   return (
//                     <MenuItemLink key={setting} page={setting === 'Login' ? `login?callbackUrl=${pathname}` : setting}>
//                       <MenuItem
//                         onClick={() => {
//                           handleCloseUserMenu();
//                         }}
//                         className={styles.menu_item}
//                       >
//                         <Typography textAlign="center">{setting}</Typography>
//                       </MenuItem>
//                     </MenuItemLink>
//                   );
//                 }
//               })}
//             </Menu>
//           </Box>
//         </Toolbar>
//       </Container>
//     </AppBar>
//   );
// }

// export default Navbar;
