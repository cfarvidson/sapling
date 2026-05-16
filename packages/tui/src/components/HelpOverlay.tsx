import { Box, Text } from 'ink';
import React from 'react';

interface KeyBinding {
  keys: string;
  description: string;
}

const BINDINGS: ReadonlyArray<KeyBinding> = [
  { keys: '↑ ↓ / j k', description: 'move selection' },
  { keys: '→ / enter', description: 'attach to running agent (claimed only)' },
  { keys: '1 / 2 / 3 / 4', description: 'switch tabs: work / plans / projects / schedules' },
  { keys: '/', description: 'filter (substring, case-insensitive)' },
  { keys: 'u', description: 'unblock (blocked items only)' },
  { keys: 'r', description: 'retry (prompts for optional delay ms)' },
  { keys: 'c', description: 'cancel (opens $EDITOR for reason)' },
  { keys: 'i', description: 'answer awaiting_input (opens $EDITOR)' },
  { keys: '?', description: 'toggle this help overlay' },
  { keys: 'esc', description: 'close prompt / overlay' },
  { keys: 'q / ctrl-c', description: 'quit' },
];

/**
 * Static help overlay. Rendered above the layout when toggled by `?`. Pure
 * presentational — the parent owns the toggle state.
 */
export function HelpOverlay(): React.ReactElement {
  return (
    <Box borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
      <Text bold>Sapling TUI — key bindings</Text>
      <Box marginTop={1} flexDirection="column">
        {BINDINGS.map((b) => (
          <Box key={b.keys}>
            <Box width={16}>
              <Text color="cyan">{b.keys}</Text>
            </Box>
            <Text>{b.description}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>press ? or esc to close</Text>
      </Box>
    </Box>
  );
}
