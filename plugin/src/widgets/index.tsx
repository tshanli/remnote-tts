import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';

import '../style.css';
import {
  generateTtsForFocusedRem,
  registerAutomaticTts,
  registerTtsPowerup,
  registerTtsSettings,
} from '../lib/tts';

let stopAutomaticTts: (() => void) | undefined;

async function onActivate(plugin: ReactRNPlugin): Promise<void> {
  await registerTtsPowerup(plugin);
  await registerTtsSettings(plugin);
  stopAutomaticTts?.();
  stopAutomaticTts = registerAutomaticTts(plugin);
  await plugin.app.registerCommand({
    id: 'generate-tts-focused-rem',
    name: 'Generate TTS Audio for Focused Rem',
    action: () => generateTtsForFocusedRem(plugin),
  });
  await plugin.app.registerWidget('tts_widget', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
    widgetTabTitle: 'TTS',
  });
}

async function onDeactivate(plugin: ReactRNPlugin): Promise<void> {
  stopAutomaticTts?.();
  stopAutomaticTts = undefined;
  await plugin.app.unregisterWidget('tts_widget', WidgetLocation.RightSidebar);
}

declareIndexPlugin(onActivate, onDeactivate);
