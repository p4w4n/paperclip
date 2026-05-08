import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";
import { withSyncSpan, PaperclipAttr } from "../observability/spans.js";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  return withSyncSpan(
    "paperclip.live_events.publish",
    () => {
      const event = toLiveEvent(input);
      emitter.emit(input.companyId, event);
      return event;
    },
    {
      [PaperclipAttr.CompanyId]: input.companyId,
      [PaperclipAttr.EventType]: input.type,
      "paperclip.live_events.subscriber_count": emitter.listenerCount(input.companyId),
    },
  );
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  return withSyncSpan(
    "paperclip.live_events.publish_global",
    () => {
      const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
      emitter.emit("*", event);
      return event;
    },
    {
      [PaperclipAttr.EventType]: input.type,
      "paperclip.live_events.subscriber_count": emitter.listenerCount("*"),
    },
  );
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}
