import {
  BuiltInPowerupCodes,
  SetRemType,
  type PluginRem,
  type RNPlugin,
} from '@remnote/plugin-sdk';

const LABELS = {
  dutch: 'Uitspraak',
  english: 'Pronunciation',
  chinese: '发音',
} as const;

const POWERUP_CODE = 'remnote_tts';
const SLOT_CODES = {
  status: 'status',
  hash: 'hash',
  language: 'language',
  voice: 'voice',
  url: 'url',
} as const;

const SETTING_IDS = {
  serverUrl: 'server-url',
  bearerToken: 'bearer-token',
  rate: 'rate',
} as const;

const DEFAULTS = {
  serverUrl: 'http://localhost:8765',
  rate: '+0%',
} as const;

interface PronunciationResponse {
  audioUrl?: unknown;
  hash?: unknown;
  text?: unknown;
  language?: unknown;
  voice?: unknown;
}

interface PronunciationSettings {
  serverUrl: string;
  bearerToken: string;
  rate: string;
}

export async function registerPronunciationPowerup(plugin: RNPlugin): Promise<void> {
  await plugin.app.registerPowerup({
    name: 'TTS',
    code: POWERUP_CODE,
    description: 'Stores generated pronunciation metadata for the plugin.',
    options: {
      slots: [
        { code: SLOT_CODES.status, name: 'Status', hidden: true, onlyProgrammaticModifying: true },
        { code: SLOT_CODES.hash, name: 'Hash', hidden: true, onlyProgrammaticModifying: true },
        { code: SLOT_CODES.language, name: 'Language', hidden: true, onlyProgrammaticModifying: true },
        { code: SLOT_CODES.voice, name: 'Voice', hidden: true, onlyProgrammaticModifying: true },
        { code: SLOT_CODES.url, name: 'Generated URL', hidden: true, onlyProgrammaticModifying: true },
      ],
    },
  });
}

export async function registerPronunciationSettings(plugin: RNPlugin): Promise<void> {
  await plugin.settings.registerStringSetting({
    id: SETTING_IDS.serverUrl,
    title: 'Host',
    description: 'Base URL of the pronunciation server, for example http://localhost:8765.',
    defaultValue: DEFAULTS.serverUrl,
  });
  await plugin.settings.registerStringSetting({
    id: SETTING_IDS.bearerToken,
    title: 'Pronunciation server bearer token',
    description: 'Optional token sent to the pronunciation server.',
    defaultValue: '',
  });
  await plugin.settings.registerStringSetting({
    id: SETTING_IDS.rate,
    title: 'Pronunciation rate',
    defaultValue: DEFAULTS.rate,
  });
}

async function getSettings(plugin: RNPlugin): Promise<PronunciationSettings> {
  const getString = async (id: string, fallback: string): Promise<string> => {
    const value = await plugin.settings.getSetting<string>(id);
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  };

  return {
    serverUrl: (await getString(SETTING_IDS.serverUrl, DEFAULTS.serverUrl)).replace(/\/$/, ''),
    bearerToken: await getString(SETTING_IDS.bearerToken, ''),
    rate: await getString(SETTING_IDS.rate, DEFAULTS.rate),
  };
}

async function requestPronunciation(
  settings: PronunciationSettings,
  text: string,
  label: string,
): Promise<{ audioUrl: string; hash: string; language: string; voice: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.bearerToken) {
    headers.Authorization = `Bearer ${settings.bearerToken}`;
  }

  const response = await fetch(`${settings.serverUrl}/api/pronunciation`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text,
      label,
      rate: settings.rate,
      pitch: '+0Hz',
    }),
  });

  if (!response.ok) {
    throw new Error(`Pronunciation server returned HTTP ${response.status}`);
  }

  const result = (await response.json()) as PronunciationResponse;
  if (
    typeof result.audioUrl !== 'string' ||
    typeof result.hash !== 'string' ||
    typeof result.language !== 'string' ||
    typeof result.voice !== 'string'
  ) {
    throw new Error('Pronunciation server returned an invalid response');
  }

  return {
    audioUrl: result.audioUrl,
    hash: result.hash,
    language: result.language,
    voice: result.voice,
  };
}

async function setMetadata(
  plugin: RNPlugin,
  rem: PluginRem,
  name: string,
  value: string,
): Promise<void> {
  const richText = await plugin.richText.text(value).value();
  await rem.setPowerupProperty(POWERUP_CODE, name, richText);
}

async function writePronunciation(
  plugin: RNPlugin,
  pronunciationRem: PluginRem,
  language: string,
  voice: string,
  audioUrl: string,
  audioHash: string,
): Promise<void> {
  const audio = await plugin.richText.audio(audioUrl).value();
  await pronunciationRem.setBackText(audio);
  await pronunciationRem.setType(SetRemType.DESCRIPTOR);
  await pronunciationRem.addPowerup(BuiltInPowerupCodes.ExtraCardDetail);
  await pronunciationRem.setEnablePractice(false);
  await pronunciationRem.setPracticeDirection('none');
  await pronunciationRem.addPowerup(POWERUP_CODE);
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.status, 'complete');
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.hash, audioHash);
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.language, language);
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.voice, voice);
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.url, audioUrl);
}

export async function generatePronunciationForFocusedRem(plugin: RNPlugin): Promise<void> {
  try {
    const focusedRem = await plugin.focus.getFocusedRem();
    if (!focusedRem?.text) {
      throw new Error('Focus a pronunciation label first');
    }

    const focusedLabel = (await plugin.richText.toString(focusedRem.text)).trim();
    const labelName = Object.values(LABELS).find(
      (label) => label.toLocaleLowerCase() === focusedLabel.toLocaleLowerCase(),
    );
    if (!labelName) {
      throw new Error('Focus Uitspraak, Pronunciation, or 发音');
    }

    const parent = await focusedRem.getParentRem();
    const text = parent?.text ? (await plugin.richText.toString(parent.text)).trim() : '';
    if (!text) {
      throw new Error('The pronunciation label must have a parent Rem');
    }

    const settings = await getSettings(plugin);
    const pronunciation = await requestPronunciation(settings, text, labelName);
    await plugin.app.transaction(() =>
      writePronunciation(
        plugin,
        focusedRem,
        pronunciation.language,
        pronunciation.voice,
        pronunciation.audioUrl,
        pronunciation.hash,
      ),
    );
    await plugin.app.toast(`Pronunciation added for “${text}”`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await plugin.app.toast(`Pronunciation failed: ${message}`);
  }
}
