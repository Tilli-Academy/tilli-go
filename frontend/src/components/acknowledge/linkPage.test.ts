import { describe, expect, test } from '@jest/globals';
import { AxiosError, AxiosHeaders } from 'axios';
import { announce, linkErrorMessage } from './linkPage';

const apiError = (status: number, error: string) =>
  new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
    status, statusText: '', data: { error }, headers: {}, config: { headers: new AxiosHeaders() },
  });

describe('email-link page messages', () => {
  test('expired and broken links get a message the owner can act on', () => {
    expect(linkErrorMessage(apiError(403, 'Token expired'), 'acknowledge')).toMatch(/expired.*new one/);
    expect(linkErrorMessage(apiError(403, 'Invalid token signature'), 'complete')).toMatch(/not valid.*straight from the email/);
    expect(linkErrorMessage(apiError(403, 'Malformed token'), 'complete')).toMatch(/not valid/);
  });

  test('reassigned owner and other server messages are shown as they are', () => {
    expect(linkErrorMessage(apiError(403, 'This link was sent to a previous owner of the task'), 'acknowledge')).toBe('This link was sent to a previous owner of the task');
  });

  test('rate limit and network problems', () => {
    expect(linkErrorMessage(apiError(429, 'Too many requests'), 'acknowledge')).toMatch(/Wait a minute/);
    expect(linkErrorMessage(new AxiosError('Network Error', 'ERR_NETWORK'), 'acknowledge')).toMatch(/connection/);
  });

  test('each state change is announced', () => {
    expect(announce('saving', 'acknowledge')).toBe('Acknowledging the task');
    expect(announce('done', 'complete')).toBe('Task completed');
    expect(announce('error', 'complete')).toBe(''); // errors are announced by their role="alert" element
  });
});
