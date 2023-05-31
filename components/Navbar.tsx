/**
 * Navbar: located at the top of all pages
 */
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Toolbar from '@mui/material/Toolbar';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import Menu from '@mui/material/Menu';
import MenuIcon from '@mui/icons-material/Menu';
import Container from '@mui/material/Container';
import Avatar from '@mui/material/Avatar';
import Tooltip from '@mui/material/Tooltip';
import MenuItem from '@mui/material/MenuItem';
import Image from 'next/image';
import styles from 'styles/Navbar.module.css';
import NavMenuItem from './NavMenuItem';
import UserAvatar from './UserAvatar';
import { FunctionComponent, useState } from 'react';
import useAuth from '../context/user/UserContext';
import Link from 'next/link';
import useTheme from '@mui/system/useTheme';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useRouter } from 'next/router';

const Navbar: FunctionComponent = () => {
  const { user, logoutUser } = useAuth();
  const router = useRouter();
  const pages = ['Uploader', 'Admin'];
  const settings = user ? ['Profile', 'Logout'] : ['Login'];
  const [anchorElNav, setAnchorElNav] = useState<null | HTMLElement>(null);
  const [anchorElUser, setAnchorElUser] = useState<null | HTMLElement>(null);
  const theme = useTheme();
  const mdMatches = useMediaQuery(theme.breakpoints.up('md'));

  const handleOpenNavMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorElNav(event.currentTarget);
  };
  const handleOpenUserMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorElUser(event.currentTarget);
  };

  const handleCloseNavMenu = () => {
    setAnchorElNav(null);
  };

  const handleCloseUserMenu = () => {
    setAnchorElUser(null);
  };

  const MenuItemLink = ({ page, children }: { page: string; children: React.ReactNode }) => (
    <Link href={`/${page === 'Uploader' ? '' : page === 'Admin' ? 'admin/sermons' : page.toLowerCase()}`} passHref>
      {children}
    </Link>
  );

  return (
    <AppBar
      position="static"
      elevation={3}
      style={{
        backgroundColor: 'rgb(31 41 55)',
      }}
    >
      <Container maxWidth="xl">
        <Toolbar disableGutters>
          <Link
            href="/"
            style={{
              marginRight: '16px',
              display: mdMatches ? 'flex' : 'none',
              fontSize: '1.25rem',
              fontWeight: 700,
              letterSpacing: '.3rem',
              color: 'inherit',
              textDecoration: 'none',
            }}
          >
            Upper Room Media
          </Link>
          <Box sx={{ flexGrow: 1, display: { xs: 'flex', md: 'none' } }}>
            <IconButton
              size="large"
              aria-label="account of current user"
              aria-controls="menu-appbar"
              aria-haspopup="true"
              onClick={handleOpenNavMenu}
              color="inherit"
            >
              <MenuIcon />
            </IconButton>
            <Menu
              id="menu-appbar"
              anchorEl={anchorElNav}
              anchorOrigin={{
                vertical: 'bottom',
                horizontal: 'left',
              }}
              keepMounted
              transformOrigin={{
                vertical: 'top',
                horizontal: 'left',
              }}
              open={Boolean(anchorElNav)}
              onClose={handleCloseNavMenu}
              sx={{
                display: { xs: 'block', md: 'none' },
              }}
            >
              {pages.map((page) => (
                <MenuItemLink key={page} page={page}>
                  <MenuItem
                    onClick={() => {
                      handleCloseNavMenu();
                      // handlePageClicked(page);
                    }}
                  >
                    {page}
                  </MenuItem>
                </MenuItemLink>
              ))}
            </Menu>
          </Box>
          <Avatar variant="square" sx={{ bgcolor: 'transparent' }}>
            <Image src="/URM_icon.png" alt="Upper Room Media Logo" fill />
          </Avatar>{' '}
          <Link
            href="/"
            style={{
              marginRight: '16px',
              display: mdMatches ? 'none' : 'flex',
              flexGrow: 1,
              fontSize: '1.25rem',
              fontWeight: 700,
              letterSpacing: '.3rem',
              color: 'inherit',
              textDecoration: 'none',
            }}
          >
            URM
          </Link>
          <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'flex' } }}>
            {pages.map((page) => (
              <MenuItemLink key={page} page={page}>
                <NavMenuItem path={page}>
                  <Typography textAlign="center">{page}</Typography>
                </NavMenuItem>
              </MenuItemLink>
            ))}
          </Box>
          <Box sx={{ flexGrow: 0 }}>
            <Tooltip title="Open settings">
              <IconButton onClick={handleOpenUserMenu} sx={{ p: 0 }}>
                <UserAvatar user={user} />
              </IconButton>
            </Tooltip>
            <Menu
              sx={{ mt: '45px' }}
              id="menu-appbar"
              anchorEl={anchorElUser}
              anchorOrigin={{
                vertical: 'top',
                horizontal: 'right',
              }}
              keepMounted
              transformOrigin={{
                vertical: 'top',
                horizontal: 'right',
              }}
              open={Boolean(anchorElUser)}
              onClose={handleCloseUserMenu}
            >
              {settings.map((setting) => {
                if (setting === 'Logout') {
                  return (
                    <MenuItem
                      key={setting}
                      onClick={() => {
                        handleCloseUserMenu();
                        logoutUser();
                      }}
                      className={styles.menu_item}
                    >
                      <Typography textAlign="center">{setting}</Typography>
                    </MenuItem>
                  );
                } else {
                  return (
                    <MenuItemLink
                      key={setting}
                      page={setting === 'Login' ? `login?callbackUrl=${router.pathname}` : setting}
                    >
                      <MenuItem
                        onClick={() => {
                          handleCloseUserMenu();
                        }}
                        className={styles.menu_item}
                      >
                        <Typography textAlign="center">{setting}</Typography>
                      </MenuItem>
                    </MenuItemLink>
                  );
                }
              })}
            </Menu>
          </Box>
        </Toolbar>
      </Container>
    </AppBar>
  );
};

export default Navbar;
