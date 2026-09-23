import {
  AppEvents,
  BuiltInPowerupCodes,
  type PluginRem,
  type RNPlugin,
  SetRemType,
} from "@remnote/plugin-sdk";

const POWERUP_CODE = "remnote_tts";
const SLOT_CODES = {
  status: "status",
  hash: "hash",
  language: "language",
  voice: "voice",
  url: "url",
  generationKey: "generation-key",
} as const;

const SETTING_IDS = {
  serverUrl: "server-url",
  bearerToken: "bearer-token",
} as const;

const DEFAULTS = {
  serverUrl: "http://localhost:8765",
} as const;
const AUTOMATIC_DEBOUNCE_MS = 500;

const processingRemIds = new Set<string>();
const inFlightRequests = new Map<string, Promise<TtsAudio>>();

interface TtsResponse {
  audioUrl?: unknown;
  hash?: unknown;
  text?: unknown;
  language?: unknown;
  voice?: unknown;
}

interface TtsSettings {
  serverUrl: string;
  bearerToken: string;
}

interface TtsAudio {
  audioUrl: string;
  hash: string;
  language: string;
  voice: string;
}

interface TtsSource {
  rem: PluginRem;
  label: string;
  text: string;
}

type TtsSourceIssue =
  | "missing-rem"
  | "missing-powerup"
  | "missing-label"
  | "missing-parent"
  | "empty-parent";

interface TtsSourceResult {
  source?: TtsSource;
  issue?: TtsSourceIssue;
}

interface GenerationOptions {
  automatic?: boolean;
  checkServer?: boolean;
  force?: boolean;
  notify?: boolean;
}

const TTS_SOURCE_MESSAGES: Record<TtsSourceIssue, string> = {
  "missing-rem": "The selected Rem does not exist.",
  "missing-powerup": "The selected Rem does not have the TTS PowerUp.",
  "missing-label": "The selected Rem has no text.",
  "missing-parent": "The selected Rem has no direct parent Rem.",
  "empty-parent": "The direct parent Rem has no text.",
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return "TTS operation failed without an error message.";
}

export type TtsGenerationResult =
  "generated" | "skipped" | "ignored" | "failed";

export async function registerTtsPowerup(plugin: RNPlugin): Promise<void> {
  await plugin.app.registerPowerup({
    name: "TTS",
    code: POWERUP_CODE,
    description: "Stores generated TTS audio metadata for the Rem.",
    options: {
      slots: [
        {
          code: SLOT_CODES.status,
          name: "Status",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
        {
          code: SLOT_CODES.hash,
          name: "Hash",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
        {
          code: SLOT_CODES.language,
          name: "Language",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
        {
          code: SLOT_CODES.voice,
          name: "Voice",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
        {
          code: SLOT_CODES.url,
          name: "Generated URL",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
        {
          code: SLOT_CODES.generationKey,
          name: "Generation Key",
          hidden: true,
          onlyProgrammaticModifying: true,
        },
      ],
    },
  });
}

export async function registerTtsSettings(plugin: RNPlugin): Promise<void> {
  await plugin.settings.registerStringSetting({
    id: SETTING_IDS.serverUrl,
    title: "Host",
    description:
      "Base URL of the TTS server, for example http://localhost:8765.",
    defaultValue: DEFAULTS.serverUrl,
  });
  await plugin.settings.registerStringSetting({
    id: SETTING_IDS.bearerToken,
    title: "TTS server bearer token",
    description: "Optional bearer token sent to the TTS server.",
    defaultValue: "",
  });
}

async function getSettings(plugin: RNPlugin): Promise<TtsSettings> {
  const getString = async (id: string, fallback: string): Promise<string> => {
    const value = await plugin.settings.getSetting<string>(id);
    return typeof value === "string" && value.trim() ? value.trim() : fallback;
  };

  return {
    serverUrl: (
      await getString(SETTING_IDS.serverUrl, DEFAULTS.serverUrl)
    ).replace(/\/$/, ""),
    bearerToken: await getString(SETTING_IDS.bearerToken, ""),
  };
}

async function getTtsSource(
  plugin: RNPlugin,
  remId: string,
): Promise<TtsSourceResult> {
  const rem = await plugin.rem.findOne(remId);
  if (!rem) {
    return { issue: "missing-rem" };
  }

  if (!(await rem.hasPowerup(POWERUP_CODE))) {
    return { issue: "missing-powerup" };
  }

  const label = rem.text
    ? (await plugin.richText.toString(rem.text)).trim()
    : "";
  if (!label) {
    return { issue: "missing-label" };
  }

  const parent = await rem.getParentRem();
  if (!parent) {
    return { issue: "missing-parent" };
  }
  if (!parent.text) {
    return { issue: "empty-parent" };
  }

  const text = (await plugin.richText.toString(parent.text)).trim();
  if (!text) {
    return { issue: "empty-parent" };
  }

  return { source: { rem, label, text } };
}

function buildGenerationKey(
  text: string,
  label: string,
  settings: TtsSettings,
): string {
  return JSON.stringify({
    serverUrl: settings.serverUrl,
    text,
    label,
  });
}

async function getMetadata(rem: PluginRem, slotCode: string): Promise<string> {
  try {
    return (await rem.getPowerupProperty(POWERUP_CODE, slotCode)).trim();
  } catch {
    return "";
  }
}

async function getStoredAudio(rem: PluginRem): Promise<{
  generationKey: string;
  hash: string;
  url: string;
}> {
  const [generationKey, hash, url] = await Promise.all([
    getMetadata(rem, SLOT_CODES.generationKey),
    getMetadata(rem, SLOT_CODES.hash),
    getMetadata(rem, SLOT_CODES.url),
  ]);

  return { generationKey, hash, url };
}

async function requestTts(
  settings: TtsSettings,
  text: string,
  label: string,
): Promise<TtsAudio> {
  const requestKey = buildGenerationKey(text, label, settings);
  const existingRequest = inFlightRequests.get(requestKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = requestTtsFromServer(settings, text, label);
  inFlightRequests.set(requestKey, request);

  try {
    return await request;
  } finally {
    if (inFlightRequests.get(requestKey) === request) {
      inFlightRequests.delete(requestKey);
    }
  }
}

async function requestTtsFromServer(
  settings: TtsSettings,
  text: string,
  label: string,
): Promise<TtsAudio> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.bearerToken) {
    headers.Authorization = `Bearer ${settings.bearerToken}`;
  }

  const endpoint = `${settings.serverUrl}/api/tts`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      label,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorResult = (await response.json()) as { detail?: unknown };
      if (typeof errorResult.detail === "string" && errorResult.detail.trim()) {
        detail = `: ${errorResult.detail.trim()}`;
      }
    } catch {
      detail = "";
    }
    throw new Error(
      `TTS server request to ${endpoint} failed with HTTP ${response.status}${detail}.`,
    );
  }

  const result = (await response.json()) as TtsResponse;
  if (
    typeof result.audioUrl !== "string" ||
    typeof result.hash !== "string" ||
    typeof result.language !== "string" ||
    typeof result.voice !== "string"
  ) {
    throw new Error(
      "TTS server returned invalid audio data: audioUrl, hash, language, or voice is missing.",
    );
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

async function writeTts(
  plugin: RNPlugin,
  ttsRem: PluginRem,
  language: string,
  voice: string,
  audioUrl: string,
  audioHash: string,
  generationKey: string,
): Promise<void> {
  const audio = await plugin.richText.audio(audioUrl).value();
  await ttsRem.setBackText(audio);
  await ttsRem.setType(SetRemType.DESCRIPTOR);
  await ttsRem.addPowerup(BuiltInPowerupCodes.ExtraCardDetail);
  await ttsRem.setEnablePractice(false);
  await ttsRem.setPracticeDirection("none");
  await ttsRem.addPowerup(POWERUP_CODE);
  await setMetadata(plugin, ttsRem, SLOT_CODES.status, "complete");
  await setMetadata(plugin, ttsRem, SLOT_CODES.hash, audioHash);
  await setMetadata(plugin, ttsRem, SLOT_CODES.language, language);
  await setMetadata(plugin, ttsRem, SLOT_CODES.voice, voice);
  await setMetadata(plugin, ttsRem, SLOT_CODES.url, audioUrl);
  await setMetadata(plugin, ttsRem, SLOT_CODES.generationKey, generationKey);
}

export async function generateTts(
  plugin: RNPlugin,
  remId: string,
  options: GenerationOptions = {},
): Promise<TtsGenerationResult> {
  if (processingRemIds.has(remId)) {
    if (options.notify) {
      await plugin.app.toast("TTS generation is already running for this Rem.");
    }
    return "skipped";
  }

  processingRemIds.add(remId);
  let sourceText = "the selected Rem";

  try {
    const sourceResult = await getTtsSource(plugin, remId);
    if (!sourceResult.source) {
      if (options.notify || options.automatic) {
        const issue = sourceResult.issue ?? "missing-rem";
        await plugin.app.toast(
          `Cannot generate TTS audio: ${TTS_SOURCE_MESSAGES[issue]}`,
        );
      }
      return "ignored";
    }
    const source = sourceResult.source;
    sourceText = source.text;

    const settings = await getSettings(plugin);
    const generationKey = buildGenerationKey(
      source.text,
      source.label,
      settings,
    );
    const storedAudio = await getStoredAudio(source.rem);
    const localAudioIsCurrent =
      storedAudio.generationKey === generationKey &&
      Boolean(storedAudio.hash) &&
      Boolean(storedAudio.url);
    if (localAudioIsCurrent && !options.force && !options.checkServer) {
      return "skipped";
    }

    const tts = await requestTts(settings, source.text, source.label);
    if (
      localAudioIsCurrent &&
      !options.force &&
      storedAudio.hash === tts.hash &&
      storedAudio.url === tts.audioUrl
    ) {
      return "skipped";
    }

    await plugin.app.transaction(() =>
      writeTts(
        plugin,
        source.rem,
        tts.language,
        tts.voice,
        tts.audioUrl,
        tts.hash,
        generationKey,
      ),
    );

    if (options.notify) {
      await plugin.app.toast(`TTS audio added for “${source.text}”.`);
    }
    return "generated";
  } catch (error) {
    const message = getErrorMessage(error);
    if (options.automatic) {
      console.error(
        `[TTS] Automatic generation failed for Rem ${remId}: ${message}`,
      );
      await plugin.app.toast(
        `TTS generation failed for “${sourceText}”: ${message}`,
      );
    } else if (options.notify) {
      await plugin.app.toast(
        `TTS generation failed for “${sourceText}”: ${message}`,
      );
    }
    return "failed";
  } finally {
    processingRemIds.delete(remId);
  }
}

export async function generateTtsForFocusedRem(
  plugin: RNPlugin,
): Promise<void> {
  const focusedRem = await plugin.focus.getFocusedRem();
  if (!focusedRem) {
    await plugin.app.toast(
      "No Rem is focused. Focus a Rem with the TTS PowerUp, then run the TTS command.",
    );
    return;
  }

  await generateTts(plugin, focusedRem._id, {
    force: true,
    notify: true,
  });
}

function collectRemIds(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    const remId = value.trim();
    if (remId) {
      ids.add(remId);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectRemIds(item, ids);
    });
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of [
    "remId",
    "remID",
    "changedRemId",
    "changedRemID",
    "id",
    "_id",
  ]) {
    collectRemIds(record[key], ids);
  }
  for (const key of ["remIds", "rem", "changedRem", "remObject", "args"]) {
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

        if (await isTtsRem(changedRem)) {
          candidateIds.add(changedRem._id);
        }

        const children = await changedRem.getChildrenRem();
        await Promise.all(
          children.map(async (child) => {
            if (await isTtsRem(child)) {
              candidateIds.add(child._id);
            }
          }),
        );
      } catch (error) {
        const message = getErrorMessage(error);
        console.error(
          `[TTS] Could not inspect changed Rem ${changedRemId}: ${message}`,
        );
      }
    }),
  );

  return candidateIds;
}

async function isTtsRem(rem: PluginRem): Promise<boolean> {
  return rem.hasPowerup(POWERUP_CODE);
}

export function registerAutomaticTts(plugin: RNPlugin): () => void {
  let disposed = false;
  let flushInProgress = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingRemIds = new Set<string>();
  const trackedTtsRemIds = new Set<string>();
  const parentByTtsRemId = new Map<string, string>();
  const ttsRemListeners = new Map<string, (event: unknown) => void>();
  const parentRemListeners = new Map<string, (event: unknown) => void>();
  const ttsRemIdsByParentId = new Map<string, Set<string>>();

  const scheduleFlush = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void flushPendingChanges();
    }, AUTOMATIC_DEBOUNCE_MS);
  };

  const enqueueRemId = (remId: string): void => {
    const normalizedRemId = remId.trim();
    if (!normalizedRemId) {
      return;
    }

    pendingRemIds.add(normalizedRemId);
    scheduleFlush();
  };

  const untrackTtsRem = (remId: string): void => {
    trackedTtsRemIds.delete(remId);

    const ttsRemListener = ttsRemListeners.get(remId);
    if (ttsRemListener) {
      plugin.event.removeListener(AppEvents.RemChanged, remId, ttsRemListener);
      ttsRemListeners.delete(remId);
    }

    const parentId = parentByTtsRemId.get(remId);
    if (!parentId) {
      return;
    }

    parentByTtsRemId.delete(remId);
    const ttsRemIds = ttsRemIdsByParentId.get(parentId);
    ttsRemIds?.delete(remId);
    if (ttsRemIds && ttsRemIds.size > 0) {
      return;
    }

    ttsRemIdsByParentId.delete(parentId);
    const parentRemListener = parentRemListeners.get(parentId);
    if (parentRemListener) {
      plugin.event.removeListener(
        AppEvents.RemChanged,
        parentId,
        parentRemListener,
      );
      parentRemListeners.delete(parentId);
    }
  };

  const trackTtsRem = async (remId: string): Promise<void> => {
    try {
      const rem = await plugin.rem.findOne(remId);
      if (!rem || !(await isTtsRem(rem))) {
        untrackTtsRem(remId);
        return;
      }

      if (!trackedTtsRemIds.has(remId)) {
        const ttsRemListener = (): void => {
          enqueueRemId(remId);
        };
        trackedTtsRemIds.add(remId);
        ttsRemListeners.set(remId, ttsRemListener);
        plugin.event.addListener(AppEvents.RemChanged, remId, ttsRemListener);
      }

      const parent = await rem.getParentRem();
      const parentId = parent?._id;
      const previousParentId = parentByTtsRemId.get(remId);
      if (previousParentId === parentId) {
        return;
      }

      if (previousParentId) {
        const previousTtsRemIds = ttsRemIdsByParentId.get(previousParentId);
        previousTtsRemIds?.delete(remId);
        if (previousTtsRemIds && previousTtsRemIds.size === 0) {
          ttsRemIdsByParentId.delete(previousParentId);
          const previousParentListener = parentRemListeners.get(previousParentId);
          if (previousParentListener) {
            plugin.event.removeListener(
              AppEvents.RemChanged,
              previousParentId,
              previousParentListener,
            );
            parentRemListeners.delete(previousParentId);
          }
        }
      }

      if (!parentId) {
        parentByTtsRemId.delete(remId);
        return;
      }

      parentByTtsRemId.set(remId, parentId);
      let ttsRemIds = ttsRemIdsByParentId.get(parentId);
      if (!ttsRemIds) {
        ttsRemIds = new Set<string>();
        ttsRemIdsByParentId.set(parentId, ttsRemIds);
      }
      ttsRemIds.add(remId);

      if (!parentRemListeners.has(parentId)) {
        const parentRemListener = (): void => {
          const childIds = ttsRemIdsByParentId.get(parentId);
          if (!childIds) {
            return;
          }

          for (const childId of childIds) {
            enqueueRemId(childId);
          }
        };
        parentRemListeners.set(parentId, parentRemListener);
        plugin.event.addListener(
          AppEvents.RemChanged,
          parentId,
          parentRemListener,
        );
      }
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(`[TTS] Could not track Rem ${remId}: ${message}`);
    }
  };

  const inspectFocusedRem = async (): Promise<void> => {
    if (disposed) {
      return;
    }

    try {
      const focusedRem = await plugin.focus.getFocusedRem();
      if (!focusedRem) {
        return;
      }

      const candidateIds = await getAutomaticCandidateIds(plugin, [
        focusedRem._id,
      ]);
      await Promise.all(
        [...candidateIds].map(async (remId) => {
          await trackTtsRem(remId);
          enqueueRemId(remId);
        }),
      );
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(`[TTS] Could not inspect the focused Rem: ${message}`);
    }
  };

  const flushPendingChanges = async (): Promise<void> => {
    if (disposed || flushInProgress) {
      return;
    }

    flushInProgress = true;
    const changedRemIds = [...pendingRemIds];
    pendingRemIds.clear();

    try {
      const candidateIds = await getAutomaticCandidateIds(
        plugin,
        changedRemIds,
      );
      if (!disposed) {
        await Promise.all(
          [...candidateIds].map((remId) => trackTtsRem(remId)),
        );
        await Promise.all(
          [...candidateIds].map((remId) =>
            generateTts(plugin, remId, { automatic: true, checkServer: true }),
          ),
        );
      }
    } catch (error) {
      const message = getErrorMessage(error);
      console.error(`[TTS] Automatic generation batch failed: ${message}`);
    } finally {
      flushInProgress = false;
      if (!disposed && pendingRemIds.size > 0) {
        scheduleFlush();
      }
    }
  };

  const onPotentialRemChange = (event: unknown): void => {
    if (disposed) {
      return;
    }

    const changedRemIds = remIdsFromEvent(event);
    for (const remId of changedRemIds) {
      enqueueRemId(remId);
    }

    if (changedRemIds.length === 0) {
      void inspectFocusedRem();
    }
  };

  plugin.event.addListener(
    AppEvents.GlobalRemChanged,
    undefined,
    onPotentialRemChange,
  );
  plugin.event.addListener(
    AppEvents.PowerupSlotChanged,
    undefined,
    onPotentialRemChange,
  );
  plugin.event.addListener(
    AppEvents.EditorTextEdited,
    undefined,
    onPotentialRemChange,
  );
  plugin.event.addListener(
    AppEvents.FocusedRemChange,
    undefined,
    onPotentialRemChange,
  );
  void inspectFocusedRem();

  return () => {
    disposed = true;
    pendingRemIds.clear();
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    for (const [remId, listener] of ttsRemListeners) {
      plugin.event.removeListener(AppEvents.RemChanged, remId, listener);
    }
    for (const [parentId, listener] of parentRemListeners) {
      plugin.event.removeListener(AppEvents.RemChanged, parentId, listener);
    }
    trackedTtsRemIds.clear();
    parentByTtsRemId.clear();
    ttsRemListeners.clear();
    parentRemListeners.clear();
    ttsRemIdsByParentId.clear();
    plugin.event.removeListener(
      AppEvents.GlobalRemChanged,
      undefined,
      onPotentialRemChange,
    );
    plugin.event.removeListener(
      AppEvents.PowerupSlotChanged,
      undefined,
      onPotentialRemChange,
    );
    plugin.event.removeListener(
      AppEvents.EditorTextEdited,
      undefined,
      onPotentialRemChange,
    );
    plugin.event.removeListener(
      AppEvents.FocusedRemChange,
      undefined,
      onPotentialRemChange,
    );
  };
}
