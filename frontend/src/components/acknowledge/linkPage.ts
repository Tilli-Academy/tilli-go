import { useEffect, useRef } from 'react';
import axios from 'axios';
import { getErrorMessage } from '../../services/api';

/**
 * Shared by the acknowledge and complete pages (opened from email links): turn API
 * errors into messages the task owner can act on, and move focus to whatever the page
 * shows next so keyboard and screen-reader users land on it.
 */
export function linkErrorMessage(err: unknown, verb: 'acknowledge' | 'complete'): string {
  if (axios.isAxiosError(err) && !err.response) {
    return "Can't reach Tilli-go right now. Check your connection and try again.";
  }
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  const raw = getErrorMessage(err);
  if (status === 429) return 'Too many attempts from this network. Wait a minute and try again.';
  if (raw === 'Token expired') return `This link has expired. Ask your release manager to send a new one, or ${verb} the task in Tilli-go.`;
  if (['Invalid token signature', 'Malformed token', 'Invalid token', 'Token task ID mismatch'].includes(raw)) {
    return 'This link is not valid. It may have been cut off when it was copied: open it again straight from the email.';
  }
  if (raw === 'Task not found') return 'This task no longer exists. It may have been removed from the plan.';
  return raw; // owner changed, dependencies not done, etc.: the server's message is already clear
}

/** Focus `ref` whenever `key` changes (e.g. the page moves from "confirm" to "done"). */
export function useFocusOnChange<T extends HTMLElement>(key: unknown) {
  const ref = useRef<T>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    ref.current?.focus();
  }, [key]);
  return ref;
}

/**
 * Text for the page's polite live region, so screen readers hear each state change.
 * Errors are not repeated here: they are shown in an element with role="alert".
 */
export function announce(view: string, verb: 'acknowledge' | 'complete'): string {
  if (view === 'loading') return 'Loading your task';
  if (view === 'saving') return verb === 'acknowledge' ? 'Acknowledging the task' : 'Completing the task';
  if (view === 'done') return verb === 'acknowledge' ? 'Task acknowledged' : 'Task completed';
  return '';
}
