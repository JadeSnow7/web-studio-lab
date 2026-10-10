import { useRef, useState } from 'react';
import { catalogCommand } from './workspace';
export function useCatalogMutation() {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutate = async (payload: Parameters<typeof catalogCommand>[0], message: string) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await catalogCommand(payload);
      if (!result.ok) {
        setError(result.error.message);
        return false;
      }
      setNotice(message);
      return true;
    } catch (failure) {
      setError((failure as Error).message);
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return { busy, error, notice, mutate };
}
