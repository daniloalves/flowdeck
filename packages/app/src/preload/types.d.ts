import type { FlowDeckBridge } from '@flowdeck/shared';

declare global {
  interface Window {
    flowdeck: FlowDeckBridge;
  }
}

export {};
