import { Box, Text, useInput } from 'ink';
import React, { useRef, useState } from 'react';

export type PromptMode = 'digits' | 'text';

interface PromptInputProps {
  label: string;
  mode: PromptMode;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Single-line input rendered inline. Used for the retry-delay prompt (digits)
 * and the filter input (text). Deliberately small — Ink's `useInput` plus a
 * `useState` buffer is enough for the two modes we currently need, and bringing
 * in `ink-text-input` (or similar) is a dep we'd otherwise not pull in.
 *
 * Submit on Enter, cancel on Esc. In digits mode, non-digit keystrokes are
 * silently dropped instead of buffered-then-rejected — that's friendlier than
 * making the user clear the buffer before retrying.
 *
 * The buffer lives in both `state` (so the rendered value updates) and a
 * `ref` (so `onSubmit` reads the latest value even when several keystrokes
 * arrive between renders). Without the ref, ink-testing-library's batched
 * writes (`stdin.write('500')` then `stdin.write('\\r')` in the same tick)
 * race the React state commit, and the submit handler reads an empty buffer.
 */
export function PromptInput({
  label,
  mode,
  onSubmit,
  onCancel,
}: PromptInputProps): React.ReactElement {
  const [buffer, setBuffer] = useState('');
  const bufferRef = useRef('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(bufferRef.current);
      return;
    }
    if (key.backspace || key.delete) {
      bufferRef.current = bufferRef.current.slice(0, -1);
      setBuffer(bufferRef.current);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      if (mode === 'digits' && !/^\d+$/.test(input)) return;
      bufferRef.current = bufferRef.current + input;
      setBuffer(bufferRef.current);
    }
  });

  return (
    <Box borderStyle="single" borderColor="cyan" paddingX={1}>
      <Text>
        {label} <Text color="cyan">{buffer}</Text>
        <Text dimColor>▌</Text>
      </Text>
    </Box>
  );
}
