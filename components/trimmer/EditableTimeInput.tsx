import TextField from '@mui/material/TextField';
import IconButton from '@mui/material/IconButton';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { useCallback, useEffect, useRef, useState, memo, useLayoutEffect } from 'react';
import { useTrimmerStore } from '../../context/trimmerStore';

interface EditableTimeInputProps {
  /** Which time value this input controls */
  type: 'start' | 'end';
  /** Label for the input */
  label?: string;
  /** Additional sx props for the TextField */
  sx?: object;
  /** Disabled state */
  disabled?: boolean;
}

// Fixed format: HH:MM:SS.m (always 10 characters)
const TIME_FORMAT = '00:00:00.0';
const DIGIT_POSITIONS = [0, 1, 3, 4, 6, 7, 9]; // Character indices of editable digits
const INVALID_CURSOR_POSITIONS = [3, 6, 9]; // Cursor positions right after separators (: and .)

/**
 * Convert seconds to fixed format HH:MM:SS.m
 */
function secondsToFixedFormat(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return TIME_FORMAT;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);

  // Clamp hours to 99
  const h = Math.min(hours, 99);

  return `${String(h).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}

/**
 * Convert fixed format HH:MM:SS.m to seconds
 */
function fixedFormatToSeconds(str: string): number {
  // Extract digits only
  const digits = str.replace(/[^\d]/g, '');
  if (digits.length < 7) return 0;

  const hours = parseInt(digits.slice(0, 2), 10) || 0;
  const minutes = parseInt(digits.slice(2, 4), 10) || 0;
  const seconds = parseInt(digits.slice(4, 6), 10) || 0;
  const tenths = parseInt(digits.slice(6, 7), 10) || 0;

  return hours * 3600 + minutes * 60 + seconds + tenths / 10;
}

/**
 * Check if a character position is a digit (not a separator)
 */
function isDigitPosition(pos: number): boolean {
  return DIGIT_POSITIONS.includes(pos);
}

/**
 * Check if a cursor position is valid (not directly after a separator)
 */
function isValidCursorPosition(pos: number): boolean {
  return !INVALID_CURSOR_POSITIONS.includes(pos);
}

/**
 * Get the next digit position (skip separators)
 * Returns string length (10) if at or past the last digit
 */
function nextDigitPosition(pos: number): number {
  for (const dp of DIGIT_POSITIONS) {
    if (dp > pos) return dp;
  }
  // At or past the last digit, return end of string
  return TIME_FORMAT.length;
}

/**
 * Get the previous digit position (skip separators)
 */
function prevDigitPosition(pos: number): number {
  for (let i = DIGIT_POSITIONS.length - 1; i >= 0; i--) {
    if (DIGIT_POSITIONS[i] < pos) return DIGIT_POSITIONS[i];
  }
  return DIGIT_POSITIONS[0];
}

/**
 * An editable time input with fixed format HH:MM:SS.m
 * - Always displays all digits with padding zeros
 * - Delete/Backspace replace digits with 0 instead of removing
 * - Typing overwrites the digit at cursor position
 */
function EditableTimeInput({ type, label, sx, disabled }: EditableTimeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Subscribe only to this input's value and duration so the other bound doesn't trigger re-renders.
  // Use getState() for the other bound in validation/handlers.
  const storeValue = useTrimmerStore((state) => (type === 'start' ? state.trimStart : state.trimEnd));
  const duration = useTrimmerStore((state) => state.duration);
  const setTrimStart = useTrimmerStore((state) => state.setTrimStart);
  const setTrimEnd = useTrimmerStore((state) => state.setTrimEnd);
  const setCurrentTime = useTrimmerStore((state) => state.setCurrentTime);

  const setStoreValue = type === 'start' ? setTrimStart : setTrimEnd;

  // Local state for input
  const [inputValue, setInputValue] = useState(TIME_FORMAT);
  const [isFocused, setIsFocused] = useState(false);
  const [isInvalid, setIsInvalid] = useState(false);

  // Track if we're currently editing to prevent store updates from overwriting input
  const isEditingRef = useRef(false);

  // Track cursor position to restore after re-render
  const pendingCursorRef = useRef<number | null>(null);

  // Check if a time value is valid. Read "other" bound from store to avoid subscribing.
  const checkValidity = useCallback(
    (parsedTime: number): boolean => {
      const state = useTrimmerStore.getState();
      if (type === 'start') {
        return parsedTime >= 0 && parsedTime < state.trimEnd && parsedTime <= duration;
      }
      return parsedTime > state.trimStart && parsedTime <= duration;
    },
    [type, duration]
  );

  // Original value: 0 for start, duration for end
  const originalValue = type === 'start' ? 0 : duration;
  
  // Check if current value differs from original (with small tolerance for floating point)
  const hasChanged = Math.abs(storeValue - originalValue) > 0.05;

  // Reset handler. Read trimStart for end-type from store to avoid subscribing.
  const handleReset = useCallback(() => {
    const trimStart = type === 'end' ? useTrimmerStore.getState().trimStart : 0;
    const previewTime =
      type === 'end' ? Math.max(trimStart, originalValue - 5) : originalValue;
    setStoreValue(originalValue, 'input');
    setCurrentTime(previewTime, 'input');
    setInputValue(secondsToFixedFormat(originalValue));
    setIsInvalid(false);
  }, [originalValue, setStoreValue, setCurrentTime, type]);

  // Sync input from store when not focused/editing
  useEffect(() => {
    if (!isFocused && !isEditingRef.current) {
      setInputValue(secondsToFixedFormat(storeValue));
    }
  }, [storeValue, isFocused]);

  // Restore cursor position after re-render
  useLayoutEffect(() => {
    if (pendingCursorRef.current !== null && inputRef.current) {
      const pos = pendingCursorRef.current;
      inputRef.current.setSelectionRange(pos, pos);
      pendingCursorRef.current = null;
    }
  }, [inputValue]);

  const handleFocus = useCallback(() => {
    setIsFocused(true);
    isEditingRef.current = true;
    // Position cursor at the end on focus
    setTimeout(() => {
      if (inputRef.current) {
        const len = inputRef.current.value.length;
        inputRef.current.setSelectionRange(len, len);
      }
    }, 0);
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    isEditingRef.current = false;
    setIsInvalid(false);

    const parsedTime = fixedFormatToSeconds(inputValue);
    const { trimStart: ts, trimEnd: te } = useTrimmerStore.getState();
    let clampedTime: number;

    if (type === 'start') {
      clampedTime = Math.max(0, Math.min(parsedTime, te - 0.1, duration));
    } else {
      clampedTime = Math.max(ts + 0.1, Math.min(parsedTime, duration));
    }

    setStoreValue(clampedTime, 'input');
    if (type === 'start') {
      setCurrentTime(clampedTime, 'input');
    } else {
      setCurrentTime(Math.max(ts, clampedTime - 5), 'input');
    }
    setInputValue(secondsToFixedFormat(clampedTime));
  }, [inputValue, type, duration, setStoreValue, setCurrentTime]);

  // Helper to update value and store
  const updateValue = useCallback(
    (newValue: string, cursorPos: number) => {
      const input = inputRef.current;
      
      // If value hasn't changed, just move cursor directly
      if (newValue === inputValue && input) {
        input.setSelectionRange(cursorPos, cursorPos);
        return;
      }

      pendingCursorRef.current = cursorPos;
      setInputValue(newValue);

      // Parse the time
      const parsedTime = fixedFormatToSeconds(newValue);

      // Check validity and update indicator
      const isValid = checkValidity(parsedTime);
      setIsInvalid(!isValid);

      const { trimStart: ts, trimEnd: te } = useTrimmerStore.getState();
      if (type === 'start') {
        const previewTime = Math.max(0, Math.min(parsedTime, te - 0.1, duration));
        setCurrentTime(previewTime, 'input');
        if (isValid) setStoreValue(parsedTime, 'input');
      } else {
        const clampedEnd = Math.max(ts + 0.1, Math.min(parsedTime, duration));
        setCurrentTime(Math.max(ts, clampedEnd - 5), 'input');
        if (isValid) setStoreValue(parsedTime, 'input');
      }
    },
    [duration, type, setStoreValue, setCurrentTime, inputValue, checkValidity]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const input = inputRef.current;
      if (!input) return;

      const selStart = input.selectionStart ?? 0;
      const selEnd = input.selectionEnd ?? 0;
      const hasSelection = selEnd > selStart;
      const currentValue = inputValue;

      // Handle digit input
      if (/^\d$/.test(e.key)) {
        e.preventDefault();

        // If there's a selection, replace first selected digit with typed digit, zero the rest
        if (hasSelection) {
          let newValue = currentValue;
          let firstDigitReplaced = false;
          
          for (let i = selStart; i < selEnd; i++) {
            if (isDigitPosition(i)) {
              if (!firstDigitReplaced) {
                // Replace first digit with typed key
                newValue = newValue.slice(0, i) + e.key + newValue.slice(i + 1);
                firstDigitReplaced = true;
              } else {
                // Zero out remaining digits
                newValue = newValue.slice(0, i) + '0' + newValue.slice(i + 1);
              }
            }
          }
          
          // Find the first digit position in selection and move cursor to next digit
          let firstDigitPos = selStart;
          while (firstDigitPos < selEnd && !isDigitPosition(firstDigitPos)) {
            firstDigitPos++;
          }
          const nextPos = nextDigitPosition(firstDigitPos);
          updateValue(newValue, nextPos);
          return;
        }

        // No selection - overwrite at current position
        let editPos = selStart;
        if (!isDigitPosition(selStart)) {
          // If on a separator, move to next digit
          editPos = nextDigitPosition(selStart);
        }

        if (editPos < currentValue.length && isDigitPosition(editPos)) {
          // Replace the digit at this position
          const newValue = currentValue.slice(0, editPos) + e.key + currentValue.slice(editPos + 1);
          // Move cursor to next digit position
          const nextPos = nextDigitPosition(editPos);
          updateValue(newValue, nextPos);
        }
        return;
      }

      // Handle Delete - replace digit(s) with 0
      if (e.key === 'Delete') {
        e.preventDefault();

        // If there's a selection, zero out all selected digits
        if (hasSelection) {
          let newValue = currentValue;
          for (let i = selStart; i < selEnd; i++) {
            if (isDigitPosition(i)) {
              newValue = newValue.slice(0, i) + '0' + newValue.slice(i + 1);
            }
          }
          updateValue(newValue, selStart);
          return;
        }

        // No selection - zero the current digit
        let editPos = selStart;
        if (!isDigitPosition(selStart)) {
          editPos = nextDigitPosition(selStart);
        }

        if (editPos < currentValue.length && isDigitPosition(editPos)) {
          const newValue = currentValue.slice(0, editPos) + '0' + currentValue.slice(editPos + 1);
          // Move cursor to next digit
          const nextPos = nextDigitPosition(editPos);
          updateValue(newValue, nextPos);
        }
        return;
      }

      // Handle Backspace - replace digit(s) with 0
      if (e.key === 'Backspace') {
        e.preventDefault();

        // If there's a selection, zero out all selected digits
        if (hasSelection) {
          let newValue = currentValue;
          for (let i = selStart; i < selEnd; i++) {
            if (isDigitPosition(i)) {
              newValue = newValue.slice(0, i) + '0' + newValue.slice(i + 1);
            }
          }
          updateValue(newValue, selStart);
          return;
        }

        // No selection - zero the previous digit
        const editPos = prevDigitPosition(selStart);

        if (isDigitPosition(editPos)) {
          const newValue = currentValue.slice(0, editPos) + '0' + currentValue.slice(editPos + 1);
          // Keep cursor at the position we just edited
          updateValue(newValue, editPos);
        }
        return;
      }

      // Handle arrow keys - skip positions directly after separators
      // Valid cursor positions: 0, 1, 2, 4, 5, 7, 8, 10 (not 3, 6, 9 which are right after : and .)
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        let newPos = selStart - 1;
        // Skip invalid cursor positions (right after separators)
        while (newPos > 0 && !isValidCursorPosition(newPos)) {
          newPos--;
        }
        newPos = Math.max(0, newPos);
        input.setSelectionRange(newPos, newPos);
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        let newPos = selStart + 1;
        // Skip invalid cursor positions (right after separators)
        while (newPos < currentValue.length && !isValidCursorPosition(newPos)) {
          newPos++;
        }
        newPos = Math.min(currentValue.length, newPos);
        input.setSelectionRange(newPos, newPos);
        return;
      }

      // Handle Home/End
      if (e.key === 'Home') {
        e.preventDefault();
        input.setSelectionRange(0, 0);
        return;
      }

      if (e.key === 'End') {
        e.preventDefault();
        const len = currentValue.length;
        input.setSelectionRange(len, len);
        return;
      }

      // Handle Tab, Enter, Escape
      if (e.key === 'Tab') {
        return; // Allow default behavior
      }

      if (e.key === 'Enter' || e.key === 'Escape') {
        input.blur();
        return;
      }

      // Allow Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+X
      if (e.ctrlKey || e.metaKey) {
        return;
      }

      // Block everything else
      e.preventDefault();
    },
    [inputValue, updateValue]
  );

  // Prevent default change behavior - we handle everything in keydown
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    // For paste operations, try to parse and apply
    const newValue = e.target.value;
    if (newValue.length !== inputValue.length) {
      // This was likely a paste - try to extract digits and apply
      const digits = newValue.replace(/[^\d]/g, '').slice(0, 7).padEnd(7, '0');
      const formatted = `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}.${digits.slice(6, 7)}`;
      updateValue(formatted, formatted.length);
    }
  }, [inputValue, updateValue]);

  const defaultLabel = type === 'start' ? 'Start Time' : 'End Time';

  return (
    <Box sx={{ position: 'relative', display: 'inline-block' }}>
      <TextField
        inputRef={inputRef}
        label={label || defaultLabel}
        value={inputValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        error={isInvalid}
        size="small"
        inputProps={{
          inputMode: 'numeric',
          pattern: '[0-9:.]*',
          style: { fontFamily: 'monospace', textAlign: 'center' },
          maxLength: 10, // HH:MM:SS.m
        }}
        sx={{
          width: '140px',
          '& .MuiInputBase-input': {
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.5px',
          },
          // Additional red background tint when invalid
          ...(isInvalid && {
            '& .MuiOutlinedInput-root': {
              backgroundColor: 'rgba(211, 47, 47, 0.1)',
            },
          }),
          ...sx,
        }}
      />
      {/* Reset button - absolutely positioned, fades in/out */}
      <Tooltip title={`Reset to ${type === 'start' ? 'beginning' : 'end'}`}>
        <IconButton
          size="small"
          onClick={handleReset}
          tabIndex={hasChanged ? 0 : -1}
          sx={{
            position: 'absolute',
            right: -28,
            top: '50%',
            transform: 'translateY(-50%)',
            padding: '4px',
            opacity: hasChanged ? 1 : 0,
            pointerEvents: hasChanged ? 'auto' : 'none',
            transition: 'opacity 0.2s ease',
            '& .MuiSvgIcon-root': { fontSize: '1.1rem' },
          }}
        >
          <RestartAltIcon />
        </IconButton>
      </Tooltip>
    </Box>
  );
}

export default memo(EditableTimeInput);
