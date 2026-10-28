import type { WebUiClientBundle } from 'cortico/web/shared/client-panel.ts';
import { allowancePanel } from './allowance-panel.ts';

// The endpoint table and the four connection blocks are the framework's own; only the allowance section ships here.
export default { panels: { allowance: allowancePanel } } satisfies WebUiClientBundle;
