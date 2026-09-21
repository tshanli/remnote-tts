import {
  AppEvents,
  BuiltInPowerupCodes,
  SetRemType,
  type PluginRem,
  type RNPlugin,
} from '@remnote/plugin-sdk';

const PRONUNCIATION_LABELS = ['Uitspraak', 'Pronunciation', '发音'] as const;
type PronunciationLabel = (typeof PRONUNCIATION_LABELS)[number];

const POWERUP_CODE = 'remnote_tts';
const SLOT_CODES = {
  status: 'status',
  hash: 'hash',
  language: 'language',
  voice: 'voice',
  url: 'url',
  generationKey: 'generation-key',
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
const PITCH = '+0Hz';
const AUTOMATIC_DEBOUNCE_MS = 500;

const processingRemIds = new Set<string>();
const inFlightRequests = new Map<string, Promise<PronunciationAudio>>();

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

interface PronunciationAudio {
  audioUrl: string;
  hash: string;
  language: string;
  voice: string;
}

interface PronunciationSource {
  rem: PluginRem;
  label: PronunciationLabel;
  text: string;
}

interface GenerationOptions {
  automatic?: boolean;
  force?: boolean;
  notify?: boolean;
}

export type GenerationResult = 'generated' | 'skipped' | 'ignored' | 'failed';

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
        {
          code: SLOT_CODES.generationKey,
          name: 'Generation Key',
          hidden: true,
          onlyProgrammaticModifying: true,
        },
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

function pronunciationLabelFromText(text: string): PronunciationLabel | undefined {
  return PRONUNCIATION_LABELS.find((label) => label === text);
}

async function pronunciationLabelFromRem(
  plugin: RNPlugin,
  rem: PluginRem,
): Promise<PronunciationLabel | undefined> {
  if (!rem.text) {
    return undefined;
  }

  const text = (await plugin.richText.toString(rem.text)).trim();
  return pronunciationLabelFromText(text);
}

async function getPronunciationSource(
  plugin: RNPlugin,
  remId: string,
): Promise<PronunciationSource | undefined> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    return undefined;
  }

  const label = await pronunciationLabelFromRem(plugin, rem);
  if (!label) {
    return undefined;
  }

  const parent = await rem.getParentRem();
  if (!parent?.text) {
    return undefined;
  }

  const text = (await plugin.richText.toString(parent.text)).trim();
  if (!text) {
    return undefined;
  }

  return { rem, label, text };
}

function buildGenerationKey(
  text: string,
  label: PronunciationLabel,
  settings: PronunciationSettings,
): string {
  return JSON.stringify({
    serverUrl: settings.serverUrl,
    text,
    label,
    rate: settings.rate,
    pitch: PITCH,
  });
}

async function getMetadata(rem: PluginRem, slotCode: string): Promise<string> {
  try {
    return (await rem.getPowerupProperty(POWERUP_CODE, slotCode)).trim();
  } catch {
    return '';
  }
}

async function needsRegeneration(
  rem: PluginRem,
  generationKey: string,
  force: boolean,
): Promise<boolean> {
  if (force) {
    return true;
  }

  const [storedGenerationKey, storedHash, storedUrl] = await Promise.all([
    getMetadata(rem, SLOT_CODES.generationKey),
    getMetadata(rem, SLOT_CODES.hash),
    getMetadata(rem, SLOT_CODES.url),
  ]);

  return (
    storedGenerationKey !== generationKey ||
    !storedHash ||
    !storedUrl
  );
}

async function requestPronunciation(
  settings: PronunciationSettings,
  text: string,
  label: PronunciationLabel,
): Promise<PronunciationAudio> {
  const requestKey = buildGenerationKey(text, label, settings);
  const existingRequest = inFlightRequests.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = requestPronunciationFromServer(settings, text, label);
  inFlightRequests.set(requestKey, request);

  try {
    return await request;
  } finally {
    if (inFlightRequests.get(requestKey) === request) {
      inFlightRequests.delete(requestKey);
    }
  }
}

async function requestPronunciationFromServer(
  settings: PronunciationSettings,
  text: string,
  label: PronunciationLabel,
): Promise<PronunciationAudio> {
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
      pitch: PITCH,
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
  generationKey: string,
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
  await setMetadata(plugin, pronunciationRem, SLOT_CODES.generationKey, generationKey);
}

export async function generatePronunciation(
  plugin: RNPlugin,
  remId: string,
  options: GenerationOptions = {},
): Promise<GenerationResult> {
  if (processingRemIds.has(remId)) {
    if (options.notify) {
      await plugin.app.toast('Pronunciation is already being generated.');
    }
    return 'skipped';
  }

  processingRemIds.add(remId);

  try {
    const source = await getPronunciationSource(plugin, remId);
    if (!source) {
      if (options.notify) {
        await plugin.app.toast('Focus Uitspraak, Pronunciation, or 发音 with a parent Rem.');
      }
      return 'ignored';
    }

    const settings = await getSettings(plugin);
    const generationKey = buildGenerationKey(source.text, source.label, settings);
    if (!(await needsRegeneration(source.rem, generationKey, options.force === true))) {
      return 'skipped';
    }

    const pronunciation = await requestPronunciation(settings, source.text, source.label);
    await plugin.app.transaction(() =>
      writePronunciation(
        plugin,
        source.rem,
        pronunciation.language,
        pronunciation.voice,
        pronunciation.audioUrl,
        pronunciation.hash,
        generationKey,
      ),
    );

    if (options.notify) {
      await plugin.app.toast(`Pronunciation added for “${source.text}”`);
    }
    return 'generated';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (options.automatic) {
      console.error(`[TTS] Automatic pronunciation failed for Rem ${remId}: ${message}`);
    } else if (options.notify) {
      await plugin.app.toast(`Pronunciation failed: ${message}`);
    }
    return 'failed';
  } finally {
    processingRemIds.delete(remId);
  }
}

export async function generatePronunciationForFocusedRem(plugin: RNPlugin): Promise<void> {
  const focusedRem = await plugin.focus.getFocusedRem();
  if (!focusedRem) {
    await plugin.app.toast('Focus a pronunciation label first.');
    return;
  }

  await generatePronunciation(plugin, focusedRem._id, {
    force: true,
    notify: true,
  });
}

function collectRemIds(value: unknown, ids: Set<string>): void {
  if (typeof value === 'string') {
    const remId = value.trim();
    if (remId) {
      ids.add(remId);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectRemIds(item, ids));
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['remId', 'remID', 'changedRemId', 'changedRemID', 'id', '_id']) {
    collectRemIds(record[key], ids);
  }
  for (const key of ['remIds', 'rem', 'changedRem', 'remObject', 'args']) {
    collectRemIds(record[key], ids);
  }
}

function remIdsFromEvent(event: unknown): string[] {
  const ids = new Set<string>();
  collectRemIds(event, ids);
  return [...ids];
}

async function getAutomaticCandidateIds(
  plugin: RNPlugin,
  changedRemIds: string[],
): Promise<Set<string>> {
  const candidateIds = new Set<string>();

  await Promise.all(
    changedRemIds.map(async (changedRemId) => {
      try {
        const changedRem = await plugin.rem.findOne(changedRemId);
        if (!changedRem) {
          return;
        }

        if (await isTtsPronunciationRem(plugin, changedRem)) {
          candidateIds.add(changedRem._id);
        }

        const children = await changedRem.getChildrenRem();
        await Promise.all(
          children.map(async (child) => {
            if (await isTtsPronunciationRem(plugin, child)) {
              candidateIds.add(child._id);
            }
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error(
          `[TTS] Could not inspect changed Rem ${changedRemId}: ${message}`,
        );
      }
    }),
  );

  return candidateIds;
}

async function isTtsPronunciationRem(
  plugin: RNPlugin,
  rem: PluginRem,
): Promise<boolean> {
  const label = await pronunciationLabelFromRem(plugin, rem);
  return label !== undefined && (await rem.hasPowerup(POWERUP_CODE));
}

export function registerAutomaticPronunciation(plugin: RNPlugin): () => void {
  let disposed = false;
  let flushInProgress = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingRemIds = new Set<string>();

  const scheduleFlush = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flushPendingChanges();
    }, AUTOMATIC_DEBOUNCE_MS);
  };

  const flushPendingChanges = async (): Promise<void> => {
    if (disposed || flushInProgress) {
      return;
    }

    flushInProgress = true;
    const changedRemIds = [...pendingRemIds];
    pendingRemIds.clear();

    try {
      const candidateIds = await getAutomaticCandidateIds(plugin, changedRemIds);
      if (!disposed) {
        await Promise.all(
          [...candidateIds].map((remId) =>
            generatePronunciation(plugin, remId, { automatic: true }),
          ),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[TTS] Automatic pronunciation batch failed: ${message}`);
    } finally {
      flushInProgress = false;
      if (!disposed && pendingRemIds.size > 0) {
        scheduleFlush();
      }
    }
  };

  const onGlobalRemChanged = (event: unknown): void => {
    if (disposed) {
      return;
    }

    const changedRemIds = remIdsFromEvent(event);
    if (changedRemIds.length === 0) {
      return;
    }

    changedRemIds.forEach((remId) => pendingRemIds.add(remId));
    scheduleFlush();
  };

  plugin.event.addListener(AppEvents.GlobalRemChanged, undefined, onGlobalRemChanged);

  return () => {
    disposed = true;
    pendingRemIds.clear();
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    plugin.event.removeListener(
      AppEvents.GlobalRemChanged,
      undefined,
      onGlobalRemChanged,
    );
  };
}
