// Where the device messages go, relative to Hall's base URL (e.g. https://hall.farad.com.br).
// A reverse proxy in front of Hall must pass the path unchanged: it is part of the signature.
export const DEVICE_PATHS = {
  enrol: '/api/device/enrol',
  heartbeat: '/api/device/heartbeat',
  state: '/api/device/state',
  events: '/api/device/events',
} as const;

export type DevicePath = (typeof DEVICE_PATHS)[keyof typeof DEVICE_PATHS];
