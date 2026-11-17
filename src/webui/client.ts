import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import { modelPanel } from './model-panel.ts';
import { allowancePanel } from './allowance-panel.ts';
import './style.css';

// Endpoint/model editing stays with the host; this bundle owns allowance and model input/pricing panels.
export default { panels: { allowance: allowancePanel, 'model-settings': modelPanel } } satisfies WebUiClientBundle;
