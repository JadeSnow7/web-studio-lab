import { useRef, type KeyboardEvent } from 'react';

/** Enter that confirms an IME candidate must not become an implicit form submit. */
export function useImeForm() {
  const composing = useRef(false);
  return {
    composing,
    handlers: {
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
      },
      onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => {
        if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
      },
    },
  };
}
