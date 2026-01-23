/**
 * SidebarLayout - Modern sidebar navigation
 * - Desktop: Fixed 260px sidebar on the left
 * - Mobile: Hamburger menu with slide-out drawer
 * - Role-based navigation (Publishers vs Admins)
 * - Light/Dark mode toggle
 */
import { useState, ReactNode, useMemo } from 'react';
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

interface SidebarLayoutProps {
  children: ReactNode;
}

const SidebarLayout = ({ children }: SidebarLayoutProps) => {
  const muiTheme = useMuiTheme();
  const { theme: currentTheme, setTheme } = useTheme();
  const router = useRouter();
  const { user, logoutUser } = useAuth();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down('md'));
  const [mobileOpen, setMobileOpen] = useState(false);

  const isAdmin = user?.isAdmin() ?? false;

  const formattedRole = useMemo(() => {
    if (!user?.role) return 'User';
    return user.role.charAt(0).toUpperCase() + user.role.slice(1).toLowerCase();
  }, [user?.role]);

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
            py: 0.5,
            minHeight: 36,
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
          <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
          <ListItemText
            primary={item.label}
            primaryTypographyProps={{
              fontSize: '0.85rem',
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
      {/* Logo Section - Clickable to navigate to sermons */}
      <Link href="/admin/sermons" passHref style={{ textDecoration: 'none' }}>
        <Box
          sx={{
            px: 1.5,
            py: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            borderRadius: 1,
            '&:hover': {
              bgcolor: 'action.hover',
            },
          }}
        >
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
      </Link>

      <Divider sx={{ mx: 1.5 }} />

      {/* Upload Sermon - Primary Action */}
      <Box sx={{ px: 0.5, pt: 1 }}>
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
              borderRadius: 1.5,
              mx: 0.5,
              py: 0.75,
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

      <Divider sx={{ mx: 1.5, my: 1 }} />

      {/* Content Management Section */}
      <Typography
        variant="overline"
        sx={{
          px: 2,
          color: 'text.secondary',
          fontSize: '0.6rem',
          fontWeight: 600,
          letterSpacing: '0.1em',
        }}
      >
        Content
      </Typography>

      {/* Publisher Nav Items (Sermons, Series) */}
      <List sx={{ py: 0, px: 0.5 }} dense>
        {publisherNavItems.map(renderNavItem)}
      </List>

      {/* Admin Only Section */}
      {isAdmin && (
        <>
          <Divider sx={{ mx: 1.5, my: 1 }} />
          
          <Typography
            variant="overline"
            sx={{
              px: 2,
              color: 'text.secondary',
              fontSize: '0.6rem',
              fontWeight: 600,
              letterSpacing: '0.1em',
            }}
          >
            Administration
          </Typography>

          <List sx={{ py: 0, px: 0.5 }} dense>
            {adminOnlyNavItems.map(renderNavItem)}
          </List>
        </>
      )}

      {/* Spacer */}
      <Box sx={{ flex: 1 }} />

      <Divider sx={{ mx: 1.5 }} />

      {/* Theme Toggle & User Section */}
      <Box sx={{ p: 1 }}>
        {/* Theme Toggle */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 1,
            px: 0.5,
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
            gap: 1,
            p: 0.75,
            borderRadius: 1.5,
            bgcolor: 'background.default',
          }}
        >
          <UserAvatar user={user} sx={{ width: 32, height: 32 }} />
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
              {formattedRole}
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
            <Link href="/admin/sermons" passHref style={{ display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none', flex: 1 }}>
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
                  color: 'text.primary',
                }}
              >
                Upper Room
              </Typography>
            </Link>
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

export default SidebarLayout;
