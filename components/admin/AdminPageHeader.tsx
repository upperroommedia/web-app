/**
 * AdminPageHeader - Reusable compact header component for admin pages
 * Provides consistent layout with title, optional search, and action button
 */
import { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import SearchIcon from '@mui/icons-material/Search';

interface AdminPageHeaderProps {
  /** Page title */
  title: string;
  /** Optional subtitle */
  subtitle?: string;
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /** Current search value */
  searchValue?: string;
  /** Callback when search value changes */
  onSearchChange?: (value: string) => void;
  /** Action button (e.g., "Add User", "Add Series") */
  actionButton?: ReactNode;
  /** Additional filter components */
  filterComponent?: ReactNode;
  /** Whether to show search on a separate row (default: same row on desktop) */
  searchOnSeparateRow?: boolean;
}

const AdminPageHeader = ({
  title,
  subtitle,
  searchPlaceholder = 'Search...',
  searchValue,
  onSearchChange,
  actionButton,
  filterComponent,
  searchOnSeparateRow = false,
}: AdminPageHeaderProps) => {
  const hasSearch = onSearchChange !== undefined;

  return (
    <Box sx={{ mb: 3 }}>
      {/* Title row */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: { xs: 'column', sm: 'row' },
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          gap: 2,
          mb: hasSearch || filterComponent ? 2 : 0,
        }}
      >
        <Box>
          <Typography variant="h5" fontWeight={700}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {/* Search in header row (when not on separate row) */}
          {hasSearch && !searchOnSeparateRow && (
            <TextField
              placeholder={searchPlaceholder}
              value={searchValue || ''}
              onChange={(e) => onSearchChange(e.target.value)}
              size="small"
              sx={{ minWidth: { xs: '100%', sm: 250 } }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              }}
            />
          )}
          {actionButton}
        </Box>
      </Box>

      {/* Search/Filter row (when on separate row) */}
      {(hasSearch && searchOnSeparateRow) || filterComponent ? (
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', sm: 'row' },
            gap: 2,
          }}
        >
          {hasSearch && searchOnSeparateRow && (
            <TextField
              placeholder={searchPlaceholder}
              value={searchValue || ''}
              onChange={(e) => onSearchChange(e.target.value)}
              size="small"
              sx={{ flex: 2 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
              }}
            />
          )}
          {filterComponent}
        </Box>
      ) : null}
    </Box>
  );
};

export default AdminPageHeader;
