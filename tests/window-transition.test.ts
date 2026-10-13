import { describe, expect, it } from 'vitest';
import { WindowTransitionState, type WindowTransition } from '../electron/window-transition';

function requestTransition(state: WindowTransitionState, operation: WindowTransition) {
  if (operation === 'quit') state.requestQuit();
  if (operation !== 'reload') state.requestClose();
  state.preventUnload();
}

const operations: WindowTransition[] = ['quit', 'close', 'reload'];

describe('window transition confirmation', () => {
  it.each(operations)('resumes the original %s operation after approval', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);

    expect(state.resolve(true)).toBe(operation);
  });

  it.each(operations)('keeps the pending %s operation when unload is prevented again', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);
    state.preventUnload();
    state.preventUnload();

    expect(state.resolve(true)).toBe(operation);
  });

  it.each(operations)('consumes an approved %s operation exactly once', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);

    expect(state.resolve(true)).toBe(operation);
    expect(() => state.resolve(true)).toThrow(/[\u4e00-\u9fff]/);
  });

  it.each(operations)('cancels %s and leaves a later window close independent', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);

    expect(state.resolve(false)).toBeUndefined();
    expect(() => state.resolve(true)).toThrow();
    state.requestClose();
    state.preventUnload();
    expect(state.resolve(true)).toBe('close');
  });

  it('does not turn a confirmed quit into another quit on the next window close', () => {
    const state = new WindowTransitionState();
    requestTransition(state, 'quit');
    expect(state.resolve(true)).toBe('quit');

    requestTransition(state, 'close');
    expect(state.resolve(true)).toBe('close');
  });

  it('does not require a pending operation to cancel', () => {
    const state = new WindowTransitionState();
    expect(state.resolve(false)).toBeUndefined();
    expect(state.resolve(false)).toBeUndefined();
  });

  it('records quit intent without creating a confirmable operation until close is requested', () => {
    const state = new WindowTransitionState();
    state.requestQuit();

    expect(() => state.resolve(true)).toThrow(/[\u4e00-\u9fff]/);
    state.requestClose();
    state.preventUnload();
    expect(state.resolve(true)).toBe('quit');
  });

  it('cancels quit intent even before a close event arrives', () => {
    const state = new WindowTransitionState();
    state.requestQuit();
    expect(state.resolve(false)).toBeUndefined();

    requestTransition(state, 'close');
    expect(state.resolve(true)).toBe('close');
  });

  it('reports an unsolicited approval in Chinese without preventing a later reload', () => {
    const state = new WindowTransitionState();
    expect(() => state.resolve(true)).toThrow(/[\u4e00-\u9fff]/);

    state.preventUnload();
    expect(state.resolve(true)).toBe('reload');
  });
});

describe('window confirmation input validation', () => {
  const malformed = [
    ['undefined', undefined], ['null', null], ['zero', 0], ['one', 1],
    ['true string', 'true'], ['false string', 'false'], ['empty string', ''],
    ['object', {}], ['array', []], ['boxed boolean', new Boolean(false)],
  ] as const;

  it.each(malformed)('rejects %s without consuming the pending operation or quit intent', (_name, value) => {
    const state = new WindowTransitionState();
    requestTransition(state, 'quit');

    expect(() => state.resolve(value)).toThrow();
    // A subsequent close event must still remember that this is an app quit.
    state.requestClose();
    expect(state.resolve(true)).toBe('quit');
  });

  it.each(operations)('preserves pending %s when malformed confirmation arrives', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);

    expect(() => state.resolve('false')).toThrow();
    expect(state.resolve(true)).toBe(operation);
  });
});

describe('window transition cleanup', () => {
  it.each(operations)('clears a blocked %s operation and rejects a stale approval', operation => {
    const state = new WindowTransitionState();
    requestTransition(state, operation);
    state.clear();

    expect(() => state.resolve(true)).toThrow();
    requestTransition(state, 'close');
    expect(state.resolve(true)).toBe('close');
  });

  it('clears quit intent when submission blocks closing before unload confirmation', () => {
    const state = new WindowTransitionState();
    state.requestQuit();
    state.clear();

    requestTransition(state, 'close');
    expect(state.resolve(true)).toBe('close');
  });

  it('can clear an already closed window repeatedly and later handle a fresh reload', () => {
    const state = new WindowTransitionState();
    state.clear();
    state.clear();

    requestTransition(state, 'reload');
    expect(state.resolve(true)).toBe('reload');
  });
});
