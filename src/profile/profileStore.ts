import {NativeModules} from 'react-native';

export type UserProfile = Readonly<{
  hasPassword: boolean;
}>;

type NativeProfileModule = Readonly<{
  getProfile: () => Promise<unknown>;
  saveProfile: (request: {password: string}) => Promise<unknown>;
  verifyPassword: (request: {password: string}) => Promise<unknown>;
}>;

function nativeProfileModule(): NativeProfileModule | null {
  const module = NativeModules.HorusDevice as NativeProfileModule | undefined;
  return module === undefined ? null : module;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is UserProfile {
  return (
    isRecord(value) &&
    value.configured === true &&
    typeof value.hasPassword === 'boolean'
  );
}

export async function readUserProfile(): Promise<UserProfile | null> {
  const module = nativeProfileModule();
  if (module === null) return null;
  try {
    const response = await module.getProfile();
    return isProfile(response) ? response : null;
  } catch {
    return null;
  }
}

export async function saveUserProfile(password: string): Promise<boolean> {
  if (password.length < 4 || password.length > 128) {
    return false;
  }
  const module = nativeProfileModule();
  if (module === null) return false;
  try {
    const response = await module.saveProfile({password});
    return isRecord(response) && response.status === 'success';
  } catch {
    return false;
  }
}

export async function verifyUserPassword(password: string): Promise<boolean> {
  if (password.length < 4 || password.length > 128) return false;
  const module = nativeProfileModule();
  if (module === null) return false;
  try {
    const response = await module.verifyPassword({password});
    return isRecord(response) && response.status === 'success';
  } catch {
    return false;
  }
}
