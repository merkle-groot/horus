import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {OnboardingScreen} from '../src/ui/OnboardingScreen';

describe('OnboardingScreen', () => {
  test('shows the Horus sign-in-style setup and still creates the profile', async () => {
    const onComplete = jest.fn(async (_password: string) => undefined);
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <OnboardingScreen onComplete={onComplete} runtimeReady />,
      );
    });

    expect(renderer?.root.findByProps({testID: 'setup-logo'}).props.style).toMatchObject({height: 112, width: 112});
    expect(renderer?.root.findByProps({testID: 'setup-wordmark'}).props.children).toBe('HORUS');
    expect(renderer?.root.findByProps({testID: 'profile-password'}).props.placeholder).toBe('Create password');
    expect(renderer?.root.findByProps({testID: 'profile-continue'})).toBeDefined();
    for (const removedCopy of ['HORUS / ALPINE', 'FIRST RUN', '01 / LOCAL PROFILE', 'Set a local password.', 'PASSWORD']) {
      expect(renderer?.root.findAll(node => node.props.children === removedCopy)).toHaveLength(0);
    }

    await ReactTestRenderer.act(async () => {
      renderer?.root.findByProps({testID: 'profile-password'}).props.onChangeText('correct horse');
    });
    await ReactTestRenderer.act(async () => {
      renderer?.root.findByProps({testID: 'profile-continue'}).props.onPress();
      await Promise.resolve();
    });
    expect(onComplete).toHaveBeenCalledWith('correct horse', expect.any(Function));

    await ReactTestRenderer.act(async () => { renderer?.unmount(); });
  });
});
