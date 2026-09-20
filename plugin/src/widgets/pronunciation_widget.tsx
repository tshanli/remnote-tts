import { renderWidget, usePlugin } from '@remnote/plugin-sdk';
import { useState } from 'react';

import { generatePronunciationForFocusedRem } from '../lib/pronunciation';
import '../style.css';

function PronunciationWidget(): JSX.Element {
  const plugin = usePlugin();
  const [busy, setBusy] = useState(false);

  const generate = async (): Promise<void> => {
    setBusy(true);
    try {
      await generatePronunciationForFocusedRem(plugin);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button className="pronunciation-button" type="button" disabled={busy} onClick={generate}>
      {busy ? 'Generating pronunciation…' : 'Generate pronunciation'}
    </button>
  );
}

renderWidget(PronunciationWidget);
