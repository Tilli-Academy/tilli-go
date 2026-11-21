// "Bug found - back to Assess" is limited to the CR's assignee, reporter or an approver (review item 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTransition } from '../src/modules/changeRequests/workflow';

test('back to Assess is owner/approver-only and needs a reason', () => {
  const t = findTransition('SCHEDULED', 'ASSESS');
  assert.ok(t);
  assert.equal(t.ownersOnly, true);
  assert.equal(t.needsReason, true);
});

test('cancel and close need the close permission', () => {
  assert.equal(findTransition('SCHEDULED', 'CANCELLED')?.permission, 'cr.close');
  assert.equal(findTransition('REVIEW', 'CLOSED')?.permission, 'cr.close');
});

test('leaving Assess is only possible as a CAB decision (or withdraw)', () => {
  assert.equal(findTransition('ASSESS', 'SCHEDULED'), undefined);
  assert.equal(findTransition('ASSESS', 'NEW'), undefined);
  assert.equal(findTransition('ASSESS', 'CANCELLED')?.permission, 'cr.close');
});
