import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useState } from 'react';

import { generateTtsForFocusedRem } from '../lib/tts';
import '../style.css';

function TtsWidget(): JSX.Element {
  const plugin = usePlugin();
  const [busy, setBusy] = useState(false);

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      await generateTtsForFocusedRem(plugin);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="tts-button" type="button" disabled={busy} onClick={generate}>
      {busy ? 'Generating TTS audio…' : 'Generate TTS audio'}
    </button>
  );
}

renderWidget(TtsWidget);
