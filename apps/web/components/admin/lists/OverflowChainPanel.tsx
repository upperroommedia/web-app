import { useState } from 'react';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { ListOverflowChainNodeView } from '../../../utils/lists/listOverflowChainView';

interface OverflowChainPanelProps {
  nodes: ListOverflowChainNodeView[];
}

const OverflowChainPanel = ({ nodes }: OverflowChainPanelProps) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (value: string) => {
    if (!navigator?.clipboard?.writeText) {
      return;
    }

    await navigator.clipboard.writeText(value);
    setCopiedId(value);
  };

  return (
    <Card>
      <CardContent sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h6" fontWeight={700} sx={{ mb: 0.5 }}>
          Overflow Chain
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Inspect how this logical list maps to physical Subsplash pages. This panel is diagnostic only.
        </Typography>

        <Stack spacing={1.5}>
          {nodes.map((node) => (
            <Stack
              key={node.firestoreListId}
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              sx={{
                p: 1.5,
                border: 1,
                borderColor: 'divider',
                borderRadius: 2,
              }}
            >
              <Stack spacing={0.75} sx={{ flex: 1, minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                    {node.name}
                  </Typography>
                  <Chip
                    label={node.isRoot ? 'Root' : `Depth ${node.depth}`}
                    size="small"
                    color={node.isRoot ? 'primary' : 'default'}
                    variant={node.isRoot ? 'filled' : 'outlined'}
                  />
                  {node.hasCoverageGap ? (
                    <Chip
                      label="Mirror gap"
                      size="small"
                      color="warning"
                      variant="outlined"
                    />
                  ) : null}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Firestore ID: {node.firestoreListId}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Subsplash ID: {node.subsplashId || 'Not linked'}
                </Typography>
              </Stack>

              <Stack direction={{ xs: 'row', sm: 'row' }} spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary">
                  Physical: {node.physicalCount}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Mirrored: {node.localCount}
                </Typography>
                <Button
                  size="small"
                  variant="text"
                  onClick={() => void handleCopy(node.firestoreListId)}
                >
                  {copiedId === node.firestoreListId ? 'Copied' : 'Copy ID'}
                </Button>
              </Stack>
            </Stack>
          ))}
        </Stack>
      </CardContent>
    </Card>
  );
};

export default OverflowChainPanel;
