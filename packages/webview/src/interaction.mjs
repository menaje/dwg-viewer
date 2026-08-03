import { DetailStreamer } from "./detail-streamer.mjs";
import {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  ViewportInteraction as CoreViewportInteraction,
  WHEEL_ZOOM_RATE,
} from "../../viewer-core/src/viewport-interaction.mjs";

function createDetailStreamer(...arguments_) {
  return new DetailStreamer(...arguments_);
}

export class ViewportInteraction extends CoreViewportInteraction {
  constructor(scene, canvas, options = {}) {
    super(scene, canvas, {
      ...options,
      createDetailStreamer,
    });
  }
}

export {
  DETAIL_DEBOUNCE_MS,
  DETAIL_ZOOM_THRESHOLD,
  VIEW_COMMIT_DEBOUNCE_MS,
  WHEEL_ZOOM_RATE,
};
