import { EventEmitter } from "node:events";

// Tiny in-process pub/sub. The server subscribes and pushes each task update
// to connected dashboard WebSockets.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emitUpdate(taskId: string) {
  bus.emit("update", taskId);
}
