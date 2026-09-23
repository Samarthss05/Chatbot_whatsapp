import { enqueue } from "./store.js";
import { textPayload, listPayload, buttonsPayload } from "./whatsapp.js";
export function queuePayload(
  wa,
  payload,
  {
    automated = true,
    bookingId = null,
    bookingStatus = null,
    allowOptOut = false,
  } = {},
) {
  enqueue("wa", "wa:" + wa, {
    waId: wa,
    payload,
    automated,
    bookingId,
    bookingStatus,
    allowOptOut,
  });
}
export const say = (wa, body, options) =>
  queuePayload(wa, textPayload(wa, body), options);
export const list = (wa, options) => queuePayload(wa, listPayload(wa, options));
export const buttons = (wa, body, items) =>
  queuePayload(wa, buttonsPayload(wa, body, items));
