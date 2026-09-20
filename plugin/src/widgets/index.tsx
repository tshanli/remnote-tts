import { declareIndexPlugin, type ReactRNPlugin, WidgetLocation } from '@remnote/plugin-sdk';

import '../style.css';
import {
  generatePronunciationForFocusedRem,
  registerPronunciationPowerup,
  registerPronunciationSettings,
} from '../lib/pronunciation';

async function onActivate(plugin: ReactRNPlugin): Promise<void> {
  await registerPronunciationPowerup(plugin);
  await registerPronunciationSettings(plugin);
  await plugin.app.registerCommand({
    id: 'generate-pronunciation-focused-rem',
    name: 'Generate Pronunciation for Focused Rem',
    action: () => generatePronunciationForFocusedRem(plugin),
  });
  await plugin.app.registerWidget('pronunciation_widget', WidgetLocation.RightSidebar, {
    dimensions: { height: 'auto', width: '100%' },
    widgetTabTitle: 'Pronunciation',
  });
}

async function onDeactivate(plugin: ReactRNPlugin): Promise<void> {
  await plugin.app.unregisterWidget('pronunciation_widget', WidgetLocation.RightSidebar);
}

declareIndexPlugin(onActivate, onDeactivate);
