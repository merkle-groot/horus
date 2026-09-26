import React from 'react';
import {ActivityIndicator, StyleSheet, Text, TextInput, View} from 'react-native';
import {AuthScreenLayout, authStyles} from './AuthScreenLayout';
import {uiColors} from './brand';
import {InteractivePressable as Pressable} from './InteractivePressable';
import {UI_FONT_FAMILY} from './typography';

export type OnboardingScreenProps = Readonly<{
  runtimeReady: boolean;
  onComplete: (password: string, onToolsReady: () => void) => Promise<void>;
  error?: string;
}>;

export function OnboardingScreen({runtimeReady, onComplete, error}: OnboardingScreenProps): React.JSX.Element {
  const [password, setPassword] = React.useState('');
  const [progressStage, setProgressStage] = React.useState<'provisioning' | 'saving-profile' | null>(null);
  const [validationError, setValidationError] = React.useState<string | undefined>();

  const submit = React.useCallback(async () => {
    if (password.length < 4) {
      setValidationError('Choose a password with at least 4 characters.');
      return;
    }
    setValidationError(undefined);
    setProgressStage('provisioning');
    try {
      await onComplete(password, () => setProgressStage('saving-profile'));
    } finally {
      setProgressStage(null);
    }
  }, [onComplete, password]);

  const isWorking = progressStage !== null;
  const progressTitle = progressStage === 'saving-profile'
    ? 'SAVING YOUR PROFILE'
    : 'PROVISIONING ALPINE WORKSPACE';
  const progressDetail = progressStage === 'saving-profile'
    ? 'Finishing your local sign-in setup…'
    : 'Installing CLI tools…';

  return (
    <AuthScreenLayout brandTestID="setup" screenTestID="onboarding-screen">
      <View style={authStyles.card}>
        <TextInput accessibilityLabel="Create password" autoCapitalize="none" autoCorrect={false} editable={!isWorking} onChangeText={setPassword} placeholder="Create password" placeholderTextColor={uiColors.subdued} secureTextEntry style={authStyles.input} testID="profile-password" value={password} />

        {validationError !== undefined ? <Text style={authStyles.error} testID="profile-error">{validationError}</Text> : null}
        {error !== undefined ? <Text style={authStyles.error} testID="profile-save-error">{error}</Text> : null}
        {isWorking ? (
          <View accessibilityLiveRegion="polite" style={styles.progress} testID="onboarding-progress">
            <ActivityIndicator color={uiColors.accent} size="small" />
            <View style={styles.progressCopy}>
              <Text style={styles.progressTitle} testID="onboarding-progress-title">{progressTitle}</Text>
              <Text style={styles.progressDetail} testID="onboarding-progress-detail">{progressDetail}</Text>
            </View>
          </View>
        ) : null}
        <Pressable accessibilityRole="button" disabled={!runtimeReady || isWorking} onPress={() => void submit()} style={[authStyles.button, (!runtimeReady || isWorking) && authStyles.disabled]} testID="profile-continue">
          <Text style={authStyles.buttonText}>{isWorking ? 'PLEASE WAIT…' : runtimeReady ? 'CONTINUE  →' : 'PREPARING…'}</Text>
        </Pressable>
      </View>
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  progress: {
    alignItems: 'center',
    backgroundColor: uiColors.background,
    borderColor: uiColors.borderSoft,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 12,
    marginTop: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  progressCopy: {flex: 1},
  progressTitle: {color: uiColors.accent, fontFamily: UI_FONT_FAMILY, fontSize: 10, fontWeight: '700', letterSpacing: 0.4},
  progressDetail: {color: uiColors.subdued, fontFamily: UI_FONT_FAMILY, fontSize: 10, lineHeight: 15, marginTop: 4},
});
