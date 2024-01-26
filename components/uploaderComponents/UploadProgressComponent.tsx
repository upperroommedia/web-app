import Box from '@mui/material/Box'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import React from 'react'
import { UploadProgress } from '../../context/types'

interface UploadProgressComponentProps {
    isUploading: boolean
    uploadProgress: UploadProgress
}

export default function UploadProgressComponent({isUploading, uploadProgress}: UploadProgressComponentProps) {
  return (
    <Box display="flex" width={1} gap={1} justifyContent="center" alignItems="center">
                  {isUploading && (
                    <Box width={1}>
                      <LinearProgress variant="determinate" value={uploadProgress.percent} />
                    </Box>
                  )}
                  {uploadProgress.message && (
                    <Typography sx={{ textAlign: 'center', color: uploadProgress.error ? 'red' : 'black' }}>
                      {!uploadProgress.error && uploadProgress.percent < 100
                        ? `${uploadProgress.percent}%`
                        : uploadProgress.message}
                    </Typography>
                  )}
                </Box>
  )
}
