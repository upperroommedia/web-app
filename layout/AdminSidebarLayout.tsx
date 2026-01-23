/**
 * AdminSidebarLayout - Modern sidebar navigation for admin pages
 * - Desktop: Fixed 260px sidebar on the left
 * - Mobile: Hamburger menu with slide-out drawer
 * - Role-based navigation (Publishers vs Admins)
 * - Light/Dark mode toggle
 */
import { useState, ReactNode } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Image from 'next/image';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Avatar from '@mui/material/Avatar';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme as useMuiTheme, alpha } from '@mui/material/styles';
import Tooltip from '@mui/material/Tooltip';
import { useTheme } from 'next-themes';

// Icons
import MenuIcon from '@mui/icons-material/Menu';
import MicIcon from '@mui/icons-material/Mic';
import PeopleIcon from '@mui/icons-material/People';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import CollectionsIcon from '@mui/icons-material/Collections';
import LogoutIcon from '@mui/icons-material/Logout';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';

import useAuth from '../context/user/UserContext';
import UserAvatar from '../components/UserAvatar';

const DRAWER_WIDTH = 260;

interface NavItem {
  label: string;
  path: string;
  icon: ReactNode;
}

// Navigation items for publishers/uploaders
const publisherNavItems: NavItem[] = [
  { label: 'Sermons', path: '/admin/sermons', icon: <MicIcon /> },
  { label: 'Series', path: '/admin/series', icon: <CollectionsIcon /> },
];

// Additional navigation items for admins only
const adminOnlyNavItems: NavItem[] = [
  { label: 'Users', path: '/admin/users', icon: <PeopleIcon /> },
  { label: 'Speakers', path: '/admin/speakers', icon: <RecordVoiceOverIcon /> },
  { label: 'Lists', path: '/admin/lists', icon: <PlaylistPlayIcon /> },
  { label: 'Topics', path: '/admin/topics', icon: <LocalOfferIcon /> },
];

interface AdminSidebarLayoutProps {
  children: ReactNode;
}

const AdminSidebarLayout = ({ children }: AdminSidebarLayoutProps) => {
  const muiTheme = useMuiTheme();
  const { theme: currentTheme, setTheme } = useTheme();
  const router = useRouter();
  const { user, logoutUser } = useAuth();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down('lg'));
  const [mobileOpen, setMobileOpen] = useState(false);

  const isAdmin = user?.isAdmin() ?? false;

  const handleDrawerToggle = () => {
    setMobileOpen(!mobileOpen);
  };

  const toggleTheme = () => {
    setTheme(currentTheme === 'dark' ? 'light' : 'dark');
  };

  const isActivePath = (path: string) => {
    // Upload page is special - it's the homepage (/)
    if (path === '/') {
      return router.pathname === '/';
    }
    if (path === '/admin/sermons') {
      return router.pathname === '/admin/sermons' || router.pathname === '/admin';
    }
    return router.pathname.startsWith(path);
  };

  const renderNavItem = (item: NavItem) => (
    <ListItem key={item.path} disablePadding>
      <Link href={item.path} passHref style={{ width: '100%', textDecoration: 'none' }}>
        <ListItemButton
          selected={isActivePath(item.path)}
          onClick={() => isMobile && setMobileOpen(false)}
          sx={{
            '&.Mui-selected': {
              '& .MuiListItemIcon-root': {
                color: 'primary.main',
              },
              '& .MuiListItemText-primary': {
                color: 'text.primary',
                fontWeight: 600,
              },
            },
          }}
        >
          <ListItemIcon>{item.icon}</ListItemIcon>
          <ListItemText
            primary={item.label}
            primaryTypographyProps={{
              fontSize: '0.9rem',
              fontWeight: 500,
            }}
          />
        </ListItemButton>
      </Link>
    </ListItem>
  );

  const drawerContent = (
    <Box
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.paper',
      }}
    >
      {/* Logo Section */}
      <Box
        sx={{
          p: 2.5,
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
        }}
      >
        <Avatar
          variant="square"
          sx={{
            width: 40,
            height: 40,
            bgcolor: 'transparent',
            position: 'relative',
          }}
        >
          <Image src="/URM_icon.png" alt="Upper Room Media Logo" fill sizes="40px" />
        </Avatar>
        <Box>
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
              fontSize: '1rem',
              letterSpacing: '-0.01em',
              color: 'text.primary',
              lineHeight: 1.2,
            }}
          >
            Upper Room
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: 'primary.main',
              fontWeight: 500,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              fontSize: '0.65rem',
            }}
          >
            Uploader
          </Typography>
        </Box>
      </Box>

      <Divider sx={{ mx: 2 }} />

      {/* Upload Sermon - Primary Action */}
      <Box sx={{ px: 1, pt: 2 }}>
        <Link href="/" passHref style={{ width: '100%', textDecoration: 'none' }}>
          <ListItemButton
            selected={isActivePath('/')}
            onClick={() => isMobile && setMobileOpen(false)}
            sx={{
              background: isActivePath('/')
                ? `linear-gradient(135deg, ${alpha(muiTheme.palette.primary.main, 0.2)} 0%, ${alpha(muiTheme.palette.primary.light, 0.15)} 100%)`
                : `linear-gradient(135deg, ${alpha(muiTheme.palette.primary.main, 0.1)} 0%, ${alpha(muiTheme.palette.primary.light, 0.05)} 100%)`,
              border: '1px solid',
              borderColor: isActivePath('/') ? 'primary.main' : alpha(muiTheme.palette.primary.main, 0.2),
              borderRadius: 2,
              mx: 1,
              '&:hover': {
                background: `linear-gradient(135deg, ${alpha(muiTheme.palette.primary.main, 0.2)} 0%, ${alpha(muiTheme.palette.primary.light, 0.15)} 100%)`,
                borderColor: 'primary.main',
              },
              '&.Mui-selected': {
                '& .MuiListItemIcon-root': {
                  color: 'primary.main',
                },
                '& .MuiListItemText-primary': {
                  color: 'primary.main',
                  fontWeight: 600,
                },
              },
            }}
          >
            <ListItemIcon sx={{ color: isActivePath('/') ? 'primary.main' : 'primary.light' }}>
              <CloudUploadIcon />
            </ListItemIcon>
            <ListItemText
              primary="Upload Sermon"
              primaryTypographyProps={{
                fontSize: '0.9rem',
                fontWeight: 600,
                color: isActivePath('/') ? 'primary.main' : 'text.primary',
              }}
            />
          </ListItemButton>
        </Link>
      </Box>

      <Divider sx={{ mx: 2, my: 2 }} />

      {/* Content Management Section */}
      <Typography
        variant="overline"
        sx={{
          px: 3,
          py: 1,
          color: 'text.secondary',
          fontSize: '0.65rem',
          fontWeight: 600,
          letterSpacing: '0.1em',
        }}
      >
        Content
      </Typography>

      {/* Publisher Nav Items (Sermons, Series) */}
      <List sx={{ py: 0, px: 1 }}>
        {publisherNavItems.map(renderNavItem)}
      </List>

      {/* Admin Only Section */}
      {isAdmin && (
        <>
          <Divider sx={{ mx: 2, my: 2 }} />
          
          <Typography
            variant="overline"
            sx={{
              px: 3,
              py: 1,
              color: 'text.secondary',
              fontSize: '0.65rem',
              fontWeight: 600,
              letterSpacing: '0.1em',
            }}
          >
            Administration
          </Typography>

          <List sx={{ py: 0, px: 1 }}>
            {adminOnlyNavItems.map(renderNavItem)}
          </List>
        </>
      )}

      {/* Spacer */}
      <Box sx={{ flex: 1 }} />

      <Divider sx={{ mx: 2 }} />

      {/* Theme Toggle & User Section */}
      <Box sx={{ p: 2 }}>
        {/* Theme Toggle */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 2,
            px: 1,
          }}
        >
          <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 500 }}>
            Theme
          </Typography>
          <Tooltip title={currentTheme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}>
            <IconButton
              onClick={toggleTheme}
              size="small"
              sx={{
                bgcolor: 'background.default',
                border: '1px solid',
                borderColor: 'divider',
                '&:hover': {
                  bgcolor: 'primary.main',
                  color: 'white',
                  borderColor: 'primary.main',
                },
              }}
            >
              {currentTheme === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
        </Box>

        {/* User Info */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'background.default',
          }}
        >
          <UserAvatar user={user} sx={{ width: 36, height: 36 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 600,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user?.displayName || user?.email?.split('@')[0] || 'User'}
            </Typography>
            <Typography
              variant="caption"
              sx={{
                color: 'text.secondary',
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {isAdmin ? 'Administrator' : 'Publisher'}
            </Typography>
          </Box>
          <Tooltip title="Sign Out">
            <IconButton
              size="small"
              onClick={logoutUser}
              sx={{
                color: 'text.secondary',
                '&:hover': {
                  color: 'error.main',
                  bgcolor: alpha(muiTheme.palette.error.main, 0.15),
                },
              }}
            >
              <LogoutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* Mobile App Bar */}
      {isMobile && (
        <AppBar
          position="fixed"
          sx={{
            bgcolor: 'background.paper',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Toolbar sx={{ gap: 1 }}>
            <IconButton
              color="inherit"
              aria-label="open drawer"
              edge="start"
              onClick={handleDrawerToggle}
              sx={{ color: 'text.primary' }}
            >
              <MenuIcon />
            </IconButton>
            <Avatar
              variant="square"
              sx={{
                width: 32,
                height: 32,
                bgcolor: 'transparent',
                position: 'relative',
              }}
            >
              <Image src="/URM_icon.png" alt="Upper Room Media Logo" fill sizes="32px" />
            </Avatar>
            <Typography
              variant="h6"
              noWrap
              sx={{
                fontWeight: 700,
                fontSize: '1rem',
                letterSpacing: '-0.01em',
                flex: 1,
              }}
            >
              Upper Room
            </Typography>
            {/* Mobile Theme Toggle */}
            <Tooltip title={currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode'}>
              <IconButton onClick={toggleTheme} size="small" sx={{ color: 'text.primary' }}>
                {currentTheme === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
            <UserAvatar user={user} sx={{ width: 32, height: 32 }} />
          </Toolbar>
        </AppBar>
      )}

      {/* Desktop Drawer (Permanent) */}
      {!isMobile && (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              borderRight: 1,
              borderColor: 'divider',
            },
          }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* Mobile Drawer (Temporary) */}
      {isMobile && (
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={handleDrawerToggle}
          ModalProps={{
            keepMounted: true,
          }}
          sx={{
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
            },
          }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* Main Content Area */}
      <Box
        component="main"
        sx={{
          flexGrow: 1,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
          pt: isMobile ? '64px' : 0,
        }}
      >
        {children}
      </Box>
    </Box>
  );
};

export default AdminSidebarLayout;
