/**
 * Custom MUI Theme - Admin UI
 * Supports both light and dark modes with flame logo color palette
 */
import { createTheme, ThemeOptions, PaletteMode } from '@mui/material/styles';

// Color Palette - Flame Logo Inspired
export const colors = {
  // Dark mode backgrounds
  dark: {
    background: {
      default: '#0f1115',
      paper: '#1a1d23',
      card: '#242830',
      elevated: '#2d323b',
    },
    border: {
      default: 'rgba(255,255,255,0.08)',
      light: 'rgba(255,255,255,0.12)',
    },
    text: {
      primary: '#f8fafc',
      secondary: '#94a3b8',
      tertiary: '#64748b',
      disabled: '#475569',
    },
  },
  // Light mode backgrounds
  light: {
    background: {
      default: '#f8fafc',
      paper: '#ffffff',
      card: '#ffffff',
      elevated: '#f1f5f9',
    },
    border: {
      default: 'rgba(0,0,0,0.08)',
      light: 'rgba(0,0,0,0.12)',
    },
    text: {
      primary: '#0f172a',
      secondary: '#475569',
      tertiary: '#64748b',
      disabled: '#94a3b8',
    },
  },
  // Accent - Orange/Flame (same for both modes)
  accent: {
    primary: '#f97316',
    secondary: '#fb923c',
    light: '#fdba74',
    dark: '#ea580c',
    glow: 'rgba(249,115,22,0.15)',
    glowStrong: 'rgba(249,115,22,0.25)',
  },
  // Status colors (same for both modes)
  status: {
    success: '#22c55e',
    successBg: 'rgba(34,197,94,0.15)',
    warning: '#eab308',
    warningBg: 'rgba(234,179,8,0.15)',
    error: '#ef4444',
    errorBg: 'rgba(239,68,68,0.15)',
    info: '#3b82f6',
    infoBg: 'rgba(59,130,246,0.15)',
  },
};

// Get mode-specific colors
const getModeColors = (mode: PaletteMode) => (mode === 'dark' ? colors.dark : colors.light);

// Create theme options for a given mode
const getThemeOptions = (mode: PaletteMode): ThemeOptions => {
  const modeColors = getModeColors(mode);
  
  return {
    palette: {
      mode,
      primary: {
        main: colors.accent.primary,
        light: colors.accent.secondary,
        dark: colors.accent.dark,
        contrastText: '#ffffff',
      },
      secondary: {
        main: modeColors.text.secondary,
        light: modeColors.text.primary,
        dark: modeColors.text.tertiary,
      },
      background: {
        default: modeColors.background.default,
        paper: modeColors.background.paper,
      },
      text: {
        primary: modeColors.text.primary,
        secondary: modeColors.text.secondary,
        disabled: modeColors.text.disabled,
      },
      error: {
        main: colors.status.error,
      },
      warning: {
        main: colors.status.warning,
      },
      success: {
        main: colors.status.success,
      },
      info: {
        main: colors.status.info,
      },
      divider: modeColors.border.default,
    },
    typography: {
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      h1: {
        fontSize: '2.5rem',
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 1.2,
      },
      h2: {
        fontSize: '2rem',
        fontWeight: 700,
        letterSpacing: '-0.01em',
        lineHeight: 1.3,
      },
      h3: {
        fontSize: '1.5rem',
        fontWeight: 600,
        letterSpacing: '-0.01em',
        lineHeight: 1.4,
      },
      h4: {
        fontSize: '1.25rem',
        fontWeight: 600,
        lineHeight: 1.4,
      },
      h5: {
        fontSize: '1.125rem',
        fontWeight: 600,
        lineHeight: 1.5,
      },
      h6: {
        fontSize: '1rem',
        fontWeight: 600,
        lineHeight: 1.5,
      },
      subtitle1: {
        fontSize: '1rem',
        fontWeight: 500,
        lineHeight: 1.5,
      },
      subtitle2: {
        fontSize: '0.875rem',
        fontWeight: 500,
        lineHeight: 1.5,
      },
      body1: {
        fontSize: '1rem',
        lineHeight: 1.6,
      },
      body2: {
        fontSize: '0.875rem',
        lineHeight: 1.6,
      },
      caption: {
        fontSize: '0.75rem',
        lineHeight: 1.5,
      },
      button: {
        fontWeight: 500,
        textTransform: 'none',
      },
    },
    shape: {
      borderRadius: 12,
    },
    shadows: [
      'none',
      mode === 'dark' ? '0 1px 2px 0 rgba(0,0,0,0.3)' : '0 1px 2px 0 rgba(0,0,0,0.05)',
      mode === 'dark' ? '0 1px 3px 0 rgba(0,0,0,0.3), 0 1px 2px -1px rgba(0,0,0,0.3)' : '0 1px 3px 0 rgba(0,0,0,0.1), 0 1px 2px -1px rgba(0,0,0,0.1)',
      mode === 'dark' ? '0 4px 6px -1px rgba(0,0,0,0.3), 0 2px 4px -2px rgba(0,0,0,0.3)' : '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
      mode === 'dark' ? '0 10px 15px -3px rgba(0,0,0,0.3), 0 4px 6px -4px rgba(0,0,0,0.3)' : '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
      mode === 'dark' ? '0 20px 25px -5px rgba(0,0,0,0.3), 0 8px 10px -6px rgba(0,0,0,0.3)' : '0 20px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
      mode === 'dark' ? '0 25px 50px -12px rgba(0,0,0,0.5)' : '0 25px 50px -12px rgba(0,0,0,0.25)',
    ],
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            scrollbarColor: `${modeColors.text.tertiary} ${modeColors.background.paper}`,
            '&::-webkit-scrollbar, & *::-webkit-scrollbar': {
              width: 8,
              height: 8,
            },
            '&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb': {
              borderRadius: 8,
              backgroundColor: modeColors.text.tertiary,
              border: '2px solid transparent',
            },
            '&::-webkit-scrollbar-track, & *::-webkit-scrollbar-track': {
              backgroundColor: 'transparent',
            },
          },
        },
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            padding: '8px 16px',
            fontWeight: 500,
            transition: 'all 0.2s ease-in-out',
          },
          contained: {
            boxShadow: 'none',
            '&:hover': {
              boxShadow: `0 0 20px ${colors.accent.glow}`,
            },
          },
          containedPrimary: {
            background: colors.accent.secondary,
            '&:hover': {
              background: colors.accent.primary,
            },
          },
          outlined: {
            borderColor: modeColors.border.light,
            '&:hover': {
              borderColor: colors.accent.primary,
              backgroundColor: colors.accent.glow,
            },
          },
          outlinedPrimary: {
            borderColor: colors.accent.primary,
            color: colors.accent.primary,
            '&:hover': {
              borderColor: colors.accent.secondary,
              backgroundColor: colors.accent.glow,
            },
          },
          text: {
            '&:hover': {
              backgroundColor: colors.accent.glow,
            },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            transition: 'all 0.2s ease-in-out',
            '&:hover': {
              backgroundColor: colors.accent.glow,
            },
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundColor: modeColors.background.card,
            borderRadius: 12,
            border: `1px solid ${modeColors.border.default}`,
            boxShadow: mode === 'dark' ? '0 4px 6px -1px rgba(0,0,0,0.2)' : '0 4px 6px -1px rgba(0,0,0,0.05)',
            transition: 'all 0.2s ease-in-out',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
          elevation1: {
            backgroundColor: modeColors.background.paper,
            boxShadow: mode === 'dark' ? '0 1px 3px 0 rgba(0,0,0,0.2)' : '0 1px 3px 0 rgba(0,0,0,0.05)',
          },
          elevation2: {
            backgroundColor: modeColors.background.card,
            boxShadow: mode === 'dark' ? '0 4px 6px -1px rgba(0,0,0,0.2)' : '0 4px 6px -1px rgba(0,0,0,0.05)',
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundColor: modeColors.background.paper,
            borderBottom: `1px solid ${modeColors.border.default}`,
            boxShadow: 'none',
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundColor: modeColors.background.paper,
            borderRight: `1px solid ${modeColors.border.default}`,
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              backgroundColor: mode === 'dark' ? modeColors.background.default : modeColors.background.card,
              '& fieldset': {
                borderColor: modeColors.border.default,
              },
              '&:hover fieldset': {
                borderColor: modeColors.border.light,
              },
              '&.Mui-focused fieldset': {
                borderColor: colors.accent.primary,
                boxShadow: `0 0 0 3px ${colors.accent.glow}`,
              },
            },
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: mode === 'dark' ? modeColors.background.default : modeColors.background.card,
            '& fieldset': {
              borderColor: modeColors.border.default,
            },
            '&:hover fieldset': {
              borderColor: modeColors.border.light,
            },
            '&.Mui-focused fieldset': {
              borderColor: colors.accent.primary,
            },
          },
        },
      },
      MuiSelect: {
        styleOverrides: {
          root: {
            backgroundColor: mode === 'dark' ? modeColors.background.default : modeColors.background.card,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            fontWeight: 500,
            borderRadius: 6,
          },
          outlined: {
            borderColor: modeColors.border.light,
          },
          colorSuccess: {
            backgroundColor: colors.status.successBg,
            color: colors.status.success,
            borderColor: colors.status.success,
          },
          colorWarning: {
            backgroundColor: colors.status.warningBg,
            color: colors.status.warning,
            borderColor: colors.status.warning,
          },
          colorError: {
            backgroundColor: colors.status.errorBg,
            color: colors.status.error,
            borderColor: colors.status.error,
          },
          colorInfo: {
            backgroundColor: colors.status.infoBg,
            color: colors.status.info,
            borderColor: colors.status.info,
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: {
            borderColor: modeColors.border.default,
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            margin: '2px 8px',
            padding: '10px 12px',
            transition: 'all 0.15s ease-in-out',
            '&:hover': {
              backgroundColor: colors.accent.glow,
            },
            '&.Mui-selected': {
              backgroundColor: colors.accent.glow,
              borderLeft: `3px solid ${colors.accent.primary}`,
              '&:hover': {
                backgroundColor: colors.accent.glowStrong,
              },
            },
          },
        },
      },
      MuiListItemIcon: {
        styleOverrides: {
          root: {
            color: modeColors.text.secondary,
            minWidth: 40,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            backgroundColor: modeColors.background.card,
            border: `1px solid ${modeColors.border.default}`,
            borderRadius: 16,
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontSize: '1.25rem',
            fontWeight: 600,
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: modeColors.background.elevated,
            border: `1px solid ${modeColors.border.default}`,
            borderRadius: 8,
            fontSize: '0.75rem',
            padding: '8px 12px',
            color: modeColors.text.primary,
          },
          arrow: {
            color: modeColors.background.elevated,
          },
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 8,
          },
          standardSuccess: {
            backgroundColor: colors.status.successBg,
            color: colors.status.success,
          },
          standardWarning: {
            backgroundColor: colors.status.warningBg,
            color: colors.status.warning,
          },
          standardError: {
            backgroundColor: colors.status.errorBg,
            color: colors.status.error,
          },
          standardInfo: {
            backgroundColor: colors.status.infoBg,
            color: colors.status.info,
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderColor: modeColors.border.default,
          },
          head: {
            backgroundColor: modeColors.background.elevated,
            fontWeight: 600,
            color: modeColors.text.primary,
          },
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            '&:hover': {
              backgroundColor: colors.accent.glow,
            },
          },
        },
      },
      MuiTableContainer: {
        styleOverrides: {
          root: {
            backgroundColor: modeColors.background.card,
            borderRadius: 12,
            border: `1px solid ${modeColors.border.default}`,
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            backgroundColor: modeColors.background.card,
            border: `1px solid ${modeColors.border.default}`,
            borderRadius: 12,
            marginTop: 4,
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            margin: '2px 6px',
            padding: '8px 12px',
            '&:hover': {
              backgroundColor: colors.accent.glow,
            },
            '&.Mui-selected': {
              backgroundColor: colors.accent.glow,
              '&:hover': {
                backgroundColor: colors.accent.glowStrong,
              },
            },
          },
        },
      },
      MuiAvatar: {
        styleOverrides: {
          root: {
            backgroundColor: colors.accent.primary,
            color: '#ffffff',
          },
        },
      },
      MuiSkeleton: {
        styleOverrides: {
          root: {
            backgroundColor: modeColors.border.light,
          },
        },
      },
      MuiTable: {
        styleOverrides: {
          root: {
            backgroundColor: modeColors.background.card,
          },
        },
      },
    },
  };
};

// Create themes for each mode
export const darkTheme = createTheme(getThemeOptions('dark'));
export const lightTheme = createTheme(getThemeOptions('light'));

// Default export for backward compatibility
export default darkTheme;
